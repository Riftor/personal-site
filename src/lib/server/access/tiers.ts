import { OWNER_TIER_RANK, PUBLIC_TIER_RANK, TIER_SLUGS, type TierSlug } from '../db/schema';

/**
 * Rank per tier slug, mirroring the seed rows in `drizzle/0000_tier.sql`.
 *
 * **This map is the authority for every rank in the system, on both sides of
 * the comparison** — what a route demands *and* what a viewer holds. The
 * `tier.rank` column is no longer consulted for an access decision; see
 * `resolveGrantedTier` below before "fixing" that.
 *
 * The map and the table are kept honest by `tiers.spec.ts`, which parses the
 * migration and fails if they drift, and by the third copy in
 * `scripts/lib/tiers.mjs` that the publish CLIs read.
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
 * Validates one row of the `access_grant` ⨝ `tier` join, and answers what that
 * grant is worth.
 *
 * The slug is still read from D1 and still validated against the known set —
 * an unknown slug is not a tier and grants nothing. **The rank, though, comes
 * from `TIER_RANK` above rather than from the `tier.rank` column** (plan §8.6).
 *
 * That closes a drift the M5.5 review found. `routes.ts` resolves what a route
 * *demands* from `TIER_RANK`, because a guard has to answer without a query;
 * a viewer's rank used to be read live from the column. Two sources for one
 * number, only one of which a deploy updates: set `friend` to 25 in D1 and a
 * friend would clear `/private/photos`, which still demanded the compile-time
 * 20. Not viewer-exploitable — it took Caden's own hand-edit — but it was the
 * one place the "read live from D1" property was not actually true, while the
 * rest of the system assumed it was uniform.
 *
 * So `tier.rank` is now **decorative for authorization**: it seeds the table,
 * it orders `access:list`, and nothing reads it to decide anything. Changing a
 * rank requires a deploy, which was already true of every route demand. Do not
 * "restore" the column here — the asymmetry, not the column, was the bug.
 * (`tier.calendar_detail` and `tier.calendar_horizon_days` are untouched by
 * this and remain live: they are keyed by slug, not by rank.)
 *
 * Returns `null` — no tier, i.e. public — for anything the database should not
 * have contained. There is deliberately no branch that turns an unexpected
 * value into access.
 */
export function resolveGrantedTier(slug: unknown): { slug: TierSlug; rank: number } | null {
	if (typeof slug !== 'string' || !(TIER_SLUGS as readonly string[]).includes(slug)) return null;

	// Belt and braces on a frozen literal: if `TIER_RANK` ever gains a slug
	// whose rank is not a rank, that grant is worth nothing rather than
	// everything.
	const rank = TIER_RANK[slug as TierSlug];
	if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < PUBLIC_TIER_RANK) return null;

	return { slug: slug as TierSlug, rank };
}
