import { UNVERIFIED_EMAIL_CODE } from '$lib/server/auth';
import { safeRedirectTarget } from '$lib/server/redirect-target';
import type { PageServerLoad } from './$types';

/**
 * Not prerendered, and not prerenderable — the root layout load reads the
 * session, so this page is server-rendered per request like everything else
 * (plan §2, the Static Assets footgun).
 */
export const prerender = false;

/**
 * Copy for the `?error=` codes the OAuth callback can come back with. Anything
 * unrecognised falls through to a generic line rather than being echoed to the
 * page: the value arrives in the URL and printing it verbatim is an injection
 * of somebody else's words into Caden's site.
 */
const ERROR_MESSAGES: Record<string, string> = {
	[UNVERIFIED_EMAIL_CODE]:
		'Google has not verified the email address on that account, so it cannot be used to sign in here. Verify the address with Google, or use a different account.',
	PROVIDER_UNAVAILABLE: 'Google sign-in is not configured correctly right now.',
	access_denied: 'You cancelled the Google sign-in.',
	state_mismatch: 'That sign-in attempt expired or was interrupted. Please try again.',
	state_not_found: 'That sign-in attempt expired or was interrupted. Please try again.'
};

const GENERIC_ERROR = 'Something went wrong signing you in. Please try again.';

export const load: PageServerLoad = ({ url }) => {
	const code = url.searchParams.get('error');

	return {
		next: safeRedirectTarget(url.searchParams.get('next')),
		errorMessage: code ? (ERROR_MESSAGES[code] ?? GENERIC_ERROR) : null
	};
};
