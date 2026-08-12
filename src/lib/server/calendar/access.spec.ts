import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	calendarGrantFor,
	calendarGrantFrom,
	MAX_CALENDAR_HORIZON_DAYS,
	type CalendarGrant
} from './access';

/**
 * The tier → detail/horizon seam.
 *
 * Everything beneath this file is correct for whatever pair it is given, so
 * this is the place where a viewer could be handed a more generous variant
 * than their tier allows. The tests are therefore written the same way the
 * code is: one case per way a `tier` row can be wrong, each asserting the same
 * answer — `null`, meaning no calendar at all.
 *
 * The seeded rows in `drizzle/0000_tier.sql` are marked AUTHORITATIVE in plan
 * §3, so they are asserted here by value rather than described in prose.
 */

/**
 * What each tier must end up with. Read against the migration rather than
 * beside it: this map is the intent, `drizzle/0000_tier.sql` is the data, and
 * a drift between them would move a real person to a different detail level.
 */
const EXPECTED: Record<string, CalendarGrant | null> = {
	public: null,
	friend: { detail: 'busy', horizonDays: 30 },
	family: { detail: 'titles', horizonDays: 90 },
	partner: { detail: 'full', horizonDays: 365 },
	owner: { detail: 'full', horizonDays: 365 }
};

/** The `calendar_detail` / `calendar_horizon_days` columns as seeded. */
function seededCalendarColumns(): Record<string, { detail: string; horizonDays: number }> {
	const sql = readFileSync('drizzle/0000_tier.sql', 'utf8');
	const rows = sql.matchAll(/\(\s*'(\w+)'\s*,\s*'[^']*'\s*,\s*\d+\s*,\s*'(\w+)'\s*,\s*(\d+)\s*,/g);

	return Object.fromEntries(
		[...rows].map(([, slug, detail, horizonDays]) => [slug, { detail, horizonDays: +horizonDays }])
	);
}

describe('calendarGrantFrom', () => {
	it('maps every seeded tier row to the calendar plan §4 gives it', () => {
		const seeded = seededCalendarColumns();

		expect(Object.keys(seeded).sort()).toEqual(Object.keys(EXPECTED).sort());

		for (const [slug, { detail, horizonDays }] of Object.entries(seeded)) {
			expect(calendarGrantFrom(detail, horizonDays), slug).toEqual(EXPECTED[slug]);
		}
	});

	/**
	 * `none` is the public tier's setting and the reason the page 403s rather
	 * than rendering an empty week. An empty week reads as "he is free".
	 */
	it('refuses a detail level of none whatever the horizon', () => {
		for (const horizonDays of [0, 30, 365]) {
			expect(calendarGrantFrom('none', horizonDays)).toBeNull();
		}
	});

	it('refuses a detail level this codebase cannot interpret', () => {
		// A level added to the CHECK constraint but not to `redact.ts`, a typo,
		// a NULL column, and a value shaped like something else entirely.
		for (const detail of ['Full', 'FULL', 'titles ', 'everything', '', null, undefined, 7, {}]) {
			expect(calendarGrantFrom(detail, 30), String(detail)).toBeNull();
		}
	});

	it('refuses a horizon that is not a positive whole number of days', () => {
		for (const horizonDays of [0, -1, -365, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(calendarGrantFrom('busy', horizonDays), String(horizonDays)).toBeNull();
		}
	});

	it('refuses a horizon that is not a number at all', () => {
		for (const horizonDays of [null, undefined, '30', '', {}, []]) {
			expect(calendarGrantFrom('busy', horizonDays), String(horizonDays)).toBeNull();
		}
	});

	/**
	 * A hand-edited row asking for five years is a typo, not a longer
	 * calendar. Refusing rather than clamping keeps one rule — unexpected
	 * value, no calendar — instead of two.
	 */
	it('refuses a horizon past the longest one the plan describes', () => {
		expect(calendarGrantFrom('full', MAX_CALENDAR_HORIZON_DAYS)).toEqual({
			detail: 'full',
			horizonDays: MAX_CALENDAR_HORIZON_DAYS
		});
		expect(calendarGrantFrom('full', MAX_CALENDAR_HORIZON_DAYS + 1)).toBeNull();
		expect(calendarGrantFrom('full', 3650)).toBeNull();
	});

	/** No pair of inputs may produce more than the row literally says. */
	it('never widens a detail level or a horizon', () => {
		const grant = calendarGrantFrom('busy', 30);

		expect(grant).toEqual({ detail: 'busy', horizonDays: 30 });
		expect(grant?.detail).not.toBe('full');
		expect(grant?.horizonDays).toBeLessThanOrEqual(30);
	});
});

/**
 * A D1 stand-in at the level drizzle actually calls: `prepare().bind().raw()`
 * for a select with a field list. `rows` are column-ordered as the select
 * lists them — `detail`, then `horizonDays`.
 */
function fakeD1(rows: unknown[][]): D1Database {
	return {
		prepare: () => ({
			bind: () => ({ raw: async () => rows })
		})
	} as unknown as D1Database;
}

function platformWith(db: D1Database): App.Platform {
	return { env: { DB: db } } as unknown as App.Platform;
}

describe('calendarGrantFor', () => {
	it('reads the tier row and maps it', async () => {
		const platform = platformWith(fakeD1([['titles', 90]]));

		await expect(calendarGrantFor(platform, 'family')).resolves.toEqual({
			detail: 'titles',
			horizonDays: 90
		});
	});

	it('refuses a viewer with no granted tier at all', async () => {
		const platform = platformWith(fakeD1([['full', 365]]));

		// A signed-in visitor with no `access_grant` row. There is no tier to
		// look up, and the row that would be returned must never be reached.
		await expect(calendarGrantFor(platform, null)).resolves.toBeNull();
	});

	it('refuses a tier slug that is not one of the five', async () => {
		const platform = platformWith(fakeD1([['full', 365]]));

		for (const slug of ['admin', 'PARTNER', '', "partner' or '1'='1"]) {
			await expect(calendarGrantFor(platform, slug as never), slug).resolves.toBeNull();
		}
	});

	it('refuses when the tier row has gone missing', async () => {
		await expect(calendarGrantFor(platformWith(fakeD1([])), 'partner')).resolves.toBeNull();
	});

	it('refuses when the row says none', async () => {
		const platform = platformWith(fakeD1([['none', 0]]));

		await expect(calendarGrantFor(platform, 'public')).resolves.toBeNull();
	});

	it('refuses when the D1 binding is missing', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(calendarGrantFor(undefined, 'partner')).resolves.toBeNull();
		await expect(
			calendarGrantFor({ env: {} } as unknown as App.Platform, 'partner')
		).resolves.toBeNull();

		logged.mockRestore();
	});

	/** A transient D1 failure is not a reason to show somebody a calendar. */
	it('refuses when the query throws', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const broken = {
			prepare: () => {
				throw new Error('D1_ERROR: no such table: tier');
			}
		} as unknown as D1Database;

		await expect(calendarGrantFor(platformWith(broken), 'partner')).resolves.toBeNull();
		expect(logged).toHaveBeenCalled();

		logged.mockRestore();
	});
});
