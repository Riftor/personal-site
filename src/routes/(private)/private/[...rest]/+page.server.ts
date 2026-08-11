import { error } from '@sveltejs/kit';
import { requireTier } from '$lib/server/access/guard';
import type { PageServerLoad } from './$types';

/**
 * Every `/private/*` URL that matches no real page.
 *
 * Without this, an unknown private path would fall through to SvelteKit's
 * 404 — which is a different answer from the 403 a known-but-forbidden path
 * gives, and the difference is an oracle: a signed-in visitor could walk the
 * private half by watching which guesses 404 and which 403. Plan §2 is
 * explicit that the refusal must be identical either way, so this route makes
 * every unknown private path answer exactly as a forbidden one does.
 *
 * `owner` is the right requirement because it is what the route table's
 * default-deny says an unlisted private path costs. The 404 below is therefore
 * only ever seen by Caden, who is the one person for whom "this page does not
 * exist" is useful rather than informative.
 */
export const load: PageServerLoad = (event) => {
	requireTier(event, 'owner');

	error(404, 'That private page does not exist.');
};
