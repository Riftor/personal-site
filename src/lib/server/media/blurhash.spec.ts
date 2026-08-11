import { decode as referenceDecode, encode as referenceEncode } from 'blurhash';
import { describe, expect, it } from 'vitest';
import { blurhashDataUri, decodeBlurhash } from './blurhash';

/**
 * `blurhash` is a dev dependency — the pipeline encodes with it — and plan §1's
 * dependency budget keeps it out of the Worker, so the decoder in
 * `blurhash.ts` is hand-written. This file is the price of that decision: it
 * checks the hand-written decode against the library's, pixel for pixel, so
 * "we wrote our own" cannot quietly become "and it renders mud".
 */

/** A hash of a real gradient rather than a hand-typed one. */
function hashOf(width: number, height: number): string {
	const pixels = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = 4 * (x + y * width);
			pixels[offset] = (x * 255) / width;
			pixels[offset + 1] = (y * 255) / height;
			pixels[offset + 2] = 128 + 60 * Math.sin(x / 3);
			pixels[offset + 3] = 255;
		}
	}
	return referenceEncode(pixels, width, height, 4, 3);
}

const HASH = hashOf(32, 24);

describe('decodeBlurhash', () => {
	it('matches the reference decoder byte for byte', () => {
		const ours = decodeBlurhash(HASH, 20, 15);
		const theirs = referenceDecode(HASH, 20, 15);

		expect(ours).not.toBeNull();
		expect(Array.from(ours!)).toEqual(Array.from(theirs));
	});

	it('matches at a different aspect ratio and component count', () => {
		const wide = hashOf(48, 16);

		expect(Array.from(decodeBlurhash(wide, 20, 7)!)).toEqual(
			Array.from(referenceDecode(wide, 20, 7))
		);
	});

	it('returns null rather than a partial image for a string that is not a blurhash', () => {
		for (const hash of ['', 'abc', HASH.slice(0, -1), `${HASH}x`, `!${HASH.slice(1)}`]) {
			expect(decodeBlurhash(hash, 20, 15), JSON.stringify(hash)).toBeNull();
		}
	});
});

describe('blurhashDataUri', () => {
	it('emits a BMP data URI whose header says what it is', () => {
		const uri = blurhashDataUri(HASH, 3 / 2);

		expect(uri).toMatch(/^data:image\/bmp;base64,/);

		const bytes = Uint8Array.from(atob(uri!.split(',')[1]), (c) => c.charCodeAt(0));
		expect(String.fromCharCode(bytes[0], bytes[1])).toBe('BM');
		expect(new DataView(bytes.buffer).getUint32(2, true)).toBe(bytes.length);
		// 20 wide, and 24 bits per pixel with no compression.
		expect(new DataView(bytes.buffer).getInt32(18, true)).toBe(20);
		expect(new DataView(bytes.buffer).getUint16(28, true)).toBe(24);
	});

	it('stays small enough to inline next to every thumbnail on a page', () => {
		expect(blurhashDataUri(HASH, 3 / 2)!.length).toBeLessThan(2048);
	});

	it('follows the asset aspect ratio, within the clamp', () => {
		const heightOf = (uri: string) => {
			const bytes = Uint8Array.from(atob(uri.split(',')[1]), (c) => c.charCodeAt(0));
			return new DataView(bytes.buffer).getInt32(22, true);
		};

		expect(heightOf(blurhashDataUri(HASH, 1)!)).toBe(20);
		expect(heightOf(blurhashDataUri(HASH, 2)!)).toBe(10);
		// Clamped: a panorama still gets a placeholder with some height to it.
		expect(heightOf(blurhashDataUri(HASH, 10)!)).toBe(6);
	});

	it('renders nothing rather than something wrong when the hash is missing or bad', () => {
		for (const hash of [null, undefined, '', 'not-a-blurhash']) {
			expect(blurhashDataUri(hash, 1.5), String(hash)).toBeNull();
		}
	});
});
