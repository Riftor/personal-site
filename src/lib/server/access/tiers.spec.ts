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
	it('accepts a well-formed row', () => {
		expect(resolveGrantedTier('partner', 30)).toEqual({ slug: 'partner', rank: 30 });
		expect(resolveGrantedTier('public', PUBLIC_TIER_RANK)).toEqual({
			slug: 'public',
			rank: PUBLIC_TIER_RANK
		});
	});

	it('returns no tier for anything the database should not have contained', () => {
		const bad: [unknown, unknown][] = [
			['wizard', 999], // slug that is not a tier
			[null, 30],
			[undefined, 30],
			[30, 30], // slug that is not a string
			['partner', null], // NULL rank
			['partner', undefined],
			['partner', '30'], // rank arrived as text
			['partner', 20.5],
			['partner', Number.NaN],
			['partner', -1]
		];

		for (const [slug, rank] of bad) {
			expect(resolveGrantedTier(slug, rank), `${String(slug)} / ${String(rank)}`).toBeNull();
		}
	});
});
