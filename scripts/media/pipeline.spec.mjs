import { describe, expect, it } from 'vitest';
import { refusesInPlaceTightening } from './pipeline.mjs';

/**
 * The public-cache rule (plan §M4's review finding, HANDOFF invariant 3).
 *
 * REGRESSION 2026-08-12. This predicate used to be an inline condition inside
 * the "unchanged, and not forced" branch, which meant `--force` skipped it and
 * re-uploaded the asset at the tighter rank — precisely the thing both
 * documents say `--force` must not be able to do. It is a named function
 * evaluated for every file now.
 *
 * What these tests cannot prove is *where* it is called from, and that is the
 * half that broke. `publishAssets` needs D1 and R2, so the placement is
 * covered by running the CLI, not by this file.
 */

describe('refusesInPlaceTightening', () => {
	it('refuses raising a public asset to any named tier', () => {
		for (const rank of [10, 20, 30, 100]) {
			expect(refusesInPlaceTightening(0, rank), `0 -> ${rank}`).toBe(true);
		}
	});

	it('allows leaving a public asset public', () => {
		expect(refusesInPlaceTightening(0, 0)).toBe(false);
	});

	it('allows loosening, which is never the dangerous direction', () => {
		expect(refusesInPlaceTightening(20, 0)).toBe(false);
		expect(refusesInPlaceTightening(30, 10)).toBe(false);
	});

	it('allows tightening an asset that was never public, since nothing cached it', () => {
		// Gated media is `private, no-store`, so there is no shared copy to
		// outlive the rank change.
		expect(refusesInPlaceTightening(10, 20)).toBe(false);
		expect(refusesInPlaceTightening(20, 30)).toBe(false);
	});

	it('has nothing to refuse for an asset that does not exist yet', () => {
		expect(refusesInPlaceTightening(null, 20)).toBe(false);
		expect(refusesInPlaceTightening(undefined, 20)).toBe(false);
	});

	it('reads a rank that arrived from D1 as text', () => {
		expect(refusesInPlaceTightening('0', 20)).toBe(true);
		expect(refusesInPlaceTightening('20', 30)).toBe(false);
	});

	it('does not refuse on a rank that is not a rank, which the media route refuses anyway', () => {
		expect(refusesInPlaceTightening('family', 20)).toBe(false);
		expect(refusesInPlaceTightening(Number.NaN, 20)).toBe(false);
	});
});
