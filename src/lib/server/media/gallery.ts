import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { getDb } from '../db';
import { contentEntry, mediaAsset, mediaVariant } from '../db/schema';
import { blurhashDataUri } from './blurhash';

/**
 * What `/private/photos` renders.
 *
 * Both filters below are `min_tier_rank <= :rank`, applied to the entry *and*
 * separately to each asset, so a partner-only photo inside a family set never
 * reaches the HTML. That is a second, independent refusal from the one
 * `/m/[assetId]/[variant]` makes: the page not listing an asset is what stops
 * the id being seen at all, and the media route refusing it is what stops the
 * id being useful if it is guessed. Neither substitutes for the other — the
 * URLs are short and the ids are in the page source for everything a viewer
 * *can* see, so "not rendered" would be no protection on its own.
 *
 * The variant rows are read rather than assumed. Building `srcset` from a
 * hard-coded width list would produce `<source>` entries for objects a
 * half-finished publish never uploaded, and the browser would silently fetch
 * 404s.
 */

export type GalleryVariant = { name: string; width: number | null; height: number | null };

export type GalleryAsset = {
	id: string;
	kind: 'image' | 'video';
	width: number | null;
	height: number | null;
	durationS: number | null;
	caption: string | null;
	/** A `data:` URI decoded from the blurhash, or `null`. Safe to inline. */
	placeholder: string | null;
	variants: GalleryVariant[];
};

export type GallerySet = {
	slug: string;
	title: string;
	summary: string | null;
	occurredOn: string | null;
	assets: GalleryAsset[];
};

function db(platform: App.Platform | undefined) {
	if (!platform?.env?.DB) {
		error(500, 'The D1 binding DB is not available on this request.');
	}
	return getDb(platform.env.DB);
}

/**
 * Photo sets a viewer of this rank may read, newest first, each with the
 * assets they may read in publication order.
 *
 * One query and a group-by rather than a query per set: the whole private
 * gallery is a few dozen rows, and N+1 round trips against D1 is the shape
 * that turns a 10 ms CPU budget into a 50 ms one.
 */
export async function listPhotoSets(
	platform: App.Platform | undefined,
	viewerRank: number
): Promise<GallerySet[]> {
	// A rank that is not a number would make every `<=` below false in SQLite's
	// eyes in some drivers and true in others. Refuse to guess which.
	if (!Number.isFinite(viewerRank)) return [];

	const rows = await db(platform)
		.select({
			slug: contentEntry.slug,
			title: contentEntry.title,
			summary: contentEntry.summary,
			occurredOn: contentEntry.occurredOn,
			assetId: mediaAsset.id,
			kind: mediaAsset.kind,
			width: mediaAsset.width,
			height: mediaAsset.height,
			durationS: mediaAsset.durationS,
			caption: mediaAsset.caption,
			blurhash: mediaAsset.blurhash,
			position: mediaAsset.position,
			variant: mediaVariant.variant,
			variantWidth: mediaVariant.width,
			variantHeight: mediaVariant.height
		})
		.from(contentEntry)
		.innerJoin(mediaAsset, eq(mediaAsset.entryId, contentEntry.id))
		.innerJoin(mediaVariant, eq(mediaVariant.assetId, mediaAsset.id))
		.where(
			and(
				eq(contentEntry.kind, 'photoset'),
				eq(contentEntry.status, 'published'),
				lte(contentEntry.minTierRank, viewerRank),
				lte(mediaAsset.minTierRank, viewerRank)
			)
		)
		.orderBy(desc(contentEntry.occurredOn), asc(mediaAsset.position), asc(mediaVariant.variant));

	const sets = new Map<string, GallerySet>();
	const assets = new Map<string, GalleryAsset>();

	for (const row of rows) {
		let set = sets.get(row.slug);
		if (!set) {
			set = {
				slug: row.slug,
				title: row.title,
				summary: row.summary,
				occurredOn: row.occurredOn,
				assets: []
			};
			sets.set(row.slug, set);
		}

		let asset = assets.get(row.assetId);
		if (!asset) {
			const ratio = row.width && row.height ? row.width / row.height : undefined;
			asset = {
				id: row.assetId,
				kind: row.kind,
				width: row.width,
				height: row.height,
				durationS: row.durationS,
				caption: row.caption,
				placeholder: blurhashDataUri(row.blurhash, ratio),
				variants: []
			};
			assets.set(row.assetId, asset);
			set.assets.push(asset);
		}

		asset.variants.push({
			name: row.variant,
			width: row.variantWidth,
			height: row.variantHeight
		});
	}

	return [...sets.values()];
}
