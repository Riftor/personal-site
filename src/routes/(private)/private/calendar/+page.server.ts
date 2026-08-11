import { requireTier } from '$lib/server/access/guard';
import type { PageServerLoad } from './$types';

/**
 * Stub for M3. The live calendar — a service-account fetch, redacted per tier
 * *before* it is cached — is M5. The tier here gates the page; §4's
 * `tier.calendar_detail` will separately gate how much of each event is shown,
 * which is a second decision this stub does not pretend to make.
 */
export const load: PageServerLoad = (event) => {
	const viewer = requireTier(event, 'partner');

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		timezone: 'Europe/London',
		blocks: [
			{ when: '[PLACEHOLDER] Thu 13 Aug, 09:00–10:30', label: 'Busy' },
			{ when: '[PLACEHOLDER] Fri 14 Aug, 19:00–22:00', label: 'Busy' }
		]
	};
};
