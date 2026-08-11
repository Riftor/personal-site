import { createAuth } from '$lib/server/auth';
import type { LayoutServerLoad } from './$types';

/**
 * Resolves the signed-in email for the header, on every route.
 *
 * This is identity and nothing else: no tier, no rank, no access decision.
 * M3 moves the session lookup into `hooks.server.ts` and turns it into
 * `locals.viewer` so the guard can hang off it (plan §2, layer 0); until then
 * the only consumer is the masthead, and a layout load is the smallest thing
 * that serves it.
 *
 * Note that this file existing at the root means no route can be prerendered
 * into a static asset by accident, which is the failure mode plan §2 calls the
 * Static Assets footgun.
 */
export const load: LayoutServerLoad = async ({ request, url, platform }) => {
	const session = await createAuth(platform, url.origin).api.getSession({
		headers: request.headers
	});

	return { viewerEmail: session?.user.email ?? null };
};
