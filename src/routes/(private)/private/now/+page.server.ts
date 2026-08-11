import { requireTier } from '$lib/server/access/guard';
import type { PageServerLoad } from './$types';

/**
 * Stub for M3. The real page reads the curated activity feed out of D1 in M6;
 * what matters now is the first line, which is the whole milestone: nothing
 * below it runs, and no field of the returned object is produced, unless the
 * viewer holds `friend` or better.
 *
 * The placeholder strings live here rather than in the component on purpose.
 * A `.svelte` file's markup is compiled into the client bundle whether or not
 * the page ever renders for you; data returned by a guarded loader is not, so
 * these lines exist nowhere a refused visitor can reach them.
 */
export const load: PageServerLoad = (event) => {
	const viewer = requireTier(event, 'friend');

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		updatedOn: '2026-08-04',
		items: [
			'[PLACEHOLDER] Learning to solder without burning the bench',
			'[PLACEHOLDER] Halfway through rewiring the workshop lighting',
			'[PLACEHOLDER] Reading the same three books in rotation'
		]
	};
};
