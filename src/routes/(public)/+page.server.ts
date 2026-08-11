import { getPublicPage, listPublicProjects } from '$lib/server/content';
import type { PageServerLoad } from './$types';

/** How many projects the home page previews before sending you to /work. */
const FEATURED_COUNT = 3;

export const load: PageServerLoad = async ({ platform }) => {
	const [page, featured] = await Promise.all([
		getPublicPage(platform, 'home'),
		listPublicProjects(platform, FEATURED_COUNT)
	]);

	return { page, featured };
};
