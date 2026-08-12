import type { CalendarBlock } from './redact';

/**
 * Presentation for `/private/calendar` (plan §4, M5.5): redacted blocks in,
 * a week-by-week agenda out.
 *
 * Everything here is formatting and grouping. Nothing in this file decides
 * what a viewer may see — the blocks arrive already reduced to their tier by
 * `redact.ts`, and a field that is `null` here was `null` before it was
 * cached. Re-deriving detail at render time is exactly the mistake the
 * redact-first ordering exists to prevent, so this file only ever reads
 * `CalendarBlock` fields and never inspects the detail level.
 *
 * Times are rendered in **Caden's home timezone**, which is the calendar's own
 * zone as Google reports it, labelled explicitly. The viewer's own zone is the
 * page's job and happens in the browser, from the instants passed through
 * here: the server cannot know it, and guessing would be worse than saying so.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** One block, pre-formatted in home time and still carrying its instants. */
export type AgendaEntry = {
	/** Stable within a render; only ever used as a keyed-each key. */
	key: string;
	/** `YYYY-MM-DD` in the home timezone — the day this entry is filed under. */
	date: string;
	/** RFC 3339 instant, or a bare `YYYY-MM-DD` when `allDay`. */
	startIso: string;
	endIso: string;
	allDay: boolean;
	/** Epoch ms for the browser's viewer-local pass. `null` for a day band. */
	startMs: number | null;
	endMs: number | null;
	/** Home-timezone clock times. `null` for a day band, which has no clock. */
	startTime: string | null;
	endTime: string | null;
	/** "Sat 15 Aug" when the block does not finish on the day it starts. */
	endsOn: string | null;
	title: string | null;
	location: string | null;
	description: string | null;
};

export type AgendaDay = {
	/** `YYYY-MM-DD` in the home timezone. */
	date: string;
	/** "Thu 13 Aug". */
	label: string;
	entries: AgendaEntry[];
};

export type AgendaWeek = {
	/** `YYYY-MM-DD` of the Monday this week starts on. */
	start: string;
	/** "Week of Mon 11 Aug". */
	label: string;
	days: AgendaDay[];
};

/**
 * The zone to format in, or `UTC` if it is not one this runtime knows.
 *
 * `timeZone` comes from Google rather than from the database, so it is not
 * attacker-controlled, but an unknown zone would throw out of every formatter
 * below and take the whole page down over a label. Falling back is safe here
 * in a way it never is on the access path: the worst case is times shown in
 * the wrong zone *and said to be UTC*, which is wrong but not a leak.
 */
export function usableTimeZone(timeZone: unknown): string {
	if (typeof timeZone !== 'string' || timeZone.length === 0) return 'UTC';

	try {
		new Intl.DateTimeFormat('en-GB', { timeZone });
		return timeZone;
	} catch {
		return 'UTC';
	}
}

function partsOf(formatter: Intl.DateTimeFormat, ms: number): Record<string, string> {
	return Object.fromEntries(formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** `YYYY-MM-DD` from a `YYYY-MM-DD` offset by whole days. */
function shiftDay(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * "Thu 13 Aug" for a calendar date.
 *
 * Formatted at midday UTC in the UTC zone, so the label is derived from the
 * date string alone and cannot be dragged onto the previous day by an offset.
 * The zoned conversion has already happened by the time a `YYYY-MM-DD` exists.
 */
export function dayLabel(date: string, withYear = false): string {
	const ms = Date.parse(`${date}T12:00:00Z`);
	if (!Number.isFinite(ms)) return date;

	// Assembled from parts rather than formatted whole: `en-GB` punctuates the
	// year-bearing form differently, and two spellings of the same date on one
	// page look like a bug.
	const parts = partsOf(
		new Intl.DateTimeFormat('en-GB', {
			timeZone: 'UTC',
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric'
		}),
		ms
	);

	const label = `${parts.weekday} ${parts.day} ${parts.month}`;
	return withYear ? `${label} ${parts.year}` : label;
}

/** The Monday of the week a date falls in. */
export function weekStartOf(date: string): string {
	const ms = Date.parse(`${date}T00:00:00Z`);
	if (!Number.isFinite(ms)) return date;

	// `getUTCDay` is 0 for Sunday; the site's weeks start on Monday.
	return shiftDay(date, -((new Date(ms).getUTCDay() + 6) % 7));
}

/** "just now" / "4 minutes ago" / "3 hours ago", for the staleness notice. */
export function agoLabel(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 60) return 'just now';

	// Rounded down throughout, so the notice never claims the payload is
	// fresher than it is.
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;

	const hours = Math.floor(minutes / 60);
	return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

type Formatters = {
	timeZone: string;
	day: Intl.DateTimeFormat;
	clock: Intl.DateTimeFormat;
};

function formattersFor(timeZone: string): Formatters {
	return {
		timeZone,
		day: new Intl.DateTimeFormat('en-GB', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		}),
		// `h23` so a midnight boundary reads 00:00 rather than 24:00.
		clock: new Intl.DateTimeFormat('en-GB', {
			timeZone,
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		})
	};
}

function zonedDate(formatters: Formatters, ms: number): string {
	const { year, month, day } = partsOf(formatters.day, ms);
	return `${year}-${month}-${day}`;
}

/** "17:30" in the home timezone. */
export function clockLabel(ms: number, timeZone: string): string {
	return formattersFor(usableTimeZone(timeZone)).clock.format(new Date(ms));
}

/** "Thu 11 Sep 2026" — the far edge of a horizon, for the header. */
export function horizonEndLabel(now: number, horizonDays: number, timeZone: string): string {
	const formatters = formattersFor(usableTimeZone(timeZone));
	return dayLabel(zonedDate(formatters, now + horizonDays * DAY_MS), true);
}

/**
 * One block as the page renders it, or `null` if it carries no usable start.
 *
 * An all-day band is handled from its date strings and never through a
 * timestamp: `2026-08-13` is a day in Caden's calendar, not an instant, and
 * pushing it through a zone conversion is how an all-day event ends up
 * displayed on the 12th.
 */
function entryFor(block: CalendarBlock, formatters: Formatters, index: number): AgendaEntry | null {
	const base = {
		key: `${index}`,
		startIso: block.start,
		endIso: block.end,
		allDay: block.allDay,
		title: block.title,
		location: block.location,
		description: block.description
	};

	if (block.allDay) {
		const date = block.start.slice(0, 10);
		if (!Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return null;

		// Google's end date is exclusive, so a single-day band ends the
		// morning after; the last day a viewer should see is one back.
		const last = shiftDay(block.end.slice(0, 10), -1);
		const spans = Number.isFinite(Date.parse(`${last}T00:00:00Z`)) && last > date;

		return {
			...base,
			date,
			startMs: null,
			endMs: null,
			startTime: null,
			endTime: null,
			endsOn: spans ? dayLabel(last) : null
		};
	}

	const startMs = Date.parse(block.start);
	const endMs = Date.parse(block.end);
	if (!Number.isFinite(startMs)) return null;

	const date = zonedDate(formatters, startMs);
	const finish = Number.isFinite(endMs) ? endMs : startMs;
	const endDate = zonedDate(formatters, finish);

	return {
		...base,
		date,
		startMs,
		endMs: Number.isFinite(endMs) ? endMs : null,
		startTime: formatters.clock.format(new Date(startMs)),
		endTime: Number.isFinite(endMs) ? formatters.clock.format(new Date(finish)) : null,
		endsOn: endDate !== date ? dayLabel(endDate) : null
	};
}

/**
 * Blocks in, weeks of days out — the shape `/private/calendar` renders.
 *
 * Days with nothing in them are not emitted. An agenda that printed 365 empty
 * headings to show 26 events would bury the answer, and "no heading" and "a
 * heading with nothing under it" say the same thing anyway.
 *
 * A block is filed under the day it *starts*, with a "to Sat 15 Aug" note when
 * it runs past that day, rather than repeated across every day it touches.
 * Repeating it would double-count a week away in the busy view, where every
 * block is identical and there is nothing to tell the copies apart.
 */
export function buildAgenda(blocks: readonly CalendarBlock[], timeZone: string): AgendaWeek[] {
	const formatters = formattersFor(usableTimeZone(timeZone));
	const days = new Map<string, AgendaDay>();

	blocks.forEach((block, index) => {
		const entry = entryFor(block, formatters, index);
		if (!entry) return;

		const day = days.get(entry.date);
		if (day) day.entries.push(entry);
		else days.set(entry.date, { date: entry.date, label: dayLabel(entry.date), entries: [entry] });
	});

	const weeks = new Map<string, AgendaWeek>();

	for (const day of [...days.values()].sort((a, b) => a.date.localeCompare(b.date))) {
		const start = weekStartOf(day.date);
		const week = weeks.get(start);

		if (week) week.days.push(day);
		else weeks.set(start, { start, label: `Week of ${dayLabel(start)}`, days: [day] });
	}

	return [...weeks.values()].sort((a, b) => a.start.localeCompare(b.start));
}
