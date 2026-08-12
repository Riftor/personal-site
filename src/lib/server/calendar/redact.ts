import type { CalendarDetail } from '../db/schema';

/**
 * Redact first, then cache (plan §4).
 *
 * The Worker reads the raw event list once and turns it into one payload per
 * detail level *before* anything is stored, so the `busy` cache entry
 * physically does not contain event titles. If a cache entry leaks it leaks
 * only what its tier was allowed to see. Nothing downstream of this file ever
 * sees a raw Google event, and nothing here caches — that ordering is the
 * whole point and reversing it (cache raw, redact on read) would undo it.
 *
 * The three rules that hold at **every** tier, partner included:
 *
 *  1. `private`- and `confidential`-visibility events reduce to `busy`. This
 *     is Caden's only per-event control over his own calendar and there is
 *     deliberately no tier that overrides it.
 *  2. Declined events are dropped entirely.
 *  3. **No attendee data, ever.** Not names, not addresses, not counts, not
 *     response statuses. Those are third parties who did not consent to being
 *     on this website. `CalendarBlock` has no field they could be written to,
 *     which is a stronger guarantee than remembering to strip them.
 */

/**
 * The detail levels that produce a payload at all. `none` is not one: the
 * public tier's calendar page 403s rather than rendering an empty week, so
 * there is no such thing as a `none` payload to cache or leak.
 */
export const VISIBLE_CALENDAR_DETAILS = ['busy', 'titles', 'full'] as const;
export type VisibleCalendarDetail = (typeof VISIBLE_CALENDAR_DETAILS)[number];

export function isVisibleCalendarDetail(value: unknown): value is VisibleCalendarDetail {
	return (
		typeof value === 'string' && (VISIBLE_CALENDAR_DETAILS as readonly string[]).includes(value)
	);
}

/**
 * A tier's `calendar_detail`, narrowed to something renderable, or `null` for
 * "this tier sees no calendar". Anything the column should not have contained
 * — a NULL, a typo, a level added to the CHECK constraint but not to this
 * codebase — also lands on `null`, because the only safe reading of a detail
 * level nobody can interpret is that nothing may be shown.
 */
export function visibleDetailFor(
	detail: CalendarDetail | null | undefined
): VisibleCalendarDetail | null {
	return isVisibleCalendarDetail(detail) ? detail : null;
}

/**
 * The subset of a Google Calendar event this codebase reads, typed as
 * `unknown` throughout on purpose: this is parsed API output, and every field
 * is validated at the point of use rather than trusted because a type said so.
 */
export type GoogleCalendarEvent = {
	status?: unknown;
	summary?: unknown;
	location?: unknown;
	description?: unknown;
	visibility?: unknown;
	start?: unknown;
	end?: unknown;
	attendees?: unknown;
};

export type CalendarBlock = {
	/** RFC 3339 instant, or a bare `YYYY-MM-DD` when `allDay`. */
	start: string;
	/** Exclusive, as Google reports it. */
	end: string;
	allDay: boolean;
	/** `null` at `busy`, and at any tier for a private-visibility event. */
	title: string | null;
	/** `full` only. */
	location: string | null;
	/** `full` only. */
	description: string | null;
};

export type CalendarPayload = {
	detail: VisibleCalendarDetail;
	horizonDays: number;
	/** The calendar's own IANA zone — Caden's home timezone, per plan §4. */
	timeZone: string;
	/** Epoch ms at which these blocks were read from Google. Drives staleness. */
	fetchedAt: number;
	blocks: CalendarBlock[];
	/** True when the page cap was hit, so the far end of the window is missing. */
	truncated: boolean;
};

export type RedactOptions = {
	detail: VisibleCalendarDetail;
	horizonDays: number;
	timeZone: string;
	fetchedAt: number;
	truncated?: boolean;
	/**
	 * The calendar's own address. Google marks Caden's own attendee row with
	 * `self: true`, but matching the address too means a response that omits
	 * the flag still gets his declines dropped.
	 */
	selfEmail?: string;
};

/** Visibilities that override the tier and reduce the event to a bare block. */
const OPAQUE_VISIBILITIES = new Set(['private', 'confidential']);

const DAY_MS = 24 * 60 * 60 * 1000;

/** A trimmed non-empty string, or `null`. Never the empty string. */
function text(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * One end of an event, as both the string to render and a number to sort and
 * merge by. `null` when Google gave neither a `dateTime` nor a `date`, which
 * drops the event — an event with no start is not a thing anyone can schedule
 * around.
 */
function boundary(value: unknown): { at: string; ms: number; allDay: boolean } | null {
	if (typeof value !== 'object' || value === null) return null;
	const { dateTime, date } = value as { dateTime?: unknown; date?: unknown };

	const instant = text(dateTime);
	if (instant) {
		const ms = Date.parse(instant);
		return Number.isFinite(ms) ? { at: instant, ms, allDay: false } : null;
	}

	const day = text(date);
	if (day) {
		const ms = Date.parse(`${day}T00:00:00Z`);
		return Number.isFinite(ms) ? { at: day, ms, allDay: true } : null;
	}

	return null;
}

/**
 * Whether Caden himself declined. Only his own response matters — a guest
 * declining an event he is still attending does not free up his evening, and
 * reading other people's responses would be attendee data by another name.
 */
function isDeclinedBySelf(attendees: unknown, selfEmail?: string): boolean {
	if (!Array.isArray(attendees)) return false;
	const self = selfEmail?.trim().toLowerCase();

	return attendees.some((attendee) => {
		if (typeof attendee !== 'object' || attendee === null) return false;
		const {
			self: isSelf,
			email,
			responseStatus
		} = attendee as { self?: unknown; email?: unknown; responseStatus?: unknown };

		if (responseStatus !== 'declined') return false;
		if (isSelf === true) return true;
		return typeof email === 'string' && self !== undefined && email.trim().toLowerCase() === self;
	});
}

/**
 * Merges overlapping and touching blocks into one.
 *
 * Only ever applied to a whole-payload `busy` (plan §4's table says adjacent
 * blocks are merged at that level, and only that level). Merging blocks that
 * carry titles would have to pick one of them, which is a lie; merging bare
 * ones loses nothing, because two touching busy blocks and one long busy block
 * say exactly the same thing.
 *
 * All-day bands and timed blocks are merged within their own kind. A day band
 * that swallowed a 30-minute meeting would report a whole day as unavailable.
 */
function mergeAdjacent(blocks: (CalendarBlock & { startMs: number; endMs: number })[]) {
	const merged: (CalendarBlock & { startMs: number; endMs: number })[] = [];

	for (const block of [...blocks].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
		const previous = merged.at(-1);

		if (previous && previous.allDay === block.allDay && block.startMs <= previous.endMs) {
			if (block.endMs > previous.endMs) {
				previous.end = block.end;
				previous.endMs = block.endMs;
			}
			continue;
		}

		merged.push({ ...block });
	}

	return merged;
}

/**
 * Raw events in, one tier's payload out.
 *
 * Written as a filter-then-build rather than a build-then-strip: a block is
 * assembled field by field from what the effective detail level permits, so
 * adding a field to `CalendarBlock` cannot accidentally carry data down to a
 * tier that had not asked for it.
 */
export function redactEvents(
	events: readonly GoogleCalendarEvent[],
	options: RedactOptions
): CalendarPayload {
	const { detail, selfEmail } = options;
	const blocks: (CalendarBlock & { startMs: number; endMs: number })[] = [];

	for (const event of events) {
		if (typeof event !== 'object' || event === null) continue;
		if (event.status === 'cancelled') continue;
		if (isDeclinedBySelf(event.attendees, selfEmail)) continue;

		const start = boundary(event.start);
		const end = boundary(event.end);
		if (!start || !end) continue;

		const allDay = start.allDay || end.allDay;
		// Google reports a zero-length end for some imported events; a block
		// with no duration cannot be merged or rendered sensibly.
		const endMs = end.ms > start.ms ? end.ms : start.ms + (allDay ? DAY_MS : 0);

		// The one rule no tier overrides. `visibility` is compared as a string
		// so an absent or unexpected value is simply "not opaque" — Google's
		// own default is `default`, which follows the calendar's setting.
		const opaque =
			typeof event.visibility === 'string' && OPAQUE_VISIBILITIES.has(event.visibility);
		const effective: VisibleCalendarDetail = opaque ? 'busy' : detail;

		blocks.push({
			start: start.at,
			end: end.at,
			allDay,
			startMs: start.ms,
			endMs,
			title: effective === 'busy' ? null : text(event.summary),
			location: effective === 'full' ? text(event.location) : null,
			description: effective === 'full' ? text(event.description) : null
		});
	}

	const ordered = detail === 'busy' ? mergeAdjacent(blocks) : blocks;

	return {
		detail,
		horizonDays: options.horizonDays,
		timeZone: options.timeZone,
		fetchedAt: options.fetchedAt,
		truncated: options.truncated === true,
		blocks: ordered
			.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
			.map(({ start, end, allDay, title, location, description }) => ({
				start,
				end,
				allDay,
				title,
				location,
				description
			}))
	};
}
