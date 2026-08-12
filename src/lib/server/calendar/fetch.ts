import {
	getAccessToken,
	type MintOptions,
	type ServiceAccountCredentials
} from '../google/sa-token';
import {
	redactEvents,
	type CalendarPayload,
	type GoogleCalendarEvent,
	type VisibleCalendarDetail
} from './redact';

/**
 * The Google Calendar read (plan §4). One window, fully paginated, handed
 * straight to `redact.ts` — nothing in this file caches and nothing in it
 * decides what a tier may see.
 *
 * Two decisions here are consequences of the 365-day partner horizon and are
 * both easy to get wrong in a way that looks fine:
 *
 *  - **Pagination is mandatory.** A year of a real calendar with recurring
 *    events expanded comfortably exceeds `maxResults=250`, and Google
 *    truncates by handing back a `nextPageToken` rather than by erroring. A
 *    single-page fetch renders a calendar that looks correct and is missing
 *    its far end — the worst failure mode available here.
 *  - **Each horizon band fetches its own window.** The cache key includes the
 *    horizon, so the 30-day and 90-day variants ask Google for 30 and 90 days.
 *    Fetching a year once and slicing it would put a year of Caden's movements
 *    in Worker memory on every request path, and it makes the redact-first
 *    guarantee much harder to audit.
 */

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/calendars';

/** Google's maximum, and what plan §4 specifies. */
const MAX_RESULTS = 250;

/**
 * 2,500 events. Past this the fetch stops and marks the payload `truncated`
 * rather than looping — an unbounded follow of `nextPageToken` against a
 * misbehaving upstream is the one way this code could burn the CPU budget.
 */
const MAX_PAGES = 10;

/** `timeMin = now - 1d`, so an event running across midnight is still shown. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CalendarWindow = { timeMin: Date; timeMax: Date };

/**
 * The window one horizon band asks for. Throws on a horizon that is not a
 * positive whole number of days: the value comes from `tier`, and a NULL or
 * hand-edited row must not silently become "fetch nothing" or "fetch forever".
 */
export function horizonWindow(horizonDays: number, now: number): CalendarWindow {
	if (!Number.isInteger(horizonDays) || horizonDays <= 0) {
		throw new Error(`calendar: ${horizonDays} is not a usable horizon in days.`);
	}

	return {
		timeMin: new Date(now - LOOKBACK_MS),
		timeMax: new Date(now + horizonDays * DAY_MS)
	};
}

export type CalendarFetchResult = {
	events: GoogleCalendarEvent[];
	/** The calendar's own zone, or `UTC` if Google did not name one. */
	timeZone: string;
	truncated: boolean;
};

export type FetchEventsOptions = {
	calendarId: string;
	accessToken: string;
	horizonDays: number;
	now?: number;
	fetch?: typeof fetch;
};

/**
 * Every event in the window, following `nextPageToken` to the end.
 *
 * Throws on anything that is not a 2xx carrying an `items` array. That
 * includes the 404 the API returns today, before Caden has shared his calendar
 * with the service account — the caller turns a throw into "serve the last
 * good payload, or say the calendar is unavailable", which is the specified
 * behaviour and not a fallback that hides the error.
 */
export async function fetchCalendarEvents(
	options: FetchEventsOptions
): Promise<CalendarFetchResult> {
	const fetchImpl = options.fetch ?? fetch;
	const { timeMin, timeMax } = horizonWindow(options.horizonDays, options.now ?? Date.now());

	const events: GoogleCalendarEvent[] = [];
	let timeZone = 'UTC';
	let pageToken: string | undefined;
	let pages = 0;

	do {
		const url = new URL(`${CALENDAR_API_BASE}/${encodeURIComponent(options.calendarId)}/events`);
		url.searchParams.set('timeMin', timeMin.toISOString());
		url.searchParams.set('timeMax', timeMax.toISOString());
		// Recurring events are expanded by the API; plan §4 forbids hand-rolled
		// RRULE expansion, and `orderBy=startTime` requires this flag anyway.
		url.searchParams.set('singleEvents', 'true');
		url.searchParams.set('orderBy', 'startTime');
		url.searchParams.set('showDeleted', 'false');
		url.searchParams.set('maxResults', String(MAX_RESULTS));
		if (pageToken) url.searchParams.set('pageToken', pageToken);

		const response = await fetchImpl(url.toString(), {
			headers: { authorization: `Bearer ${options.accessToken}` }
		});

		if (!response.ok) {
			// The status only — an error body from Google can echo the request.
			throw new Error(`calendar: the events endpoint answered ${response.status}.`);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new Error('calendar: the events endpoint returned a body that is not JSON.');
		}

		const page = body as { items?: unknown; timeZone?: unknown; nextPageToken?: unknown };
		if (!Array.isArray(page.items)) {
			throw new Error('calendar: the events response carried no items array.');
		}

		events.push(...(page.items as GoogleCalendarEvent[]));
		if (typeof page.timeZone === 'string' && page.timeZone.length > 0) timeZone = page.timeZone;

		pageToken =
			typeof page.nextPageToken === 'string' && page.nextPageToken.length > 0
				? page.nextPageToken
				: undefined;
		pages += 1;
	} while (pageToken && pages < MAX_PAGES);

	if (pageToken) {
		console.warn(
			`calendar: stopped at the ${MAX_PAGES}-page cap with ${events.length} events; ` +
				'the far end of this window is missing.'
		);
	}

	return { events, timeZone, truncated: pageToken !== undefined };
}

export type LoadPayloadOptions = MintOptions & {
	credentials: ServiceAccountCredentials;
	calendarId: string;
	detail: VisibleCalendarDetail;
	horizonDays: number;
	/** Cache for the *access token*. Payload caching is `cache.ts`'s job. */
	tokenCache?: Cache | null;
};

/**
 * Token, fetch, redact — the whole live read for one variant.
 *
 * This is the function `cache.ts` calls on a miss. It is deliberately the only
 * place the three halves meet, so there is no route through which a raw event
 * list reaches anything but `redactEvents`.
 */
export async function loadCalendarPayload(options: LoadPayloadOptions): Promise<CalendarPayload> {
	const now = options.now ?? Date.now();

	const accessToken = await getAccessToken({
		credentials: options.credentials,
		cache: options.tokenCache,
		fetch: options.fetch,
		now
	});

	const { events, timeZone, truncated } = await fetchCalendarEvents({
		calendarId: options.calendarId,
		accessToken,
		horizonDays: options.horizonDays,
		now,
		fetch: options.fetch
	});

	return redactEvents(events, {
		detail: options.detail,
		horizonDays: options.horizonDays,
		timeZone,
		fetchedAt: now,
		truncated,
		selfEmail: options.calendarId
	});
}
