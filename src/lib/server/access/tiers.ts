import { OWNER_TIER_RANK, PUBLIC_TIER_RANK, TIER_SLUGS, type TierSlug } from '../db/schema';

/**
 * Rank per tier slug, mirroring the seed rows in `drizzle/0000_tier.sql`.
 *
 * The `tier` table stays the authority for a *viewer's* rank — `resolveViewer`
 * reads it back through a join, so a rank changed in the database takes effect
 * without a deploy. This map is the other half: what a route *demands*, which
 * has to be answerable without a query so `requireTier('family')` is a
 * comparison rather than a round trip.
 *
 * The two are kept honest by `tiers.spec.ts`, which parses the migration and
 * fails if they drift.
 */
export const TIER_RANK: Readonly<Record<TierSlug, number>> = Object.freeze({
	public: PUBLIC_TIER_RANK,
	friend: 10,
	family: 20,
	partner: 30,
	owner: OWNER_TIER_RANK
});

/**
 * The rank a route demands, resolved from a slug that may not be one.
 *
 * A slug this map does not know is not "public by default" — it is a typo in a
 * guard call, and the only safe reading of a guard nobody can satisfy is that
 * nobody may pass. Hence `Infinity` rather than a fallback tier: even `owner`
 * is refused, so the mistake shows up as a locked page rather than an open one.
 */
export function rankRequiredFor(slug: TierSlug): number {
	const rank = TIER_RANK[slug];
	return typeof rank === 'number' && Number.isFinite(rank) ? rank : Number.POSITIVE_INFINITY;
}

/**
 * Validates one row of the `access_grant` ⨝ `tier` join.
 *
 * Returns `null` — meaning no tier, i.e. public — for anything the database
 * should not have contained: an unknown slug, a NULL or non-integer rank, a
 * negative rank. There is deliberately no branch here that turns an unexpected
 * value into access; the only way out of this function with a rank is for both
 * halves of the row to be exactly what they should be.
 */
export function resolveGrantedTier(
	slug: unknown,
	rank: unknown
): { slug: TierSlug; rank: number } | null {
	if (typeof slug !== 'string' || !(TIER_SLUGS as readonly string[]).includes(slug)) return null;
	if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < PUBLIC_TIER_RANK) return null;

	return { slug: slug as TierSlug, rank };
}
