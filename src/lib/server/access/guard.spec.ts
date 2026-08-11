import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { accessDecisionFor, NO_ACCESS, requireTier } from './guard';
import { TIER_RANK } from './tiers';
import { ANONYMOUS_VIEWER, type Viewer } from './viewer';

/**
 * `requireTier` is the only thing standing between a stranger and private
 * data, so these cases are written as "what happens when the input is wrong"
 * rather than "does the happy path work".
 */

function eventFor(viewer: Viewer | undefined, path = '/private/photos?a=1'): RequestEvent {
	return { locals: { viewer }, url: new URL(path, 'https://example.test') } as RequestEvent;
}

const viewerAt = (rank: number, overrides: Partial<Viewer> = {}): Viewer => ({
	signedIn: true,
	userId: 'user_1',
	email: 'someone@example.test',
	tierSlug: null,
	rank,
	...overrides
});

/** Runs the guard and returns whatever it threw, or `null` if it allowed. */
function refusalFrom(event: RequestEvent, slug: Parameters<typeof requireTier>[1]) {
	try {
		requireTier(event, slug);
		return null;
	} catch (thrown) {
		return thrown;
	}
}

describe('requireTier', () => {
	it('lets a viewer at exactly the required rank through, and returns them', () => {
		const viewer = viewerAt(TIER_RANK.family, { tierSlug: 'family' });

		expect(requireTier(eventFor(viewer), 'family')).toBe(viewer);
	});

	it('lets a higher tier through', () => {
		expect(requireTier(eventFor(viewerAt(TIER_RANK.owner)), 'friend').rank).toBe(100);
	});

	it('sends a signed-out visitor to /signin with the path they asked for', () => {
		const refusal = refusalFrom(eventFor(ANONYMOUS_VIEWER), 'friend');

		expect(isRedirect(refusal)).toBe(true);
		expect(refusal).toMatchObject({
			status: 302,
			location: '/signin?next=%2Fprivate%2Fphotos%3Fa%3D1'
		});
	});

	it('403s a signed-in visitor whose tier is too low, and names their account', () => {
		const refusal = refusalFrom(
			eventFor(viewerAt(TIER_RANK.friend, { tierSlug: 'friend' })),
			'family'
		);

		expect(isHttpError(refusal)).toBe(true);
		expect(refusal).toMatchObject({
			status: 403,
			body: { code: NO_ACCESS, email: 'someone@example.test' }
		});
	});

	it('403s rather than redirects, so an authenticated visitor cannot be put in a sign-in loop', () => {
		const refusal = refusalFrom(eventFor(viewerAt(TIER_RANK.public)), 'friend');

		expect(isRedirect(refusal)).toBe(false);
		expect(refusal).toMatchObject({ status: 403 });
	});

	it('refuses a rank that is not a number rather than letting the comparison pass', () => {
		for (const rank of [Number.NaN, undefined as unknown as number, null as unknown as number]) {
			const refusal = refusalFrom(eventFor(viewerAt(rank)), 'friend');

			expect(refusal, String(rank)).toMatchObject({ status: 403 });
		}
	});

	it('refuses when the hook did not run, instead of treating it as signed out', () => {
		const refusal = refusalFrom(eventFor(undefined), 'friend');

		// A redirect here would loop forever against a broken deployment.
		expect(isRedirect(refusal)).toBe(false);
		expect(refusal).toMatchObject({ status: 403, body: { code: NO_ACCESS } });
	});

	it('refuses everyone when the required tier is a slug that does not exist', () => {
		const refusal = refusalFrom(eventFor(viewerAt(TIER_RANK.owner)), 'familly' as never);

		expect(refusal).toMatchObject({ status: 403 });
	});
});

/**
 * The comparison underneath both `requireTier` and `/m/[assetId]/[variant]`.
 * The media route needs the three answers kept apart — it turns
 * `unauthenticated` into 401 rather than a redirect — so they are tested here
 * rather than only through the page guard's redirect/403 translation.
 */
describe('accessDecisionFor', () => {
	it('allows a viewer at or above the required rank', () => {
		expect(accessDecisionFor(viewerAt(TIER_RANK.family), TIER_RANK.family)).toBe('allow');
		expect(accessDecisionFor(viewerAt(TIER_RANK.owner), TIER_RANK.family)).toBe('allow');
	});

	it('lets a stranger read something genuinely public', () => {
		expect(accessDecisionFor(ANONYMOUS_VIEWER, TIER_RANK.public)).toBe('allow');
	});

	it('separates "no session" from "not enough tier"', () => {
		expect(accessDecisionFor(ANONYMOUS_VIEWER, TIER_RANK.family)).toBe('unauthenticated');
		expect(accessDecisionFor(viewerAt(TIER_RANK.friend), TIER_RANK.family)).toBe('forbidden');
	});

	it('refuses a required rank that is not a number, whoever is asking', () => {
		for (const required of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(accessDecisionFor(viewerAt(TIER_RANK.owner), required), String(required)).toBe(
				'forbidden'
			);
		}
	});

	it('does not send a stranger to sign in for something nobody can read', () => {
		// An unknown asset id resolves to `Infinity`, and a signed-out request
		// for one must look exactly like a signed-out request for a real
		// private asset: 401, not a redirect and not a 404.
		expect(accessDecisionFor(ANONYMOUS_VIEWER, Number.POSITIVE_INFINITY)).toBe('unauthenticated');
	});

	it('refuses when the hook did not run at all', () => {
		expect(accessDecisionFor(undefined, TIER_RANK.public)).toBe('forbidden');
	});

	it('refuses a viewer whose own rank is not a number', () => {
		expect(accessDecisionFor(viewerAt(Number.NaN), TIER_RANK.friend)).toBe('forbidden');
	});
});
