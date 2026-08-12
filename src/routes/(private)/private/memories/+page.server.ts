import { requireTier } from '$lib/server/access/guard';
import { listMemories } from '$lib/server/media/gallery';
import type { PageServerLoad } from './$types';

/**
 * The memory index (M6.2). `requireTier` first, then the viewer's rank into
 * the query: a memory published at `partner` is absent from a family session's
 * result set, not hidden by the template.
 *
 * `family` here is the route table's floor for `/private/memories`, and the
 * per-entry `min_tier_rank` does the rest. See `routes.ts`.
 */
export const load: PageServerLoad = async (event) => {
	const viewer = requireTier(event, 'family');

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		memories: await listMemories(event.platform, viewer.rank)
	};
};
