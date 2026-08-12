import { error } from '@sveltejs/kit';
import { NO_ACCESS, requireTier } from '$lib/server/access/guard';
import { calendarGrantFor } from '$lib/server/calendar/access';
import {
	agoLabel,
	buildAgenda,
	clockLabel,
	horizonEndLabel,
	usableTimeZone
} from '$lib/server/calendar/agenda';
import { calendarViewFor } from '$lib/server/calendar/view';
import type { PageServerLoad } from './$types';

/**
 * The live calendar (M5.5, plan §4).
 *
 * Two independent gates, in this order and for different reasons:
 *
 *  1. `requireTier` — layer 2 of plan §2, and the only thing that tells a
 *     stranger apart from a signed-in visitor without enough tier. It asks
 *     for `friend` because `friend` is the lowest tier the seed grants a
 *     calendar to; it is a floor, not the answer.
 *  2. `calendarGrantFor` — the tier's own `calendar_detail` and
 *     `calendar_horizon_days`, read from D1 on this request. This is the real
 *     gate. `none`, a missing row, or anything malformed refuses, and refuses
 *     with the *same* `error(403, …)` shape as every other refusal in the
 *     private half, so a visitor cannot tell "your tier has no calendar" from
 *     "that page does not exist".
 *
 * Nothing a visitor sends can reach either decision. There is no query string,
 * no header and no cookie read here; the detail level and the horizon come
 * from the `tier` row and from nowhere else.
 *
 * Redaction is not repeated here. The payload arrives already reduced to its
 * tier by `redact.ts` — the page renders what it is handed, and re-deriving
 * detail at render time would be a second copy of the rule to drift.
 */

/**
 * Only used when the calendar cannot be read at all, so no times are being
 * shown and this labels nothing. Whenever there is a payload, Google's own
 * zone for the calendar wins — see `CalendarPayload.timeZone`.
 */
const FALLBACK_HOME_TIME_ZONE = 'Europe/London';

/** What each detail level actually shows, said plainly on the page. */
const DETAIL_CAPTION = {
	busy: 'Busy blocks only. No titles, locations, or descriptions at your tier.',
	titles: 'Event titles. No locations or descriptions at your tier.',
	full: 'Titles, locations, and descriptions.'
} as const;

export const load: PageServerLoad = async (event) => {
	const viewer = requireTier(event, 'friend');

	const grant = await calendarGrantFor(event.platform, viewer.tierSlug);
	if (!grant) {
		error(403, { code: NO_ACCESS, message: 'No access.', email: viewer.email });
	}

	const view = await calendarViewFor({
		env: event.platform?.env,
		detail: grant.detail,
		horizonDays: grant.horizonDays
	});

	const now = Date.now();
	const payload = view.status === 'unavailable' ? null : view.payload;
	const timeZone = usableTimeZone(payload?.timeZone ?? FALLBACK_HOME_TIME_ZONE);

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		detail: grant.detail,
		detailCaption: DETAIL_CAPTION[grant.detail],
		horizonDays: grant.horizonDays,
		horizonEndsOn: horizonEndLabel(now, grant.horizonDays, timeZone),
		timeZone,
		status: view.status,
		/**
		 * Both of these were computed and cached by M5.4 and read by nothing
		 * until now. A view that quietly drops them is a confidently-complete
		 * calendar that is either out of date or missing its far end, which is
		 * the failure the pagination and serve-stale work existed to prevent.
		 */
		truncated: payload?.truncated === true,
		updatedAt: payload ? clockLabel(payload.fetchedAt, timeZone) : null,
		updatedAgo: view.status === 'unavailable' ? null : agoLabel(view.ageSeconds),
		weeks: payload ? buildAgenda(payload.blocks, timeZone) : []
	};
};
