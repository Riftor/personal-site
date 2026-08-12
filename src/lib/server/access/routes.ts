import { OWNER_TIER_RANK, PUBLIC_TIER_RANK } from '../db/schema';
import { TIER_RANK } from './tiers';

/**
 * Layer 1 of the four in plan §2: a path-prefix table with **default deny
 * under `/private`**.
 *
 * This is not the thing that keeps strangers out — `requireTier` in the
 * loaders is, because it sits on the data path. This table exists so that a
 * route added under `/private` without a guard, or a URL that matches no route
 * at all, still resolves to owner-only. A forgotten route fails closed.
 *
 * Read that the other way round and it is the rule for editing this file:
 * adding an entry here can only ever *loosen* access, so an entry is a
 * deliberate act, and the absence of one is always safe.
 */

/** Everything at or below this path is private unless listed below. */
export const PRIVATE_PREFIX = '/private';

/**
 * Minimum rank per private prefix. A prefix covers the path itself and
 * anything under it; the longest match wins.
 */
const PRIVATE_ROUTE_MIN_RANK: Readonly<Record<string, number>> = Object.freeze({
	'/private/now': TIER_RANK.friend,
	'/private/photos': TIER_RANK.family,
	/**
	 * A floor, and it covers `/private/memories/<slug>` too. The entry's own
	 * `min_tier_rank` is the real answer and is applied inside the query, so a
	 * memory published at `partner` is not listed for a family session and its
	 * URL answers with the same 403 as a slug that does not exist.
	 */
	'/private/memories': TIER_RANK.family,
	/**
	 * A floor, not the answer. Plan §4 gives every tier from `friend` up a
	 * calendar and varies *how much of it* they see — so the page is reachable
	 * from `friend`, and `tier.calendar_detail` decides the rest inside
	 * `calendar/access.ts`. A tier whose detail is `none` is refused there,
	 * with the same 403 this table would have produced.
	 */
	'/private/calendar': TIER_RANK.friend
});

/** What an unlisted path under `/private` costs. Nobody but Caden clears it. */
export const DEFAULT_DENY_RANK = OWNER_TIER_RANK;

/**
 * Reduces a request path to the one form the table is matched against.
 *
 * Every transformation here exists to make two spellings of the same path
 * answer the same way, and each one can only ever pull a path *towards*
 * `/private`, never away from it:
 *   - backslashes become slashes (some proxies and browsers treat them alike)
 *   - repeated slashes collapse (`//private/now`)
 *   - a trailing slash is dropped (`/private/now/`)
 *   - `/__data.json` is dropped (SvelteKit's client-side navigation fetch)
 *   - the whole path is lowercased
 */
function normalise(pathname: string): string {
	const path = pathname
		.replaceAll('\\', '/')
		.replace(/\/{2,}/g, '/')
		.replace(/\/__data\.json$/i, '')
		.replace(/\/+$/, '')
		.toLowerCase();

	return path || '/';
}

/** True for `/private` itself and anything beneath it, and nothing else. */
function isPrivate(path: string): boolean {
	return path === PRIVATE_PREFIX || path.startsWith(`${PRIVATE_PREFIX}/`);
}

function rankForCandidate(pathname: string): number {
	const path = normalise(pathname);
	if (!isPrivate(path)) return PUBLIC_TIER_RANK;

	let matched = '';
	let rank = DEFAULT_DENY_RANK;

	for (const [prefix, prefixRank] of Object.entries(PRIVATE_ROUTE_MIN_RANK)) {
		const covers = path === prefix || path.startsWith(`${prefix}/`);
		if (covers && prefix.length > matched.length) {
			matched = prefix;
			rank = prefixRank;
		}
	}

	return rank;
}

/**
 * The minimum rank a request for `pathname` requires.
 *
 * Percent-encoding is resolved by taking the **stricter** of the raw and
 * decoded readings, so neither `/%70rivate/x` nor a path that only looks
 * private once decoded can pick the weaker answer. A path that fails to decode
 * is judged on its raw form alone rather than being waved through.
 */
export function requiredRankFor(pathname: string): number {
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// Malformed escapes: `pathname` is already the strictest reading available.
	}

	return Math.max(rankForCandidate(pathname), rankForCandidate(decoded));
}

/**
 * The private pages a viewer of this rank clears, for the masthead.
 *
 * This is a **UX affordance and nothing else**. Every page it links to refuses
 * the request itself, and omitting a link from here grants nobody anything —
 * the URLs are guessable and are meant to be. It is derived from the same
 * table above so a page can never appear in the nav at a rank that cannot open
 * it, and the label is derived from the path so there is nothing to keep in
 * sync by hand.
 */
export function privateNavFor(rank: number): { href: string; label: string }[] {
	return Object.entries(PRIVATE_ROUTE_MIN_RANK)
		.filter(([, minRank]) => rank >= minRank)
		.sort(([, a], [, b]) => a - b)
		.map(([href]) => {
			const segment = href.slice(href.lastIndexOf('/') + 1);
			return { href, label: segment.charAt(0).toUpperCase() + segment.slice(1) };
		});
}
