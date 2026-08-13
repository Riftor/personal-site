import { redirect, type Handle } from '@sveltejs/kit';
import { signinRedirectTarget } from '$lib/server/access/guard';
import { requiredRankFor } from '$lib/server/access/routes';
import { resolveViewer } from '$lib/server/access/viewer';
import { PUBLIC_TIER_RANK } from '$lib/server/db/schema';
import { applySecurityHeaders } from '$lib/server/security-headers';

/**
 * The one choke point. `handle` runs before every server-side route with no
 * way around it, which is the property that picked SvelteKit for this site
 * (plan §1). It does three things, in this order:
 *
 *  1. Resolves `locals.viewer` — session, then live grant, then tier — so
 *     every loader downstream has an answer without repeating the query.
 *  2. Turns a signed-out request for a private path straight back at the door,
 *     before any loader runs.
 *  3. Backstops the loaders: if a path the route table says is private came
 *     back with a success status anyway, the response is thrown away and
 *     replaced with a bare 403.
 *
 * Step 3 is why the check is split around `resolve` instead of all happening
 * before it. Refusing up front would be simpler, but it would mean the hook
 * answered every unauthorized request and `(private)/+error.svelte` — the page
 * that tells a signed-in visitor *which account* they are using — would never
 * render. Putting the backstop after `resolve` lets the loader's own
 * `requireTier` produce the useful 403 in the normal case, while still making
 * a route that forgot to call it impossible to read.
 *
 * The one thing this file must never become is a cache. The tier is re-read
 * from `access_grant` on every request, and nothing about the viewer is ever
 * written to a cookie; that is what makes `pnpm access:revoke` take effect on
 * the next page load rather than in thirty days.
 *
 * It also stamps the security headers (plan §7.4) on the way out — every
 * response, page or media or refusal. The CSP is not among them: it is
 * `kit.csp` in `vite.config.ts`, because only Kit can nonce the script it
 * emits. See `$lib/server/security-headers` for the reasoning on each header.
 *
 * **One response escapes the stamp: the signed-out 302 below.** `redirect()`
 * throws, and Kit builds that response itself after `handle` has returned, so
 * there is no seam to reach it through. Rebuilding it here by hand would drop
 * the `Set-Cookie` headers Kit merges in afterwards and turn a form-action
 * redirect into the wrong shape, which is a poor trade for headers on a
 * body-less, same-origin 302: there is nothing to frame, nothing to script,
 * and the `/signin` page it lands on one hop later sends all of them.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const viewer = await resolveViewer(event);
	event.locals.viewer = viewer;

	const required = requiredRankFor(event.url.pathname);
	const isPrivatePath = required > PUBLIC_TIER_RANK;
	// A failed `>=`, so a NaN rank refuses rather than passes.
	const allowed = viewer.rank >= required;

	if (!allowed && !viewer.signedIn) {
		// Identical for a path that exists and one that does not, so probing
		// while signed out cannot enumerate the private half.
		redirect(302, signinRedirectTarget(event.url));
	}

	const response = await resolve(event);

	if (isPrivatePath) {
		// Private HTML must not sit in a shared cache, and the response varies
		// by session whatever its status.
		response.headers.set('cache-control', 'private, no-store');
		response.headers.append('vary', 'Cookie');
	}

	// A success here means the route table and the loaders disagree: either a
	// loader under `/private` is missing its `requireTier` call, or the path is
	// a spelling the table reads more strictly than the router does. Both are
	// worth a log and neither is worth a body — which is discarded unread
	// rather than streamed.
	if (!allowed && response.status < 300) {
		console.error(
			`access: ${event.url.pathname} returned ${response.status} to rank ${viewer.rank} ` +
				`(the route table requires ${required}). Refused by the hook instead.`
		);
		return applySecurityHeaders(refuse(), event.url);
	}

	return applySecurityHeaders(response, event.url);
};

/**
 * The backstop's refusal. Deliberately plain rather than the styled error
 * page: this fires only when a guard is missing, and it should look like the
 * bug it is.
 */
function refuse(): Response {
	return new Response('403 Forbidden\n', {
		status: 403,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'private, no-store',
			vary: 'Cookie'
		}
	});
}
