import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { tier, TIER_SLUGS, type TierSlug } from '../db/schema';
import { isVisibleCalendarDetail, type VisibleCalendarDetail } from './redact';

/**
 * The tier → detail/horizon seam (plan §4, M5.5).
 *
 * Everything below this file — `view` → `cache` → `fetch` → `redact` — is
 * correct for whatever `(detail, horizonDays)` pair it is handed. This is the
 * file that decides the pair, which makes it the one place in the calendar
 * where a viewer could be mapped to a more generous variant than their tier
 * allows. Three properties are load-bearing:
 *
 *  1. **The `tier` row is the only input.** Not the query string, not a
 *     header, not a cookie, not `locals.viewer.rank`. The caller passes a tier
 *     *slug*, which came from `access_grant` joined to `tier` on this same
 *     request, and both columns are read back out of the database here rather
 *     than being carried along from anywhere a visitor can reach.
 *  2. **Read at request time.** Nothing is cached, memoised, or baked into the
 *     bundle, so changing `calendar_detail` or `calendar_horizon_days` in D1
 *     takes effect on the next page load — the same property that makes
 *     `access:revoke` immediate.
 *  3. **Every unexpected value refuses.** A missing row, a NULL, a
 *     non-integer, a detail level this codebase cannot interpret, a horizon
 *     past the largest one the plan describes, a query that throws — all of
 *     them return `null`, and `null` means the page 403s. There is
 *     deliberately no branch here that turns something unrecognised into a
 *     default, because every available default is more generous than "no".
 */

/**
 * The longest horizon plan §4 describes, and the ceiling this file will act
 * on. A row above it is not a bigger calendar — it is a typo or a hand-edit,
 * and the safe reading of a horizon nobody specified is that it is not usable.
 * Refusing rather than clamping keeps the rule to "unexpected value → no
 * calendar", which is one rule instead of two.
 */
export const MAX_CALENDAR_HORIZON_DAYS = 365;

/** What one tier may see. There is no representation of "a bit more". */
export type CalendarGrant = { detail: VisibleCalendarDetail; horizonDays: number };

/**
 * One `tier` row's two calendar columns, validated.
 *
 * Split out from the query so the refusals can be tested exhaustively without
 * a database: this is where `none`, a NULL horizon, a hand-typed detail level
 * and a 10,000-day window all become the same answer.
 *
 * The horizon comparisons are written as a failed `>=` / `<=` rather than as
 * `<` / `>`, so a `NaN` — which compares false against everything — refuses
 * instead of slipping through the negation.
 */
export function calendarGrantFrom(detail: unknown, horizonDays: unknown): CalendarGrant | null {
	// `none` fails this too, which is the point: the public tier's calendar is
	// not an empty week, it is no page at all.
	if (!isVisibleCalendarDetail(detail)) return null;
	if (typeof horizonDays !== 'number' || !Number.isInteger(horizonDays)) return null;
	if (!(horizonDays >= 1 && horizonDays <= MAX_CALENDAR_HORIZON_DAYS)) return null;

	return { detail, horizonDays };
}

/**
 * The calendar a tier slug may see, or `null` for "none, refuse the page".
 *
 * `tierSlug` is re-checked against the known set even though it arrives typed:
 * it originates in a database column, and `resolveGrantedTier` having already
 * validated it is a reason to expect the check to pass, not a reason to skip
 * it. A slug nobody recognises must not reach a `WHERE` clause.
 */
export async function calendarGrantFor(
	platform: App.Platform | undefined,
	tierSlug: TierSlug | null
): Promise<CalendarGrant | null> {
	if (typeof tierSlug !== 'string') return null;
	if (!(TIER_SLUGS as readonly string[]).includes(tierSlug)) return null;

	const d1 = platform?.env?.DB;
	if (!d1) {
		console.error('calendar: the D1 binding DB is missing; no tier can be resolved.');
		return null;
	}

	try {
		const [row] = await getDb(d1)
			.select({ detail: tier.calendarDetail, horizonDays: tier.calendarHorizonDays })
			.from(tier)
			.where(eq(tier.slug, tierSlug))
			.limit(1);

		// No row is the same answer as a bad row. A grant naming a tier that
		// has since been deleted grants no calendar.
		return row ? calendarGrantFrom(row.detail, row.horizonDays) : null;
	} catch (cause) {
		console.error('calendar: the tier lookup failed; refusing rather than guessing.', cause);
		return null;
	}
}
