import { error } from '@sveltejs/kit';
import { NO_ACCESS, requireTier } from '$lib/server/access/guard';
import { getMemory } from '$lib/server/media/gallery';
import type { PageServerLoad } from './$types';

/**
 * One memory (M6.2).
 *
 * Two checks, and the second is the one that matters. `requireTier` applies
 * the route table's floor for `/private/memories`; then the query is filtered
 * by the viewer's own rank, so a memory published at `partner` simply is not
 * found for a family session.
 *
 * **All three misses are the same 403**: no such slug, a draft, and a tier too
 * low are byte-identical answers. A 404 for the first would let anyone with a
 * family grant enumerate which memories exist above their tier by watching the
 * status code change — plan §2's "do not leak existence", applied to a route
 * whose slugs are guessable words.
 */
export const load: PageServerLoad = async (event) => {
	const viewer = requireTier(event, 'family');

	const memory = await getMemory(event.platform, event.params.slug, viewer.rank);
	if (!memory) {
		error(403, { code: NO_ACCESS, message: 'No access.', email: viewer.email });
	}

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		memory
	};
};
