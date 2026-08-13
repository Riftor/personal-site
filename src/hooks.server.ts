import { redirect, type Handle } from '@sveltejs/kit';
import { signinRedirectTarget } from '$lib/server/access/guard';
import { requiredRankFor } from '$lib/server/access/routes';
import { resolveViewer } from '$lib/server/access/viewer';
import { recordDenial } from '$lib/server/audit';
import { PUBLIC_TIER_RANK } from '$lib/server/db/schema';
import { httpsTransportFor } from '$lib/server/https-redirect';
import { applySecurityHeaders } from '$lib/server/security-headers';

/**
 * The one choke point. `handle` runs before every server-side route with no
 * way around it, which is the property that picked SvelteKit for this site
 * (plan §1). It does four things, in this order:
 *
 *  0. Answers the transport question before anything else happens: a cleartext
 *     request for this site's own hostname is 301'd to HTTPS, one naming any
 *     other hostname is refused with a bare 400, and loopback is served as it
 *     arrived. See `$lib/server/https-redirect` for why the Cloudflare zone
 *     setting is not enough on its own, and why the destination is an
 *     allowlist rather than the request's own `Host`.
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
 * and the `/signin` page it lands on one hop later sends all of them. Step 0's
 * two answers do *not* escape it — they are built here rather than thrown, so
 * there is a seam to stamp — though HSTS is not among what they get, because
 * `applySecurityHeaders` sends it only over HTTPS and both are answers to a
 * cleartext request.
 */
export const handle: Handle = async ({ event, resolve }) => {
	// Before the viewer, before `resolve`, before any query. A request that is
	// about to be discarded is not worth a round trip to D1, and a redirect
	// issued after the session cookie has already been read is a redirect that
	// arrived too late to have protected it.
	//
	// The response is built here rather than thrown through `redirect()`, so
	// that what goes on the wire is a `Location` this file wrote and nothing
	// else had an opinion about. The 400 carries no body worth reading and
	// above all does not name the host it refused: see `https-redirect.ts`.
	const transport = httpsTransportFor(event.url, event.platform?.env?.BETTER_AUTH_URL);

	if (transport.action === 'redirect') {
		return applySecurityHeaders(
			new Response(null, { status: 301, headers: { location: transport.location } }),
			event.url
		);
	}

	if (transport.action === 'refuse') {
		return applySecurityHeaders(
			new Response('400 Bad Request\n', {
				status: 400,
				headers: { 'content-type': 'text/plain; charset=utf-8' }
			}),
			event.url
		);
	}

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
	let answer = response;
	if (!allowed && response.status < 300) {
		console.error(
			`access: ${event.url.pathname} returned ${response.status} to rank ${viewer.rank} ` +
				`(the route table requires ${required}). Refused by the hook instead.`
		);
		answer = refuse();
	}

	// Every page-level refusal, whichever layer produced it: `requireTier` in a
	// loader, a per-entry rank inside a query, `calendar/access.ts`, or the
	// backstop above. Keying on the status rather than on `allowed` is what
	// catches the ones the route table alone cannot see — a family session
	// refused a partner-only memory clears `required` and is still a denial.
	// This runs after the answer is decided and changes nothing about it.
	if (isPrivatePath && answer.status === 403) {
		recordDenial(event.platform, event.request.headers, viewer, 'page');
	}

	return applySecurityHeaders(answer, event.url);
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
