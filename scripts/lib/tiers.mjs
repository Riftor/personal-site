/**
 * Rank per tier slug, for the CLIs.
 *
 * A third copy of the five rows in `drizzle/0000_tier.sql` — after the table
 * itself and `TIER_RANK` in `src/lib/server/access/tiers.ts` — and copies
 * drift. `src/lib/server/access/tiers.spec.ts` parses the migration and this
 * file together, so a rank edited in one place and not the others fails the
 * unit suite rather than silently publishing content a tier lower than the
 * author meant.
 *
 * `.mjs` rather than `.ts` because the publish CLIs run under bare `node` with
 * no build step, the same reason `scripts/media/derive.mjs` is.
 */
export const TIER_RANK = Object.freeze({
	public: 0,
	friend: 10,
	family: 20,
	partner: 30,
	owner: 100
});

/** In rank order, for help text and error messages. */
export const TIER_SLUGS = Object.freeze(
	Object.keys(TIER_RANK).sort((a, b) => TIER_RANK[a] - TIER_RANK[b])
);

/**
 * The rank a slug carries, or `null` if it is not a tier.
 *
 * Null rather than a default, at every call site: plan §6 and the schema's
 * `min_tier_rank DEFAULT 100` both say an unrecognised tier is a hard error.
 * `min_tier: freind` must stop the publish, because the alternative — falling
 * back to anything at all — is a typo quietly choosing an audience.
 */
export function rankOf(slug) {
	return Object.hasOwn(TIER_RANK, slug) ? TIER_RANK[slug] : null;
}
