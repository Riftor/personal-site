import { getPublicPage } from '$lib/server/content';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ platform }) => ({
	page: await getPublicPage(platform, 'about')
});
