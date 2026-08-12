import {
	isVisibleCalendarDetail,
	type CalendarBlock,
	type CalendarPayload,
	type VisibleCalendarDetail
} from './redact';

/**
 * The Cache API layer in front of the Google read (plan §4).
 *
 * Keyed **per detail level**, because the entries are already redacted: the
 * `busy` entry contains no titles, so a cache that leaks leaks only what that
 * tier could see. The key carries the horizon too, so the 30/90/365-day bands
 * never share bytes.
 *
 * Cache API rather than KV: KV's free tier allows 1,000 writes a day and a
 * 15-minute warm across three variants brushes against that; the Cache API is
 * unmetered.
 *
 * The freshness arithmetic is done here rather than left to `Cache-Control`,
 * and that is deliberate. Entries are stored with a **six-hour** max-age — the
 * serve-stale ceiling — so that when Google is down the last good payload is
 * still *in* the cache to be served. Whether it is fresh is then decided from
 * the payload's own `fetchedAt`. Storing them with `max-age=300` instead would
 * make the cache drop exactly the entry the stale path needs.
 */

/** Inside this, a request never touches Google. Plan §4's 300 s TTL. */
export const CALENDAR_FRESH_SECONDS = 300;

/** Past this a stale payload is no longer worth showing; the page says so. */
export const CALENDAR_MAX_STALE_SECONDS = 6 * 60 * 60;

const CALENDAR_CACHE_NAME = 'calendar';

/** Not routable; the Cache API only needs the URL to be unique per variant. */
export function calendarCacheKey(detail: VisibleCalendarDetail, horizonDays: number): string {
	return `https://cache.internal/calendar/${detail}/${horizonDays}`;
}

/**
 * `null` when there is no Cache API — the case under `vite dev`, where
 * `getPlatformProxy` supplies a stub. Every caller treats `null` as "always a
 * miss", so local development reads live and still works.
 */
export async function openCalendarCache(): Promise<Cache | null> {
	try {
		if (typeof caches?.open !== 'function') return null;
		return await caches.open(CALENDAR_CACHE_NAME);
	} catch (cause) {
		console.error('calendar: no Cache API; every request will read live.', cause);
		return null;
	}
}

/**
 * What the page gets. `stale` and `fresh` carry the same payload shape and
 * differ only in `ageSeconds` and the notice the page is expected to render;
 * `unavailable` carries no payload at all, because there is nothing truthful
 * to show.
 */
export type CalendarView =
	| { status: 'fresh'; payload: CalendarPayload; ageSeconds: number }
	| { status: 'stale'; payload: CalendarPayload; ageSeconds: number }
	| { status: 'unavailable' };

/**
 * A cached block, re-checked against the detail level of the key it was found
 * under.
 *
 * `redactEvents` already guarantees this on the way in, so nothing legitimate
 * is ever rejected here — which is the point. The check exists so that the
 * only way a title reaches a `busy` viewer is for *both* the redactor and this
 * to be wrong at once, rather than for one cache entry to have been written by
 * a version of the redactor that was.
 */
function readBlock(value: unknown, detail: VisibleCalendarDetail): CalendarBlock | null {
	if (typeof value !== 'object' || value === null) return null;
	const block = value as Partial<CalendarBlock>;

	if (typeof block.start !== 'string' || block.start.length === 0) return null;
	if (typeof block.end !== 'string' || block.end.length === 0) return null;

	const title = typeof block.title === 'string' ? block.title : null;
	const location = typeof block.location === 'string' ? block.location : null;
	const description = typeof block.description === 'string' ? block.description : null;

	if (detail === 'busy' && title !== null) return null;
	if (detail !== 'full' && (location !== null || description !== null)) return null;

	return {
		start: block.start,
		end: block.end,
		allDay: block.allDay === true,
		title,
		location,
		description
	};
}

/**
 * Validates a payload read back out of the cache.
 *
 * The `detail` and `horizonDays` checks are the important ones: they make a
 * mismatched entry — a poisoned cache, a key collision, a variant renamed
 * between deploys — unreadable rather than serving a `full` payload to
 * somebody the key said should get `busy`. Everything else is the same
 * default-deny shape check as the rest of this codebase: anything that is not
 * exactly what it should be is treated as a miss, and a miss costs a round
 * trip rather than access.
 */
function readPayload(
	value: unknown,
	detail: VisibleCalendarDetail,
	horizonDays: number
): CalendarPayload | null {
	if (typeof value !== 'object' || value === null) return null;
	const payload = value as Partial<CalendarPayload>;

	if (!isVisibleCalendarDetail(payload.detail) || payload.detail !== detail) return null;
	if (payload.horizonDays !== horizonDays) return null;
	if (typeof payload.timeZone !== 'string' || payload.timeZone.length === 0) return null;
	if (typeof payload.fetchedAt !== 'number' || !Number.isFinite(payload.fetchedAt)) return null;
	if (!Array.isArray(payload.blocks)) return null;

	const blocks: CalendarBlock[] = [];
	for (const candidate of payload.blocks) {
		const block = readBlock(candidate, detail);
		// One bad block condemns the entry rather than being dropped from it: a
		// calendar quietly missing an hour is worse than one read live.
		if (!block) return null;
		blocks.push(block);
	}

	return {
		detail: payload.detail,
		horizonDays,
		timeZone: payload.timeZone,
		fetchedAt: payload.fetchedAt,
		truncated: payload.truncated === true,
		blocks
	};
}

async function readCached(
	cache: Cache | null,
	key: string,
	detail: VisibleCalendarDetail,
	horizonDays: number
): Promise<CalendarPayload | null> {
	if (!cache) return null;

	try {
		const hit = await cache.match(new Request(key));
		if (!hit) return null;
		return readPayload(await hit.json(), detail, horizonDays);
	} catch (cause) {
		console.error('calendar: the cached payload could not be read; treating it as a miss.', cause);
		return null;
	}
}

async function writeCached(cache: Cache | null, key: string, payload: CalendarPayload) {
	if (!cache) return;

	try {
		await cache.put(
			new Request(key),
			new Response(JSON.stringify(payload), {
				headers: {
					'content-type': 'application/json; charset=utf-8',
					// The stale ceiling, not the freshness window — see the note
					// at the top of this file.
					'cache-control': `max-age=${CALENDAR_MAX_STALE_SECONDS}`
				}
			})
		);
	} catch (cause) {
		// A cache that will not hold the payload costs a round trip per view.
		console.error('calendar: caching the payload failed.', cause);
	}
}

export type ReadCalendarOptions = {
	detail: VisibleCalendarDetail;
	horizonDays: number;
	cache: Cache | null;
	/** The live read. Called only on a miss or an expiry, never on a hit. */
	load: () => Promise<CalendarPayload>;
	now?: number;
};

/**
 * One variant, from the cache if it is fresh and from Google if it is not.
 *
 * Serve-stale-on-error is the second half of plan §4's caching story: a
 * calendar that breaks because Google hiccuped is worse than a slightly stale
 * one, so an upstream failure falls back to the last good payload and reports
 * its age for the page to say "last updated N minutes ago". Past six hours
 * that stops being true enough to show and the answer becomes `unavailable`.
 */
export async function readCalendar(options: ReadCalendarOptions): Promise<CalendarView> {
	const { detail, horizonDays, cache, load } = options;
	const now = options.now ?? Date.now();
	const key = calendarCacheKey(detail, horizonDays);

	const cached = await readCached(cache, key, detail, horizonDays);
	// Clamped, so a payload stamped in the future by a skewed clock reads as
	// brand new rather than as a negative age nothing else expects.
	const cachedAge = cached
		? Math.max(0, (now - cached.fetchedAt) / 1000)
		: Number.POSITIVE_INFINITY;

	if (cached && cachedAge < CALENDAR_FRESH_SECONDS) {
		return { status: 'fresh', payload: cached, ageSeconds: Math.round(cachedAge) };
	}

	try {
		const payload = await load();
		await writeCached(cache, key, payload);
		return {
			status: 'fresh',
			payload,
			ageSeconds: Math.max(0, Math.round((now - payload.fetchedAt) / 1000))
		};
	} catch (cause) {
		console.error(`calendar: the live read for ${detail}/${horizonDays}d failed.`, cause);

		if (cached && cachedAge <= CALENDAR_MAX_STALE_SECONDS) {
			return { status: 'stale', payload: cached, ageSeconds: Math.round(cachedAge) };
		}

		return { status: 'unavailable' };
	}
}
