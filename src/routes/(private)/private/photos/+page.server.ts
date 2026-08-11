import { requireTier } from '$lib/server/access/guard';
import type { PageServerLoad } from './$types';

/**
 * Stub for M3. Real photo sets — R2 objects behind `/m/[assetId]/[variant]`,
 * each re-checking its own `min_tier_rank` on every byte fetched — land in M4.
 * As with `/private/now`, the guard is the first statement and the placeholder
 * copy lives in the loader so it never reaches the client bundle.
 */
export const load: PageServerLoad = (event) => {
	const viewer = requireTier(event, 'family');

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		sets: [
			{ title: '[PLACEHOLDER] Cornwall, July 2026', count: 24 },
			{ title: '[PLACEHOLDER] Family dinner, June 2026', count: 11 }
		]
	};
};
