import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { SIGNIN_PATH } from '../auth';
import { PUBLIC_TIER_RANK, type TierSlug } from '../db/schema';
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
 * The three answers this codebase gives to "may this viewer read this?".
 *
 * `unauthenticated` and `forbidden` are kept apart all the way down because
 * the two callers turn them into different things: a page redirects the first
 * to `/signin` and 403s the second, while a media subresource answers 401 and
 * 403 respectively — an `<img>` cannot follow a login flow, so redirecting it
 * would show a broken image where a diagnosable status belongs.
 */
export type AccessDecision = 'allow' | 'unauthenticated' | 'forbidden';

/**
 * The comparison. Every access decision in the system — pages via
 * `requireTier`, media bytes via `/m/[assetId]/[variant]` — comes out of this
 * one function, so there is exactly one place where "may read" is defined and
 * no second, subtly different copy of it to drift.
 *
 * Every branch is written so that an unexpected value refuses:
 *   - no viewer at all means `handle` did not run. That is a broken
 *     deployment, not an anonymous visitor, and signing in would not fix it.
 *   - `requiredRank` is compared with a failed `<=` / `>=` rather than `<`,
 *     so `NaN` — which compares false against everything — refuses. Callers
 *     pass `Infinity` for "this should not have been reachable".
 *   - only a rank of exactly `PUBLIC_TIER_RANK` is readable without a session.
 */
export function accessDecisionFor(
	viewer: Viewer | undefined,
	requiredRank: number
): AccessDecision {
	if (!viewer) return 'forbidden';
	if (!viewer.signedIn && !(requiredRank <= PUBLIC_TIER_RANK)) return 'unauthenticated';
	if (!(viewer.rank >= requiredRank)) return 'forbidden';
	return 'allow';
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

	switch (accessDecisionFor(viewer, rankRequiredFor(minTierSlug))) {
		case 'unauthenticated':
			redirect(302, signinRedirectTarget(event.url));
			break;
		case 'forbidden':
			error(403, { code: NO_ACCESS, message: 'No access.', email: viewer?.email ?? null });
	}

	return viewer;
}
