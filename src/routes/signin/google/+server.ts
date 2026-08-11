import { redirectWithAuthCookies } from '$lib/server/auth-response';
import { SIGNIN_PATH, createAuth } from '$lib/server/auth';
import { safeRedirectTarget } from '$lib/server/redirect-target';
import type { RequestHandler } from './$types';

/**
 * Starts the Google flow. POST-only, because it mutates state (it writes an
 * OAuth state row and sets the matching signed cookie) and because a GET
 * endpoint that redirects to an identity provider is trivially embeddable in
 * someone else's page.
 */
export const POST: RequestHandler = async ({ request, url, platform }) => {
	const auth = createAuth(platform, url.origin);
	const next = safeRedirectTarget(new URL(request.url).searchParams.get('next'));

	const response = await auth.api.signInSocial({
		body: {
			provider: 'google',
			callbackURL: next,
			// A refused sign-in comes back to the page it started from, with
			// `?error=<code>` for the copy. Carrying `next` means a visitor who
			// fixes the problem still ends up where they were going.
			errorCallbackURL: `${SIGNIN_PATH}?next=${encodeURIComponent(next)}`
		},
		headers: request.headers,
		asResponse: true
	});

	const { url: authorizeURL } = (await response.json()) as { url?: string };
	if (!authorizeURL) {
		// Better Auth only omits the URL when the provider is misconfigured,
		// which is a deployment problem, not something the visitor can fix.
		return redirectWithAuthCookies(response, `${SIGNIN_PATH}?error=PROVIDER_UNAVAILABLE`);
	}

	return redirectWithAuthCookies(response, authorizeURL);
};
