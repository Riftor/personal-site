import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { getDb } from '../db';
import { contentEntry, mediaAsset, mediaVariant, type ContentKind } from '../db/schema';
import { blurhashDataUri } from './blurhash';

/**
 * What the private templates render: an entry, and the media a viewer of a
 * given rank may see inside it.
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
 *
 * The asset rank filter sits in the JOIN's `ON` clause, not the `WHERE`. In
 * the `WHERE` it would turn the outer join back into an inner one and drop
 * every entry with no readable media — which for a memory is the ordinary case
 * of a written entry with no photos, and for any entry is the case of a set
 * whose photos are all above the viewer's tier. Those must render as an entry
 * with no images, not vanish.
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
	/** Rendered from markdown at publish time (plan §6). Trusted; see the CLI. */
	bodyHtml: string | null;
	occurredOn: string | null;
	assets: GalleryAsset[];
};

function db(platform: App.Platform | undefined) {
	if (!platform?.env?.DB) {
		error(500, 'The D1 binding DB is not available on this request.');
	}
	return getDb(platform.env.DB);
}

const entryColumns = {
	slug: contentEntry.slug,
	title: contentEntry.title,
	summary: contentEntry.summary,
	bodyHtml: contentEntry.bodyHtml,
	occurredOn: contentEntry.occurredOn
};

const assetColumns = {
	assetId: mediaAsset.id,
	assetKind: mediaAsset.kind,
	width: mediaAsset.width,
	height: mediaAsset.height,
	durationS: mediaAsset.durationS,
	caption: mediaAsset.caption,
	blurhash: mediaAsset.blurhash,
	position: mediaAsset.position,
	variant: mediaVariant.variant,
	variantWidth: mediaVariant.width,
	variantHeight: mediaVariant.height
};

type Row = { [K in keyof typeof entryColumns | keyof typeof assetColumns]: unknown } & {
	slug: string;
	title: string;
	summary: string | null;
	bodyHtml: string | null;
	occurredOn: string | null;
	assetId: string | null;
	assetKind: 'image' | 'video' | null;
	width: number | null;
	height: number | null;
	durationS: number | null;
	caption: string | null;
	blurhash: string | null;
	variant: string | null;
	variantWidth: number | null;
	variantHeight: number | null;
};

/** Collapses the joined rows into one entry per slug, assets in order. */
function group(rows: Row[]): GallerySet[] {
	const sets = new Map<string, GallerySet>();
	const assets = new Map<string, GalleryAsset>();

	for (const row of rows) {
		let set = sets.get(row.slug);
		if (!set) {
			set = {
				slug: row.slug,
				title: row.title,
				summary: row.summary,
				bodyHtml: row.bodyHtml,
				occurredOn: row.occurredOn,
				assets: []
			};
			sets.set(row.slug, set);
		}

		// A LEFT JOIN row for an entry with no readable media.
		if (!row.assetId || !row.assetKind || !row.variant) continue;

		let asset = assets.get(row.assetId);
		if (!asset) {
			const ratio = row.width && row.height ? row.width / row.height : undefined;
			asset = {
				id: row.assetId,
				kind: row.assetKind,
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

/**
 * Published entries of one kind that a viewer of this rank may read, newest
 * first, each with the assets they may read in publication order.
 *
 * One query and a group-by rather than a query per entry: the whole private
 * half is a few dozen rows, and N+1 round trips against D1 is the shape that
 * turns a 10 ms CPU budget into a 50 ms one.
 */
async function listEntries(
	platform: App.Platform | undefined,
	kind: ContentKind,
	viewerRank: number,
	slug?: string
): Promise<GallerySet[]> {
	// A rank that is not a number would make every `<=` below false in SQLite's
	// eyes in some drivers and true in others. Refuse to guess which.
	if (!Number.isFinite(viewerRank)) return [];

	const rows = await db(platform)
		.select({ ...entryColumns, ...assetColumns })
		.from(contentEntry)
		.leftJoin(
			mediaAsset,
			and(eq(mediaAsset.entryId, contentEntry.id), lte(mediaAsset.minTierRank, viewerRank))
		)
		.leftJoin(mediaVariant, eq(mediaVariant.assetId, mediaAsset.id))
		.where(
			and(
				eq(contentEntry.kind, kind),
				eq(contentEntry.status, 'published'),
				lte(contentEntry.minTierRank, viewerRank),
				slug === undefined ? undefined : eq(contentEntry.slug, slug)
			)
		)
		.orderBy(desc(contentEntry.occurredOn), asc(mediaAsset.position), asc(mediaVariant.variant));

	return group(rows as Row[]);
}

/** Photo sets for `/private/photos`. */
export function listPhotoSets(
	platform: App.Platform | undefined,
	viewerRank: number
): Promise<GallerySet[]> {
	return listEntries(platform, 'photoset', viewerRank);
}

/** Memories for `/private/memories`, newest first. */
export function listMemories(
	platform: App.Platform | undefined,
	viewerRank: number
): Promise<GallerySet[]> {
	return listEntries(platform, 'memory', viewerRank);
}

/**
 * One memory for `/private/memories/[slug]`, or `null`.
 *
 * `null` covers "no such memory", "it is a draft" and "your tier is too low"
 * without distinguishing them, and the caller turns all three into the same
 * 403 — plan §2's rule that a probe must not be able to enumerate which
 * private pages exist.
 */
export async function getMemory(
	platform: App.Platform | undefined,
	slug: string,
	viewerRank: number
): Promise<GallerySet | null> {
	const [memory] = await listEntries(platform, 'memory', viewerRank, slug);
	return memory ?? null;
}
