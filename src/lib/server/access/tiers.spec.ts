import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rankRequiredFor, resolveGrantedTier, TIER_RANK } from './tiers';
import { PUBLIC_TIER_RANK, TIER_SLUGS } from '../db/schema';

/**
 * `TIER_RANK` is a copy of data that lives in the database. Copies drift, and
 * a drift here is silent and one-directional: if the code thought `family`
 * were rank 10 while the table said 20, every `requireTier('family')` page
 * would quietly open to friends. So the copy is checked against its source.
 */
const MIGRATION = 'drizzle/0000_tier.sql';

function seededRanks(): Record<string, number> {
	const sql = readFileSync(MIGRATION, 'utf8');
	const rows = sql.matchAll(/\(\s*'(\w+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,/g);

	return Object.fromEntries([...rows].map(([, slug, rank]) => [slug, Number(rank)]));
}

describe('TIER_RANK', () => {
	it('matches the tier rows seeded by the migration, exactly', () => {
		const seeded = seededRanks();

		expect(Object.keys(seeded).sort()).toEqual([...TIER_SLUGS].sort());
		expect(seeded).toEqual(TIER_RANK);
	});

	it('matches the third copy, the one the publish CLIs read', async () => {
		// `scripts/lib/tiers.mjs` cannot import this module — the CLIs run under
		// bare `node` with no build step — so it is a copy, and the same drift
		// argument applies. A rank edited here and not there would mean the site
		// and the tool that publishes to it disagreed about who `family` is.
		const { TIER_RANK: cliRanks } = await import('../../../../scripts/lib/tiers.mjs');

		expect({ ...cliRanks }).toEqual(TIER_RANK);
	});

	it('keeps public at the bottom and owner at the top', () => {
		const ranks = Object.values(TIER_RANK);

		expect(TIER_RANK.public).toBe(Math.min(...ranks));
		expect(TIER_RANK.owner).toBe(Math.max(...ranks));
	});
});

describe('rankRequiredFor', () => {
	it('returns the tier’s rank for a real slug', () => {
		expect(rankRequiredFor('family')).toBe(20);
	});

	it('refuses everyone, including the owner, for a slug it does not know', () => {
		// A typo in a `requireTier` call must lock the page, not open it.
		const required = rankRequiredFor('familly' as never);

		expect(required).toBe(Number.POSITIVE_INFINITY);
		expect(TIER_RANK.owner >= required).toBe(false);
	});
});

describe('resolveGrantedTier', () => {
	it('accepts a slug the tier table knows', () => {
		expect(resolveGrantedTier('partner')).toEqual({ slug: 'partner', rank: 30 });
		expect(resolveGrantedTier('public')).toEqual({ slug: 'public', rank: PUBLIC_TIER_RANK });
	});

	it('returns no tier for anything the database should not have contained', () => {
		const bad: unknown[] = ['wizard', '', 'Partner', null, undefined, 30, {}, ['partner']];

		for (const slug of bad) {
			expect(resolveGrantedTier(slug), String(slug)).toBeNull();
		}
	});

	// Plan §8.6. `routes.ts` resolves what a route *demands* from `TIER_RANK`
	// because a guard cannot afford a query; a viewer's rank used to come from
	// the `tier.rank` column instead. Two sources for one number, one of which
	// moves without a deploy, is how `friend` at rank 25 in D1 walked into a
	// page that still demanded the compile-time 20.
	it('takes the rank from code, so the column cannot drift away from the demand', () => {
		for (const slug of TIER_SLUGS) {
			expect(resolveGrantedTier(slug)).toEqual({ slug, rank: TIER_RANK[slug] });
			expect(resolveGrantedTier(slug)?.rank).toBe(rankRequiredFor(slug));
		}
	});
});
