import { redirectWithAuthCookies } from '$lib/server/auth-response';
import { createAuth } from '$lib/server/auth';
import { DEFAULT_REDIRECT, safeRedirectTarget } from '$lib/server/redirect-target';
import type { RequestHandler } from './$types';

/**
 * Signs the visitor out. POST-only: a GET would let any page on the internet
 * sign a visitor out with an `<img>` tag, and browsers prefetch links.
 *
 * `auth.api.signOut` deletes the `session` row as well as clearing the cookie,
 * so the token is dead server-side even if a copy of it survives somewhere —
 * which is the whole reason sessions live in D1 rather than in a JWT
 * (plan §2).
 */
export const POST: RequestHandler = async ({ request, url, platform }) => {
	const auth = createAuth(platform, url.origin, request.headers);
	const next = safeRedirectTarget(new URL(request.url).searchParams.get('next'));

	const response = await auth.api.signOut({ headers: request.headers, asResponse: true });

	// Never bounce back to a page that required the session that was just
	// destroyed; `next` is only honoured when it is somewhere public.
	return redirectWithAuthCookies(response, next.startsWith('/private') ? DEFAULT_REDIRECT : next);
};
