import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { SIGNIN_PATH } from '../auth';
import type { TierSlug } from '../db/schema';
import { rankRequiredFor } from './tiers';
import type { Viewer } from './viewer';

/**
 * Layer 2 of plan §2, and the one that actually keeps people out.
 *
 * `requireTier` is the first statement of every loader and endpoint under
 * `src/routes/(private)/`. It sits on the data path: a page cannot be rendered
 * without its loader running, so unlike the route table in `routes.ts` and
 * unlike anything a `.svelte` file chooses to display, this cannot be routed
 * around. Hiding a nav link is not access control; this is.
 */

/** `App.Error.code` for the refusal `(private)/+error.svelte` renders. */
export const NO_ACCESS = 'NO_ACCESS';

/**
 * Where `/signin` should send a visitor back to. Same-origin and relative by
 * construction — it is built from this request's own path, never from input.
 */
export function signinRedirectTarget(url: URL): string {
	return `${SIGNIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`;
}

/**
 * Refuses the request unless the viewer holds at least `minTierSlug`.
 *
 * Signed out and signed-in-but-unauthorized are deliberately different
 * answers (plan §2): a stranger is sent to sign in, while somebody who is
 * already authenticated gets a 403 that names the account they are using.
 * Redirecting the second case would loop for a user who is already signed in
 * and hide the real problem, and 404ing it would be a lie.
 */
export function requireTier(event: RequestEvent, minTierSlug: TierSlug): Viewer {
	const viewer = event.locals.viewer;
	const required = rankRequiredFor(minTierSlug);

	// `handle` sets this on every request, so a missing viewer means the hook
	// did not run — a broken deployment, not an anonymous visitor. Refuse
	// rather than guess, and do not send them to `/signin`: signing in would
	// not fix it and the loop would hide the fault.
	if (!viewer) {
		error(403, { code: NO_ACCESS, message: 'No access.', email: null });
	}

	if (!viewer.signedIn) {
		redirect(302, signinRedirectTarget(event.url));
	}

	// Written as a failed `>=` rather than `<` so a NaN rank — which compares
	// false against everything — refuses instead of passing.
	if (!(viewer.rank >= required)) {
		error(403, { code: NO_ACCESS, message: 'No access.', email: viewer.email });
	}

	return viewer;
}
