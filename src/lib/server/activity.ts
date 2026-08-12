import { error } from '@sveltejs/kit';
import { and, desc, eq, lte } from 'drizzle-orm';
import { getDb } from './db';
import { contentEntry } from './db/schema';

/**
 * The activity feed behind `/private/now`.
 *
 * One `content_entry` of kind `activity` per month (plan §6:
 * `content/activity/2026-08.md`, append-only), so the feed is a handful of
 * rows and the page is those rows' `body_html` newest month first. The months
 * are ordered by `occurred_on`, which the CLI takes from the frontmatter, and
 * the slug only breaks ties — a file named for a month sorts correctly as a
 * string either way, but relying on that would make the order an accident of
 * the naming convention.
 *
 * Same two filters as everything else on the private half: `status =
 * 'published'` and `min_tier_rank <= :rank`. A draft month is not servable at
 * any tier, and a month published above the viewer is not in the result set at
 * all rather than being rendered empty.
 */

export type ActivityMonth = {
	slug: string;
	title: string;
	summary: string | null;
	/** Rendered from markdown at publish time. Trusted; see `scripts/content/`. */
	bodyHtml: string | null;
	occurredOn: string | null;
	updatedAt: number;
};

/** How many months the page shows. Older ones stay in D1, unlinked. */
const MONTHS = 12;

export async function listActivity(
	platform: App.Platform | undefined,
	viewerRank: number
): Promise<ActivityMonth[]> {
	// Same refusal as the gallery: a rank that is not a number cannot be
	// compared, and guessing which way SQLite would resolve it is not an option.
	if (!Number.isFinite(viewerRank)) return [];

	if (!platform?.env?.DB) {
		error(500, 'The D1 binding DB is not available on this request.');
	}

	return getDb(platform.env.DB)
		.select({
			slug: contentEntry.slug,
			title: contentEntry.title,
			summary: contentEntry.summary,
			bodyHtml: contentEntry.bodyHtml,
			occurredOn: contentEntry.occurredOn,
			updatedAt: contentEntry.updatedAt
		})
		.from(contentEntry)
		.where(
			and(
				eq(contentEntry.kind, 'activity'),
				eq(contentEntry.status, 'published'),
				lte(contentEntry.minTierRank, viewerRank)
			)
		)
		.orderBy(desc(contentEntry.occurredOn), desc(contentEntry.slug))
		.limit(MONTHS);
}
