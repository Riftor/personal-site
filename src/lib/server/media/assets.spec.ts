import { describe, expect, it } from 'vitest';
import { MEDIA_VARIANTS, OWNER_TIER_RANK, PUBLIC_TIER_RANK } from '../db/schema';
import { isAssetId, isServableVariant, strictestRank } from './assets';

/**
 * These are the two pure halves of the media route's default-deny. The join
 * itself is covered end to end by `e2e/media.spec.ts`; what is worth pinning
 * here is that every *wrong* input refuses, because those are the cases a
 * live database is unlikely to produce until the day it does.
 */

describe('isServableVariant', () => {
	it('accepts every variant the pipeline emits', () => {
		expect(MEDIA_VARIANTS.every(isServableVariant)).toBe(true);
	});

	it('refuses a variant name that would reach the untouched original', () => {
		// There is no `original` variant on purpose (plan §5): the source file
		// still carries whatever the pipeline decided not to publish.
		for (const name of ['original', 'originals', 'source', '']) {
			expect(isServableVariant(name), name).toBe(false);
		}
	});

	it('refuses anything shaped like a traversal or a key fragment', () => {
		for (const name of ['../w800.avif', 'w800.avif/../../originals', 'img/x/w800.avif']) {
			expect(isServableVariant(name), name).toBe(false);
		}
	});

	it('is case-sensitive, so a near-miss is a miss', () => {
		expect(isServableVariant('W800.AVIF')).toBe(false);
	});
});

describe('isAssetId', () => {
	it('accepts a 26-character Crockford base32 id', () => {
		expect(isAssetId('01K3ZQ7B9C0000000000000101')).toBe(true);
	});

	it('refuses the wrong length, the wrong alphabet, and the empty string', () => {
		for (const id of [
			'',
			'01K3ZQ7B9C000000000000010', // 25
			'01K3ZQ7B9C00000000000001011', // 27
			'01K3ZQ7B9C000000000000010I', // I is not in the alphabet
			'01k3zq7b9c0000000000000101', // lowercase
			'01K3ZQ7B9C00000000000001-1'
		]) {
			expect(isAssetId(id), JSON.stringify(id)).toBe(false);
		}
	});
});

describe('strictestRank', () => {
	it('takes the stricter of the asset and its entry', () => {
		expect(strictestRank(20, 10)).toBe(20);
		expect(strictestRank(10, 30)).toBe(30);
	});

	it('keeps a public asset on a public page public', () => {
		expect(strictestRank(PUBLIC_TIER_RANK, PUBLIC_TIER_RANK)).toBe(PUBLIC_TIER_RANK);
	});

	it('will not let a loosened asset row escape a stricter page', () => {
		expect(strictestRank(PUBLIC_TIER_RANK, OWNER_TIER_RANK)).toBe(OWNER_TIER_RANK);
	});

	it('refuses everyone when either rank is missing or not a rank', () => {
		for (const bad of [null, undefined, Number.NaN, '20', 20.5, -1, Number.POSITIVE_INFINITY]) {
			expect(strictestRank(bad, 0), String(bad)).toBe(Number.POSITIVE_INFINITY);
			expect(strictestRank(0, bad), String(bad)).toBe(Number.POSITIVE_INFINITY);
		}
	});
});
