import type { RequestEvent } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import { createAuth } from '../auth';
import { getDb } from '../db';
import { accessGrant, PUBLIC_TIER_RANK, tier, type TierSlug } from '../db/schema';
import { resolveGrantedTier } from './tiers';

/**
 * Layer 0 of plan §2: who is asking, and what may they read.
 *
 * Resolved once per request in `hooks.server.ts` and carried on
 * `event.locals.viewer`. Two properties are load-bearing:
 *
 * 1. The grant comes from `access_grant` on **every** request, never from the
 *    session row and never from the cookie. That is the whole revocation
 *    story — `pnpm access:revoke` takes effect on the visitor's next page
 *    load rather than in thirty days. What the grant is *worth* is a separate
 *    question, answered by `TIER_RANK` in code since plan §8.6: which tier
 *    somebody is in is live, what a tier means is a deploy.
 * 2. Every path out of here that is not "a session, an email, and a live
 *    grant naming a real tier" lands on `rank: 0`. There is no branch in this
 *    file where an unexpected value means "allow".
 */
export type Viewer = {
	/** Whether Google has told us who this is. Distinct from having access. */
	signedIn: boolean;
	userId: string | null;
	/** Lowercased, because `access_grant.email` is stored lowercased. */
	email: string | null;
	/** The tier the live grant names, or `null` for "no grant at all". */
	tierSlug: TierSlug | null;
	/** What this viewer may read. 0 is the public site and nothing more. */
	rank: number;
};

/** A stranger, and the fallback for every failure in this file. */
export const ANONYMOUS_VIEWER: Viewer = Object.freeze({
	signedIn: false,
	userId: null,
	email: null,
	tierSlug: null,
	rank: PUBLIC_TIER_RANK
});

/**
 * `access_grant.email` is written lowercased by the CLI, so the lookup
 * lowercases too. Google normalises the addresses it returns, but "the
 * addresses agree because the identity provider is tidy" is not a control.
 *
 * Note the query below compares the column as-is rather than wrapping it in
 * `lower()`. That keeps the partial index usable, and it errs the safe way: a
 * hand-inserted row with a capital letter in it grants nothing, where
 * `lower(email)` would make it grant something nobody typed deliberately.
 */
function normaliseEmail(email: unknown): string | null {
	if (typeof email !== 'string') return null;
	const normalised = email.trim().toLowerCase();
	return normalised.includes('@') ? normalised : null;
}

/**
 * A transient D1 or Better Auth failure must not be readable as "signed in" —
 * so it reads as "signed out", which costs a public visitor nothing and costs
 * a private one a trip through `/signin`.
 */
async function readSession(event: RequestEvent) {
	try {
		return await createAuth(event.platform, event.url.origin, event.request.headers).api.getSession(
			{ headers: event.request.headers }
		);
	} catch (cause) {
		console.error('access: session lookup failed, treating the request as signed out.', cause);
		return null;
	}
}

/**
 * The live grant for an address, joined to `tier` to prove the tier exists.
 *
 * `revoked_at IS NULL` is what makes a soft-revoked row inert, and the join is
 * an inner one on purpose: a grant naming a tier that no longer exists yields
 * no row, which is the same as no grant. A failed query is also no grant.
 *
 * The slug is all that is selected. Since plan §8.6 the rank comes from
 * `TIER_RANK` in code rather than from `tier.rank`, so selecting the column
 * would be selecting a value nothing is allowed to trust — see
 * `resolveGrantedTier`.
 */
async function readGrant(event: RequestEvent, email: string) {
	const d1 = event.platform?.env?.DB;
	if (!d1) {
		console.error('access: the D1 binding DB is missing; no grant can be resolved.');
		return null;
	}

	try {
		const [row] = await getDb(d1)
			.select({ slug: tier.slug })
			.from(accessGrant)
			.innerJoin(tier, eq(tier.slug, accessGrant.tierSlug))
			.where(and(eq(accessGrant.email, email), isNull(accessGrant.revokedAt)))
			.limit(1);

		return row ? resolveGrantedTier(row.slug) : null;
	} catch (cause) {
		console.error('access: grant lookup failed, resolving this request as public.', cause);
		return null;
	}
}

/** Resolves `locals.viewer` for one request. Called only from `handle`. */
export async function resolveViewer(event: RequestEvent): Promise<Viewer> {
	const session = await readSession(event);
	const email = normaliseEmail(session?.user?.email);

	if (!session?.user?.id || !email) return ANONYMOUS_VIEWER;

	const signedInViewer: Viewer = {
		signedIn: true,
		userId: session.user.id,
		email,
		tierSlug: null,
		rank: PUBLIC_TIER_RANK
	};

	// Signed in with no grant is not a pending state and not an error: it is
	// simply the public tier, and it renders the same 403 as too low a tier.
	const granted = await readGrant(event, email);
	if (!granted) return signedInViewer;

	return { ...signedInViewer, tierSlug: granted.slug, rank: granted.rank };
}
