import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import {
	contentEntry,
	mediaAsset,
	mediaVariant,
	MEDIA_VARIANTS,
	PUBLIC_TIER_RANK,
	type MediaVariantName
} from '../db/schema';

/**
 * Everything `/m/[assetId]/[variant]` needs to know before it touches R2, and
 * nothing it does not.
 *
 * The rule this file is written to: **no return value from here may be a
 * guess.** Every path that cannot prove the request is for a real variant of a
 * real, published asset returns `null`, and the route turns `null` into the
 * same refusal it gives a private asset — so a probe cannot tell a typo'd id
 * from a photo it is not allowed to see.
 */

/**
 * Crockford base32, 26 characters — the ULID alphabet, which excludes I, L, O
 * and U. Checked before the id reaches D1. The query is parameterised so this
 * is not an injection defence; it is a cheap way to make junk fail in the same
 * shape as a wrong-but-plausible id.
 */
const ASSET_ID = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export function isAssetId(value: string): boolean {
	return ASSET_ID.test(value);
}

/** Whether `value` is one of the variant names the site will ever serve. */
export function isServableVariant(value: string): value is MediaVariantName {
	return (MEDIA_VARIANTS as readonly string[]).includes(value);
}

/**
 * The rank a viewer must hold to read an asset: the **stricter** of the
 * asset's own floor and the rank of the entry that owns it.
 *
 * Plan §3 denormalizes `min_tier_rank` onto `media_asset` so one photo can be
 * stricter than its set. Taking the maximum is what makes that true in one
 * direction only — an asset can be tightened past its page, never loosened
 * below it, so editing the asset row alone can never publish something the
 * page still considers private.
 *
 * Anything that is not a non-negative integer — NULL, a string, a float, a
 * negative — yields `Infinity`, which no viewer clears. A column the schema
 * says is `NOT NULL DEFAULT 100` should never be any of those; if it is, the
 * database has been edited by hand and the only safe reading is "refuse".
 */
export function strictestRank(...ranks: unknown[]): number {
	let required = PUBLIC_TIER_RANK;

	for (const rank of ranks) {
		if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < PUBLIC_TIER_RANK) {
			return Number.POSITIVE_INFINITY;
		}
		required = Math.max(required, rank);
	}

	return required;
}

export type ServableVariant = {
	/** From `media_variant.r2_key`. Never built from anything in the URL. */
	r2Key: string;
	mime: string;
	requiredRank: number;
};

/**
 * Resolves one variant of one asset, or `null` if it may not be served.
 *
 * Both joins are inner ones and both are load-bearing:
 *   - to `media_asset`, so a variant row orphaned by a half-finished publish
 *     resolves to nothing rather than to a key with no rank attached;
 *   - to `content_entry`, so an asset with a NULL `entry_id` — one that
 *     belongs to no page and therefore has no page-level rank to be checked
 *     against — is unreachable. Plan §3's one-row read is two rows here for
 *     exactly that reason, which is one indexed join and still nothing.
 *
 * A draft entry is refused too. `status` is what "published" means everywhere
 * else in this codebase, and media is not an exception to it.
 */
export async function findServableVariant(
	d1: D1Database,
	assetId: string,
	variant: string
): Promise<ServableVariant | null> {
	if (!isAssetId(assetId) || !isServableVariant(variant)) return null;

	let row;
	try {
		[row] = await getDb(d1)
			.select({
				r2Key: mediaVariant.r2Key,
				mime: mediaVariant.mime,
				assetRank: mediaAsset.minTierRank,
				entryRank: contentEntry.minTierRank,
				status: contentEntry.status
			})
			.from(mediaVariant)
			.innerJoin(mediaAsset, eq(mediaAsset.id, mediaVariant.assetId))
			.innerJoin(contentEntry, eq(contentEntry.id, mediaAsset.entryId))
			.where(and(eq(mediaVariant.assetId, assetId), eq(mediaVariant.variant, variant)))
			.limit(1);
	} catch (cause) {
		console.error('media: variant lookup failed, refusing the request.', cause);
		return null;
	}

	if (!row) return null;
	if (row.status !== 'published') return null;
	if (typeof row.r2Key !== 'string' || row.r2Key.length === 0) return null;
	if (typeof row.mime !== 'string' || row.mime.length === 0) return null;

	return {
		r2Key: row.r2Key,
		mime: row.mime,
		requiredRank: strictestRank(row.assetRank, row.entryRank)
	};
}
