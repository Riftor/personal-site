import { describe, expect, it } from 'vitest';
import {
	redactEvents,
	visibleDetailFor,
	type CalendarPayload,
	type GoogleCalendarEvent,
	type VisibleCalendarDetail
} from './redact';

/**
 * The M5.3 done-condition and the rules around it.
 *
 * The fixture is deliberately full of strings that must not escape their tier:
 * a private-visibility appointment, a confidential one, a location, a
 * description, and three third-party attendee addresses. Most of the
 * assertions below search the **whole serialised payload** rather than
 * individual fields, because the property being proved is "this string is not
 * in there anywhere", not "this field is null".
 */

const SELF = 'caden@gmail.com';

const TITLES = {
	sprint: 'Sprint review with Loom',
	dentist: 'Dentist — root canal',
	interview: 'Interview at Northwind',
	offsite: 'Team offsite',
	bookClub: 'Book club',
	cancelled: 'Cancelled lunch',
	cornwall: 'Cornwall',
	freeTalk: 'Optional talk on typography',
	freeBand: 'Bin day'
} as const;

const LOCATION = 'The Studio, 4 Pike Lane';
const DESCRIPTION = 'Bring the storyboard and the printed brief.';
const GUEST_EMAILS = ['mira@example.com', 'tobias@example.org', 'priya@example.net'];

const EVENTS: GoogleCalendarEvent[] = [
	{
		summary: TITLES.sprint,
		location: LOCATION,
		description: DESCRIPTION,
		start: { dateTime: '2026-08-12T14:00:00+01:00' },
		end: { dateTime: '2026-08-12T15:00:00+01:00' },
		attendees: [
			{ email: GUEST_EMAILS[0], responseStatus: 'accepted' },
			{ email: SELF, self: true, responseStatus: 'accepted' }
		]
	},
	// Caden's only per-event control. `busy` at every tier, partner included.
	{
		summary: TITLES.dentist,
		location: 'Wells Dental Practice',
		description: 'Bring the referral letter.',
		visibility: 'private',
		start: { dateTime: '2026-08-12T08:00:00+01:00' },
		end: { dateTime: '2026-08-12T08:30:00+01:00' }
	},
	{
		summary: TITLES.interview,
		visibility: 'confidential',
		start: { dateTime: '2026-08-12T12:00:00+01:00' },
		end: { dateTime: '2026-08-12T13:00:00+01:00' }
	},
	// Declined by the `self` flag …
	{
		summary: TITLES.offsite,
		start: { dateTime: '2026-08-13T09:00:00+01:00' },
		end: { dateTime: '2026-08-13T17:00:00+01:00' },
		attendees: [{ email: SELF, self: true, responseStatus: 'declined' }]
	},
	// … and by address alone, for a response that omits the flag.
	{
		summary: TITLES.bookClub,
		start: { dateTime: '2026-08-14T19:00:00+01:00' },
		end: { dateTime: '2026-08-14T21:00:00+01:00' },
		attendees: [
			{ email: GUEST_EMAILS[1], responseStatus: 'accepted' },
			{ email: SELF.toUpperCase(), responseStatus: 'declined' }
		]
	},
	{
		summary: TITLES.cancelled,
		status: 'cancelled',
		start: { dateTime: '2026-08-12T16:00:00+01:00' },
		end: { dateTime: '2026-08-12T17:00:00+01:00' }
	},
	{
		summary: TITLES.cornwall,
		start: { date: '2026-08-15' },
		end: { date: '2026-08-17' }
	},
	// Two touching blocks, merged at `busy` and left alone above it.
	{
		summary: 'Standup',
		start: { dateTime: '2026-08-12T09:00:00+01:00' },
		end: { dateTime: '2026-08-12T10:00:00+01:00' }
	},
	{
		summary: 'Pairing',
		start: { dateTime: '2026-08-12T10:00:00+01:00' },
		end: { dateTime: '2026-08-12T11:00:00+01:00' },
		attendees: [{ email: GUEST_EMAILS[2], responseStatus: 'tentative' }]
	},
	// Marked Free. Ruled 2026-08-12: dropped at every tier, because rendering
	// it as a busy block would misstate the one thing this page is for.
	{
		summary: TITLES.freeTalk,
		location: 'Lecture theatre 2',
		transparency: 'transparent',
		start: { dateTime: '2026-08-12T13:00:00+01:00' },
		end: { dateTime: '2026-08-12T14:00:00+01:00' }
	},
	// Free and all-day, which is Google's own default for an all-day event —
	// the case that makes this ruling cost something.
	{
		summary: TITLES.freeBand,
		transparency: 'transparent',
		start: { date: '2026-08-18' },
		end: { date: '2026-08-19' }
	},
	// No start at all. Not something anyone can schedule around.
	{ summary: 'Someday', end: { dateTime: '2026-08-12T18:00:00+01:00' } }
];

function payloadFor(detail: VisibleCalendarDetail, horizonDays = 30): CalendarPayload {
	return redactEvents(EVENTS, {
		detail,
		horizonDays,
		timeZone: 'Europe/London',
		fetchedAt: 1_770_000_000_000,
		selfEmail: SELF
	});
}

describe('redactEvents', () => {
	/** The M5.3 done-condition, stated as plainly as it can be. */
	it('emits a busy payload that contains no event title anywhere in it', () => {
		const serialised = JSON.stringify(payloadFor('busy'));

		for (const title of Object.values(TITLES)) {
			expect(serialised).not.toContain(title);
		}
		expect(serialised).not.toContain('Standup');
		expect(serialised).not.toContain('Pairing');
	});

	it('emits no location or description at busy', () => {
		const serialised = JSON.stringify(payloadFor('busy'));

		expect(serialised).not.toContain(LOCATION);
		expect(serialised).not.toContain(DESCRIPTION);
		expect(payloadFor('busy').blocks.every((block) => block.title === null)).toBe(true);
	});

	/**
	 * No tier has a field for attendees, so this is a structural guarantee
	 * rather than a stripping step — but the assertion is worth keeping,
	 * because it is the one that would fail if a field were ever added.
	 */
	it('leaks no attendee address at any tier, partner included', () => {
		for (const detail of ['busy', 'titles', 'full'] as const) {
			const serialised = JSON.stringify(payloadFor(detail));
			for (const email of [...GUEST_EMAILS, SELF]) {
				expect(serialised).not.toContain(email);
			}
		}
	});

	it('shows titles and nothing more at titles', () => {
		const payload = payloadFor('titles', 90);
		const serialised = JSON.stringify(payload);

		expect(payload.blocks.map((block) => block.title)).toContain(TITLES.sprint);
		expect(serialised).not.toContain(LOCATION);
		expect(serialised).not.toContain(DESCRIPTION);
		expect(payload.blocks.every((block) => block.location === null)).toBe(true);
		expect(payload.blocks.every((block) => block.description === null)).toBe(true);
	});

	it('shows title, location and description at full', () => {
		const sprint = payloadFor('full', 365).blocks.find((block) => block.title === TITLES.sprint);

		expect(sprint).toBeDefined();
		expect(sprint?.location).toBe(LOCATION);
		expect(sprint?.description).toBe(DESCRIPTION);
	});

	/**
	 * The rule HANDOFF.md singles out: there is no "partner sees private
	 * events too" exception, because this is Caden's only per-event control.
	 */
	it('reduces private and confidential events to busy even at full', () => {
		const payload = payloadFor('full', 365);
		const serialised = JSON.stringify(payload);

		expect(serialised).not.toContain(TITLES.dentist);
		expect(serialised).not.toContain(TITLES.interview);
		expect(serialised).not.toContain('Wells Dental Practice');
		expect(serialised).not.toContain('Bring the referral letter.');

		// The time is still there — that is the point of reducing rather than dropping.
		const dentist = payload.blocks.find((block) => block.start.startsWith('2026-08-12T08:00'));
		expect(dentist).toEqual({
			start: '2026-08-12T08:00:00+01:00',
			end: '2026-08-12T08:30:00+01:00',
			allDay: false,
			title: null,
			location: null,
			description: null
		});
	});

	it('drops declined events, by the self flag and by address alike', () => {
		const serialised = JSON.stringify(payloadFor('full', 365));

		expect(serialised).not.toContain(TITLES.offsite);
		expect(serialised).not.toContain(TITLES.bookClub);
	});

	/**
	 * Ruled 2026-08-12. The page exists so people can schedule around Caden,
	 * and a Free event rendered as Busy is a lie about his availability — so
	 * they go, at every tier, rather than being kept as bare blocks.
	 */
	it('drops events marked Free at every tier, timed and all-day alike', () => {
		for (const detail of ['busy', 'titles', 'full'] as const) {
			const payload = payloadFor(detail, 365);
			const serialised = JSON.stringify(payload);

			expect(serialised, detail).not.toContain(TITLES.freeTalk);
			expect(serialised, detail).not.toContain(TITLES.freeBand);
			expect(serialised, detail).not.toContain('Lecture theatre 2');
			// Not even the time survives: a Free hour is not a busy hour.
			const starts = payload.blocks.map((block) => block.start);
			expect(starts, detail).not.toContain('2026-08-12T13:00:00+01:00');
			expect(starts, detail).not.toContain('2026-08-18');
		}
	});

	/**
	 * Google omits `transparency` on most timed events because its default is
	 * `opaque`. Treating anything unrecognised as Free would empty the
	 * calendar rather than fill it, which is the failure that looks like
	 * "Caden has nothing on".
	 */
	it('keeps an event whose transparency is absent or unrecognised', () => {
		const payload = redactEvents(
			[
				{
					summary: 'Explicitly busy',
					transparency: 'opaque',
					start: { dateTime: '2026-08-12T09:00:00+01:00' },
					end: { dateTime: '2026-08-12T10:00:00+01:00' }
				},
				{
					summary: 'Something new from Google',
					transparency: 'translucent',
					start: { dateTime: '2026-08-12T11:00:00+01:00' },
					end: { dateTime: '2026-08-12T12:00:00+01:00' }
				},
				{
					summary: 'No transparency field at all',
					start: { dateTime: '2026-08-12T15:00:00+01:00' },
					end: { dateTime: '2026-08-12T16:00:00+01:00' }
				}
			],
			{ detail: 'titles', horizonDays: 30, timeZone: 'Europe/London', fetchedAt: 0 }
		);

		expect(payload.blocks).toHaveLength(3);
	});

	it('drops cancelled events and events with no start', () => {
		const payload = payloadFor('titles');

		expect(payload.blocks.map((block) => block.title)).not.toContain(TITLES.cancelled);
		expect(payload.blocks.map((block) => block.title)).not.toContain('Someday');
	});

	it('merges touching busy blocks, and leaves them separate above busy', () => {
		const busy = payloadFor('busy').blocks.filter((block) => !block.allDay);
		const titled = payloadFor('titles').blocks.filter((block) => !block.allDay);

		expect(busy).toContainEqual({
			start: '2026-08-12T09:00:00+01:00',
			end: '2026-08-12T11:00:00+01:00',
			allDay: false,
			title: null,
			location: null,
			description: null
		});
		expect(titled.map((block) => block.title)).toEqual(
			expect.arrayContaining(['Standup', 'Pairing'])
		);
	});

	it('keeps an all-day band out of the timed merge', () => {
		const cornwall = payloadFor('busy').blocks.filter((block) => block.allDay);

		expect(cornwall).toEqual([
			{
				start: '2026-08-15',
				end: '2026-08-17',
				allDay: true,
				title: null,
				location: null,
				description: null
			}
		]);
	});

	it('returns the blocks in start order and carries the window metadata', () => {
		const payload = payloadFor('titles', 90);
		const starts = payload.blocks.map((block) => block.start);

		expect([...starts].sort()).toEqual(starts);
		expect(payload).toMatchObject({
			detail: 'titles',
			horizonDays: 90,
			timeZone: 'Europe/London',
			fetchedAt: 1_770_000_000_000,
			truncated: false
		});
	});

	it('survives junk in the items array without inventing a block', () => {
		const payload = redactEvents(
			[null as unknown as GoogleCalendarEvent, {}, { start: { dateTime: 'not a date' } }],
			{ detail: 'busy', horizonDays: 30, timeZone: 'UTC', fetchedAt: 0 }
		);

		expect(payload.blocks).toEqual([]);
	});
});

describe('visibleDetailFor', () => {
	it('narrows the three renderable levels and refuses everything else', () => {
		expect(visibleDetailFor('busy')).toBe('busy');
		expect(visibleDetailFor('titles')).toBe('titles');
		expect(visibleDetailFor('full')).toBe('full');
		expect(visibleDetailFor('none')).toBeNull();
		expect(visibleDetailFor(null)).toBeNull();
		expect(visibleDetailFor(undefined)).toBeNull();
	});
});
