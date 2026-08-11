/**
 * Turning the `blurhash` string on a `media_asset` row into something a
 * `<picture>` can sit on top of while the real image loads.
 *
 * Two constraints shaped this. First, the placeholder must render for a viewer
 * with no JavaScript and must not flash — so it is decoded on the server and
 * inlined as a `data:` URI rather than painted into a canvas on mount.
 * Second, plan §1's dependency budget names the three packages allowed to
 * reach the Worker, and `blurhash` is not one of them; encoding happens in
 * `scripts/media/derive.mjs`, which is dev-only, and the decode is the sixty
 * lines below. `blurhash.spec.ts` checks them against the real library's
 * decoder so "we wrote it ourselves" does not quietly become "and it is
 * wrong".
 *
 * The output is a 20-pixel-wide BMP. BMP because it is the one raster format
 * that needs no compressor: a header and the pixels, so there is no zlib and
 * no CRC table to carry. At this size the whole data URI is around 1.3 KB,
 * which is cheaper than the round trip a separate placeholder request would
 * cost, and the browser's own smooth upscaling does the blurring.
 *
 * A blurhash is a handful of DCT coefficients. It is safe to inline into a
 * page whose images are gated, because it cannot be resolved back into the
 * photograph — it is roughly the information in a 6-pixel thumbnail.
 */

const BASE83 =
	'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

/** Widest the placeholder is rendered. Bigger buys nothing: it is a blur. */
const PLACEHOLDER_WIDTH = 20;
const MIN_PLACEHOLDER_HEIGHT = 6;
const MAX_PLACEHOLDER_HEIGHT = 20;

function decode83(value: string): number {
	let result = 0;
	for (const character of value) {
		const digit = BASE83.indexOf(character);
		if (digit === -1) return Number.NaN;
		result = result * 83 + digit;
	}
	return result;
}

const srgbToLinear = (value: number): number => {
	const v = value / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

// `trunc(x + 0.5)`, not `round(x)`. They differ on exact halves, and the
// reference implementation this is checked against uses the former.
const linearToSrgb = (value: number): number => {
	const v = Math.max(0, Math.min(1, value));
	return v <= 0.0031308
		? Math.trunc(v * 12.92 * 255 + 0.5)
		: Math.trunc((1.055 * v ** (1 / 2.4) - 0.055) * 255 + 0.5);
};

const signPow = (value: number, exponent: number): number =>
	Math.sign(value) * Math.abs(value) ** exponent;

type Component = [number, number, number];

/**
 * The coefficient grid a blurhash encodes, or `null` if the string is not one.
 *
 * Every malformed input lands on `null` rather than a partial decode: the
 * caller renders no placeholder at all, which is a slightly plainer page and
 * never a crash on the private half of the site.
 */
function decodeComponents(hash: string): { components: Component[]; numX: number } | null {
	if (hash.length < 6) return null;

	const sizeFlag = decode83(hash[0]);
	if (!Number.isFinite(sizeFlag)) return null;

	const numX = (sizeFlag % 9) + 1;
	const numY = Math.floor(sizeFlag / 9) + 1;
	if (hash.length !== 4 + 2 * numX * numY) return null;

	const quantisedMaximum = decode83(hash[1]);
	if (!Number.isFinite(quantisedMaximum)) return null;
	const maximum = (quantisedMaximum + 1) / 166;

	const dc = decode83(hash.slice(2, 6));
	if (!Number.isFinite(dc)) return null;

	const components: Component[] = [
		[srgbToLinear(dc >> 16), srgbToLinear((dc >> 8) & 255), srgbToLinear(dc & 255)]
	];

	for (let i = 1; i < numX * numY; i += 1) {
		const value = decode83(hash.slice(4 + i * 2, 6 + i * 2));
		if (!Number.isFinite(value)) return null;

		components.push([
			signPow((Math.floor(value / (19 * 19)) - 9) / 9, 2) * maximum,
			signPow(((Math.floor(value / 19) % 19) - 9) / 9, 2) * maximum,
			signPow(((value % 19) - 9) / 9, 2) * maximum
		]);
	}

	return { components, numX };
}

/** RGBA bytes, row-major from the top left, as `blurhash`'s own decoder emits. */
export function decodeBlurhash(hash: string, width: number, height: number): Uint8Array | null {
	const decoded = decodeComponents(hash);
	if (!decoded) return null;

	const { components, numX } = decoded;
	const numY = components.length / numX;
	const pixels = new Uint8Array(width * height * 4);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let r = 0;
			let g = 0;
			let b = 0;

			for (let j = 0; j < numY; j += 1) {
				for (let i = 0; i < numX; i += 1) {
					const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
					const component = components[i + j * numX];
					r += component[0] * basis;
					g += component[1] * basis;
					b += component[2] * basis;
				}
			}

			const offset = 4 * (x + y * width);
			pixels[offset] = linearToSrgb(r);
			pixels[offset + 1] = linearToSrgb(g);
			pixels[offset + 2] = linearToSrgb(b);
			pixels[offset + 3] = 255;
		}
	}

	return pixels;
}

/**
 * A 24-bit BMP: a 14-byte file header, a 40-byte BITMAPINFOHEADER, then the
 * rows bottom-up in BGR with each row padded to a multiple of four bytes.
 * That padding rule and the flipped row order are the only two things about
 * this format that catch people out.
 */
function encodeBmp(pixels: Uint8Array, width: number, height: number): Uint8Array {
	const rowStride = (width * 3 + 3) & ~3;
	const pixelBytes = rowStride * height;
	const bmp = new Uint8Array(54 + pixelBytes);
	const view = new DataView(bmp.buffer);

	bmp[0] = 0x42; // 'B'
	bmp[1] = 0x4d; // 'M'
	view.setUint32(2, bmp.length, true);
	view.setUint32(10, 54, true);
	view.setUint32(14, 40, true);
	view.setInt32(18, width, true);
	view.setInt32(22, height, true);
	view.setUint16(26, 1, true);
	view.setUint16(28, 24, true);
	view.setUint32(34, pixelBytes, true);

	for (let y = 0; y < height; y += 1) {
		const target = 54 + (height - 1 - y) * rowStride;
		for (let x = 0; x < width; x += 1) {
			const source = 4 * (x + y * width);
			bmp[target + x * 3] = pixels[source + 2];
			bmp[target + x * 3 + 1] = pixels[source + 1];
			bmp[target + x * 3 + 2] = pixels[source];
		}
	}

	return bmp;
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * A `data:` URI for the placeholder behind one asset, or `null` when there is
 * no usable hash. `aspectRatio` is width over height; a missing or silly one
 * falls back to 3:2, which is only ever a slightly wrong blur.
 */
export function blurhashDataUri(
	hash: string | null | undefined,
	aspectRatio?: number
): string | null {
	if (typeof hash !== 'string' || hash.length === 0) return null;

	const ratio = Number.isFinite(aspectRatio) && aspectRatio! > 0 ? aspectRatio! : 1.5;
	const height = Math.max(
		MIN_PLACEHOLDER_HEIGHT,
		Math.min(MAX_PLACEHOLDER_HEIGHT, Math.round(PLACEHOLDER_WIDTH / ratio))
	);

	const pixels = decodeBlurhash(hash, PLACEHOLDER_WIDTH, height);
	if (!pixels) return null;

	return `data:image/bmp;base64,${toBase64(encodeBmp(pixels, PLACEHOLDER_WIDTH, height))}`;
}
