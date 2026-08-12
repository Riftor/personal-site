import { describe, expect, it } from 'vitest';
import {
	agoLabel,
	buildAgenda,
	clockLabel,
	dayLabel,
	horizonEndLabel,
	usableTimeZone,
	weekStartOf
} from './agenda';
import type { CalendarBlock } from './redact';

/**
 * The agenda the page renders.
 *
 * The fixture is in `Europe/London` during BST — UTC+1 — because that is the
 * offset that catches the mistakes worth catching: an event at 00:30 local is
 * on the *previous* UTC day, and a naive `toISOString().slice(0, 10)` files it
 * under the wrong heading. `America/Los_Angeles` is checked alongside so the
 * grouping is demonstrably following the zone rather than the server's.
 */

const HOME = 'Europe/London';

function block(partial: Partial<CalendarBlock>): CalendarBlock {
	return {
		start: '2026-08-13T09:00:00+01:00',
		end: '2026-08-13T10:30:00+01:00',
		allDay: false,
		title: null,
		location: null,
		description: null,
		...partial
	};
}

describe('usableTimeZone', () => {
	it('keeps a zone this runtime knows', () => {
		expect(usableTimeZone(HOME)).toBe(HOME);
	});

	it('falls back to UTC rather than throwing the page away over a label', () => {
		for (const zone of ['Mars/Olympus', '', null, undefined, 42]) {
			expect(usableTimeZone(zone), String(zone)).toBe('UTC');
		}
	});
});

describe('buildAgenda', () => {
	it('groups blocks into weeks of days, in order', () => {
		const weeks = buildAgenda(
			[
				block({ start: '2026-08-20T18:00:00+01:00', end: '2026-08-20T19:00:00+01:00' }),
				block({ start: '2026-08-13T09:00:00+01:00', end: '2026-08-13T10:30:00+01:00' }),
				block({ start: '2026-08-13T14:00:00+01:00', end: '2026-08-13T15:00:00+01:00' })
			],
			HOME
		);

		expect(weeks.map((w) => w.start)).toEqual(['2026-08-10', '2026-08-17']);
		expect(weeks[0].label).toBe('Week of Mon 10 Aug');
		expect(weeks[0].days).toHaveLength(1);
		expect(weeks[0].days[0].label).toBe('Thu 13 Aug');
		expect(weeks[0].days[0].entries.map((e) => e.startTime)).toEqual(['09:00', '14:00']);
		expect(weeks[1].days[0].entries[0].startTime).toBe('18:00');
	});

	/** The whole reason the zone is threaded through rather than assumed. */
	it('files an after-midnight event under the home day, not the UTC one', () => {
		const [week] = buildAgenda(
			[block({ start: '2026-08-14T00:30:00+01:00', end: '2026-08-14T01:30:00+01:00' })],
			HOME
		);

		expect(week.days[0].date).toBe('2026-08-14');
		expect(week.days[0].entries[0].startTime).toBe('00:30');
	});

	it('groups by the calendar’s own zone, not the server’s', () => {
		const [week] = buildAgenda(
			[block({ start: '2026-08-14T00:30:00+01:00', end: '2026-08-14T01:30:00+01:00' })],
			'America/Los_Angeles'
		);

		// The same instant is the previous afternoon in Los Angeles.
		expect(week.days[0].date).toBe('2026-08-13');
		expect(week.days[0].entries[0].startTime).toBe('16:30');
	});

	it('renders an all-day band from its dates, with no clock and no zone shift', () => {
		const [week] = buildAgenda(
			[block({ start: '2026-08-13', end: '2026-08-14', allDay: true })],
			'Pacific/Kiritimati'
		);
		const [entry] = week.days[0].entries;

		expect(week.days[0].date).toBe('2026-08-13');
		expect(entry.startTime).toBeNull();
		expect(entry.startMs).toBeNull();
		// Google's end date is exclusive, so a one-day band is not "to the 14th".
		expect(entry.endsOn).toBeNull();
	});

	it('says where a multi-day band and an overnight event finish', () => {
		const [week] = buildAgenda(
			[
				block({ start: '2026-08-13', end: '2026-08-16', allDay: true }),
				block({ start: '2026-08-13T22:00:00+01:00', end: '2026-08-14T02:00:00+01:00' })
			],
			HOME
		);
		const [band, overnight] = week.days[0].entries;

		expect(band.endsOn).toBe('Sat 15 Aug');
		expect(overnight.endsOn).toBe('Fri 14 Aug');
	});

	it('carries the instants through for the browser’s viewer-local pass', () => {
		const [week] = buildAgenda([block({})], HOME);
		const [entry] = week.days[0].entries;

		expect(entry.startMs).toBe(Date.parse('2026-08-13T09:00:00+01:00'));
		expect(entry.endMs).toBe(Date.parse('2026-08-13T10:30:00+01:00'));
	});

	/**
	 * Detail is decided in `redact.ts` and nowhere else. This file must pass
	 * through exactly what it is handed — including the nulls that are how a
	 * `busy` block says it has no title.
	 */
	it('passes detail through untouched rather than re-deriving it', () => {
		const [week] = buildAgenda(
			[block({ title: 'Sprint review', location: 'The Studio', description: 'Bring the brief.' })],
			HOME
		);
		const [entry] = week.days[0].entries;

		expect(entry.title).toBe('Sprint review');
		expect(entry.location).toBe('The Studio');
		expect(entry.description).toBe('Bring the brief.');

		const [busy] = buildAgenda([block({})], HOME);
		expect(busy.days[0].entries[0].title).toBeNull();
	});

	it('drops a block with an unparseable start instead of rendering NaN', () => {
		expect(buildAgenda([block({ start: 'whenever', end: 'later' })], HOME)).toEqual([]);
	});

	it('emits nothing for an empty calendar', () => {
		expect(buildAgenda([], HOME)).toEqual([]);
	});
});

describe('weekStartOf', () => {
	it('starts weeks on Monday, including on a Sunday', () => {
		expect(weekStartOf('2026-08-13')).toBe('2026-08-10'); // Thursday
		expect(weekStartOf('2026-08-10')).toBe('2026-08-10'); // Monday itself
		expect(weekStartOf('2026-08-16')).toBe('2026-08-10'); // Sunday
	});
});

describe('dayLabel and horizonEndLabel', () => {
	it('labels a date from the date alone, with no offset to drag it back a day', () => {
		expect(dayLabel('2026-08-13')).toBe('Thu 13 Aug');
		expect(dayLabel('2026-01-01')).toBe('Thu 1 Jan');
	});

	it('names the far edge of a horizon', () => {
		const now = Date.parse('2026-08-12T12:00:00Z');

		expect(horizonEndLabel(now, 30, HOME)).toBe('Fri 11 Sept 2026');
		expect(horizonEndLabel(now, 365, HOME)).toBe('Thu 12 Aug 2027');
	});
});

describe('clockLabel', () => {
	it('reads a timestamp in the home zone on a 24-hour clock', () => {
		expect(clockLabel(Date.parse('2026-08-12T22:14:00Z'), HOME)).toBe('23:14');
		expect(clockLabel(Date.parse('2026-08-12T23:00:00Z'), HOME)).toBe('00:00');
	});
});

describe('agoLabel', () => {
	it('describes the age behind the staleness notice', () => {
		expect(agoLabel(0)).toBe('just now');
		expect(agoLabel(45)).toBe('just now');
		expect(agoLabel(600)).toBe('10 minutes ago');
		expect(agoLabel(3600)).toBe('1 hour ago');
		expect(agoLabel(6 * 60 * 60)).toBe('6 hours ago');
	});
});
