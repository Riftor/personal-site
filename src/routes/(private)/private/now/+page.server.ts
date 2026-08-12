import { requireTier } from '$lib/server/access/guard';
import { listActivity } from '$lib/server/activity';
import type { PageServerLoad } from './$types';

/**
 * The activity feed (M6.2). `requireTier` is the first statement, as it is in
 * every loader under `(private)/`, and the rank it returns is then passed into
 * the query — so a month published above the viewer's tier is not in the
 * result set, rather than being filtered out in the component.
 *
 * The M3 placeholder that used to live here is gone; this reads the entries
 * `pnpm run publish content/activity/2026-08.md` writes.
 */
export const load: PageServerLoad = async (event) => {
	const viewer = requireTier(event, 'friend');

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		months: await listActivity(event.platform, viewer.rank)
	};
};
