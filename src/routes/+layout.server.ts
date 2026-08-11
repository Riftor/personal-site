import { privateNavFor } from '$lib/server/access/routes';
import type { LayoutServerLoad } from './$types';

/**
 * Hands the masthead what it needs about the viewer, on every route.
 *
 * The session lookup that used to live here moved into `src/hooks.server.ts`
 * in M3 (plan §2, layer 0), so this is now a read of `locals.viewer` and no
 * longer a second trip to D1.
 *
 * Nothing here is an access decision. `privateNav` decides which links to
 * *draw*, which is a convenience; every page it points at refuses the request
 * on its own in `+page.server.ts`, and would refuse it identically if this
 * function returned every link to everybody.
 *
 * Note that this file existing at the root means no route can be prerendered
 * into a static asset by accident, which is the failure mode plan §2 calls the
 * Static Assets footgun.
 */
export const load: LayoutServerLoad = ({ locals }) => ({
	viewerEmail: locals.viewer.email,
	privateNav: privateNavFor(locals.viewer.rank)
});
