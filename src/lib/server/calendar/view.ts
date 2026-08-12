import { openTokenCache, readServiceAccountCredentials } from '../google/sa-token';
import { openCalendarCache, readCalendar, type CalendarView } from './cache';
import type { VisibleCalendarDetail } from './redact';
import { loadCalendarPayload } from './fetch';

/**
 * The one entry point everything above the calendar layer uses: a tier's
 * detail level and horizon in, a `CalendarView` out. The page, and the cron
 * warmer, both go through here so there is a single composition of
 * credential → token → fetch → redact → cache and no second copy to drift.
 */

export type CalendarViewOptions = {
	env: Partial<Env> | undefined;
	detail: VisibleCalendarDetail;
	horizonDays: number;
	/** Injected by the tests; both default to the ambient ones. */
	now?: number;
	fetch?: typeof fetch;
	cache?: Cache | null;
	tokenCache?: Cache | null;
};

/**
 * A `CalendarView` for one variant.
 *
 * A missing or placeholder credential is expressed as a `load` that throws
 * rather than as an early return, and that is on purpose: it means the same
 * serve-stale path handles it as handles Google being down, so a warmed
 * payload is still shown while Caden is rotating a key. It never *invents* a
 * payload — with nothing cached the answer is `unavailable`.
 */
export async function calendarViewFor(options: CalendarViewOptions): Promise<CalendarView> {
	const { env, detail, horizonDays } = options;
	const now = options.now ?? Date.now();
	const calendarId = typeof env?.CALENDAR_ID === 'string' ? env.CALENDAR_ID.trim() : '';

	const cache = options.cache !== undefined ? options.cache : await openCalendarCache();
	const tokenCache = options.tokenCache !== undefined ? options.tokenCache : await openTokenCache();

	return readCalendar({
		detail,
		horizonDays,
		cache,
		now,
		load: async () => {
			const credentials = readServiceAccountCredentials(env);
			if (!credentials) throw new Error('calendar: no usable service-account credential.');
			if (!calendarId.includes('@')) throw new Error('calendar: CALENDAR_ID is not set.');

			return loadCalendarPayload({
				credentials,
				calendarId,
				detail,
				horizonDays,
				now,
				fetch: options.fetch,
				tokenCache
			});
		}
	});
}
