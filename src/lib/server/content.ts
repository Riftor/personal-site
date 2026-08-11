import { error } from '@sveltejs/kit';
import { and, asc, desc, eq } from 'drizzle-orm';
import { getDb } from './db';
import { contentEntry, PUBLIC_TIER_RANK } from './db/schema';

/**
 * Reads of `content_entry` for the public portfolio.
 *
 * Every query here hard-codes `min_tier_rank = 0`. It is deliberately not
 * parameterised by a viewer rank: these routes are the half of the site that
 * has no session at all, so the only correct filter is the public one. The
 * rank-aware equivalent arrives with the guard in M3 (plan §2) and lives
 * behind `requireTier`, not here.
 */

/** The two clauses that make a row readable with no session. */
const publiclyReadable = and(
	eq(contentEntry.minTierRank, PUBLIC_TIER_RANK),
	eq(contentEntry.status, 'published')
);

/** Columns the public pages actually render. */
const publicColumns = {
	slug: contentEntry.slug,
	title: contentEntry.title,
	summary: contentEntry.summary,
	bodyHtml: contentEntry.bodyHtml,
	occurredOn: contentEntry.occurredOn
};

export type PublicEntry = {
	[K in keyof typeof publicColumns]: (typeof contentEntry.$inferSelect)[K];
};

/**
 * Both `vite dev` and `wrangler dev` supply the D1 binding, so a missing one
 * means the server is running outside the Cloudflare runtime entirely — a
 * misconfiguration, not a request the page can degrade around.
 */
function db(platform: App.Platform | undefined) {
	if (!platform?.env?.DB) {
		error(500, 'The D1 binding DB is not available on this request.');
	}
	return getDb(platform.env.DB);
}

/** A single `page` entry by slug. 404s rather than rendering an empty shell. */
export async function getPublicPage(
	platform: App.Platform | undefined,
	slug: string
): Promise<PublicEntry> {
	const [entry] = await db(platform)
		.select(publicColumns)
		.from(contentEntry)
		.where(and(publiclyReadable, eq(contentEntry.kind, 'page'), eq(contentEntry.slug, slug)))
		.limit(1);

	if (!entry) {
		error(404, `No published public page with slug "${slug}".`);
	}
	return entry;
}

/**
 * Portfolio projects, newest-feeling first. `sort_key` is the manual override
 * and carries the intended order; `occurred_on` only breaks ties.
 */
export async function listPublicProjects(
	platform: App.Platform | undefined,
	limit?: number
): Promise<PublicEntry[]> {
	const query = db(platform)
		.select(publicColumns)
		.from(contentEntry)
		.where(and(publiclyReadable, eq(contentEntry.kind, 'project')))
		.orderBy(asc(contentEntry.sortKey), desc(contentEntry.occurredOn));

	return limit === undefined ? query : query.limit(limit);
}
