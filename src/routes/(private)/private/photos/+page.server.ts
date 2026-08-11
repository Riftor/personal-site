import { requireTier } from '$lib/server/access/guard';
import { listPhotoSets } from '$lib/server/media/gallery';
import type { PageServerLoad } from './$types';

/**
 * The gallery (M4.4). `requireTier` is the first statement, as it is in every
 * loader under `(private)/`, and the rank it returns is then passed down into
 * the query — so the page cannot list a set or a photo above the viewer's
 * tier even by accident.
 *
 * Nothing here mints a URL that grants anything. `/m/[assetId]/[variant]` is
 * an ordinary path; what makes it readable is the session cookie the browser
 * already has, re-checked against the asset on every fetch.
 */
export const load: PageServerLoad = async (event) => {
	const viewer = requireTier(event, 'family');

	return {
		viewer: { email: viewer.email, tierSlug: viewer.tierSlug },
		sets: await listPhotoSets(event.platform, viewer.rank)
	};
};
