import { describe, expect, it } from 'vitest';
import { DEFAULT_DENY_RANK, privateNavFor, requiredRankFor } from './routes';
import { TIER_RANK } from './tiers';
import { OWNER_TIER_RANK, PUBLIC_TIER_RANK } from '../db/schema';

/**
 * The property this table exists for is the negative one: a path under
 * `/private` that nobody wrote an entry for must cost the highest rank in the
 * system, not the lowest. Most of what follows is that same assertion from a
 * different angle, because every one of those angles is a way a real bug has
 * shipped somewhere before.
 */

describe('requiredRankFor', () => {
	it('defaults an unlisted /private path to owner-only, not to public', () => {
		expect(requiredRankFor('/private/secrets')).toBe(OWNER_TIER_RANK);
		expect(requiredRankFor('/private/secrets')).toBe(100);
		expect(DEFAULT_DENY_RANK).toBe(OWNER_TIER_RANK);
	});

	it('default-denies /private itself and anything nested under an unlisted path', () => {
		expect(requiredRankFor('/private')).toBe(OWNER_TIER_RANK);
		expect(requiredRankFor('/private/')).toBe(OWNER_TIER_RANK);
		expect(requiredRankFor('/private/journal/2026-07-cornwall')).toBe(OWNER_TIER_RANK);
	});

	it('gives the listed pages their own minimum rank', () => {
		expect(requiredRankFor('/private/now')).toBe(TIER_RANK.friend);
		expect(requiredRankFor('/private/photos')).toBe(TIER_RANK.family);
		// Also a floor: a memory's own `min_tier_rank` is applied in the query,
		// so a `partner` memory under this `family` prefix is still refused.
		expect(requiredRankFor('/private/memories')).toBe(TIER_RANK.family);
		expect(requiredRankFor('/private/memories/2026-07-cornwall')).toBe(TIER_RANK.family);
		// A floor, not the answer: plan §4 gives every tier from `friend` up a
		// calendar and varies how much of it they see. `tier.calendar_detail`
		// makes that second decision, in `calendar/access.ts`.
		expect(requiredRankFor('/private/calendar')).toBe(TIER_RANK.friend);
	});

	it('covers everything under a listed page with that page’s rank', () => {
		expect(requiredRankFor('/private/photos/2026-07-cornwall')).toBe(TIER_RANK.family);
	});

	it('does not let a prefix match bleed into a longer sibling name', () => {
		// `/private/nowhere` shares eight characters with `/private/now` and is
		// not it. Matching on the raw prefix would hand it the friend rank.
		expect(requiredRankFor('/private/nowhere')).toBe(OWNER_TIER_RANK);
		expect(requiredRankFor('/private/photosets')).toBe(OWNER_TIER_RANK);
	});

	it('leaves the public half alone', () => {
		for (const path of ['/', '/about', '/work', '/signin', '/api/auth/callback/google']) {
			expect(requiredRankFor(path)).toBe(PUBLIC_TIER_RANK);
		}
	});

	it('treats the spellings of a private path that a browser would collapse as private', () => {
		for (const path of [
			'/private/now/',
			'//private/now',
			'/private//now',
			'\\private\\now',
			'/PRIVATE/NOW',
			'/private/now/__data.json'
		]) {
			expect(requiredRankFor(path), path).toBe(TIER_RANK.friend);
		}
	});

	it('resolves percent-encoding to the stricter of the two readings', () => {
		// Decoded, this is `/private/secrets`; the encoding must not buy a
		// weaker answer than the path it stands for.
		expect(requiredRankFor('/%70rivate/secrets')).toBe(OWNER_TIER_RANK);

		// And the reverse: `/private/%6eow` decodes to a page a friend may read,
		// but no browser sends that spelling, so the raw reading wins and it is
		// default-denied. Strict in the direction that costs an attacker
		// something and a real visitor nothing.
		expect(requiredRankFor('/private/%6eow')).toBe(OWNER_TIER_RANK);
	});

	it('judges a path with malformed escapes on its raw form rather than waving it through', () => {
		expect(requiredRankFor('/private/%zz')).toBe(OWNER_TIER_RANK);
	});
});

describe('privateNavFor', () => {
	it('shows nobody the private half at public rank', () => {
		expect(privateNavFor(PUBLIC_TIER_RANK)).toEqual([]);
	});

	it('shows only what a rank clears, cheapest first', () => {
		expect(privateNavFor(TIER_RANK.friend).map((item) => item.href)).toEqual([
			'/private/now',
			'/private/calendar'
		]);
		expect(privateNavFor(TIER_RANK.family).map((item) => item.href)).toEqual([
			'/private/now',
			'/private/calendar',
			'/private/photos',
			'/private/memories'
		]);
	});

	it('never lists a page the same rank would be refused by the route table', () => {
		for (const rank of Object.values(TIER_RANK)) {
			for (const { href } of privateNavFor(rank)) {
				expect(rank >= requiredRankFor(href), `${href} at rank ${rank}`).toBe(true);
			}
		}
	});
});
