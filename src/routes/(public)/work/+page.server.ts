import { getPublicPage, listPublicProjects } from '$lib/server/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => {
	const [page, projects] = await Promise.all([
		getPublicPage(platform, 'work'),
		listPublicProjects(platform)
	]);

	return { page, projects };
};
