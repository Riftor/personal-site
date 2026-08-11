import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffprobeStatic from 'ffprobe-static';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assetIdFor, derive, IMAGE_WIDTHS } from './derive.mjs';
import {
	ensureFixtures,
	FIXTURE_IMAGE,
	FIXTURE_VIDEO,
	readCameraTags,
	readGpsTags
} from './fixtures.mjs';

/**
 * M4.2's done-condition, plus the privacy control plan §8 calls mandatory.
 *
 * The EXIF assertions are written in the only order that proves anything: the
 * fixture is checked to *contain* GPS and a body serial first, and only then
 * checked to have lost them. A stripping test against a file that never
 * carried coordinates passes whether or not the stripper does anything, which
 * is worse than no test — it is a green light on an untested control.
 */

const FFPROBE = ffprobeStatic.path;

let workDir;
let image;
let video;

beforeAll(async () => {
	await ensureFixtures();
	workDir = mkdtempSync(join(tmpdir(), 'personal-site-derive-'));
	image = await derive(FIXTURE_IMAGE, join(workDir, ''));
}, 60_000);

afterAll(() => {
	if (workDir) rmSync(workDir, { recursive: true, force: true });
});

const variantNames = (derived) => derived.variants.map((variant) => variant.variant).sort();

function formatTags(path) {
	const output = execFileSync(FFPROBE, [
		'-v',
		'error',
		'-show_entries',
		'format_tags',
		'-of',
		'json',
		path
	]).toString('utf8');

	return JSON.parse(output).format?.tags ?? {};
}

/**
 * `-movflags +faststart` moves the `moov` atom in front of `mdat`. Without it
 * a browser cannot start playing — or seek — until the whole file has arrived,
 * which would make the range requests the media route serves pointless.
 */
function moovPrecedesMdat(path) {
	const bytes = readFileSync(path);
	return bytes.indexOf('moov') < bytes.indexOf('mdat');
}

describe('the image fixture, before anything touches it', () => {
	it('genuinely carries GPS coordinates', () => {
		const gps = readGpsTags(FIXTURE_IMAGE);

		expect(
			gps,
			'the fixture has no GPS, so the stripping test below proves nothing'
		).not.toBeNull();
		// GPSLatitude (2) and GPSLongitude (4), as EXIF rationals.
		expect(gps[2]).toEqual([
			[50, 1],
			[9, 1],
			[1728, 100]
		]);
		expect(gps[4]).toEqual([
			[5, 1],
			[4, 1],
			[1488, 100]
		]);
	});

	it('genuinely carries a camera model and body serial', () => {
		expect(readCameraTags(FIXTURE_IMAGE)).toEqual({
			model: 'FX-1 Bodycam',
			bodySerial: 'FX1-000-4815162342',
			lensSerial: 'LN-2718281828'
		});
	});
});

describe('the video fixture, before anything touches it', () => {
	it('genuinely carries a container location tag', () => {
		expect(formatTags(FIXTURE_VIDEO).location).toBe('+50.1548-005.0708/');
	});
});

describe('deriving an image', () => {
	it('emits AVIF and WebP at every width in the plan', () => {
		expect(variantNames(image)).toEqual(
			IMAGE_WIDTHS.flatMap((width) => [`w${width}.avif`, `w${width}.webp`]).sort()
		);
	});

	it('records the displayed dimensions and a blurhash placeholder', () => {
		expect(image).toMatchObject({ kind: 'image', width: 2000, height: 1333, durationS: null });
		expect(image.blurhash).toMatch(/^[\w#$%*+,\-.:;=?@[\]^{|}~]{20,}$/);
	});

	it('resizes down to each width without enlarging past the source', () => {
		for (const width of IMAGE_WIDTHS) {
			const variant = image.variants.find((v) => v.variant === `w${width}.avif`);
			expect(variant.width, `w${width}`).toBe(width);
		}
	});

	it('strips GPS and the camera serials from the archived original', () => {
		expect(readGpsTags(image.original.path)).toBeNull();
		expect(readCameraTags(image.original.path)).toEqual({
			model: null,
			bodySerial: null,
			lensSerial: null
		});
	});

	it('leaves the compressed image data untouched while doing it', () => {
		// A lossless rewrite of the segment list, not a re-encode: the output
		// is smaller by roughly the size of the EXIF block and no more.
		const before = readFileSync(FIXTURE_IMAGE).length;
		expect(image.original.bytes).toBeLessThan(before);
		expect(before - image.original.bytes).toBeLessThan(2048);
	});

	it('publishes no derivative carrying EXIF at all', async () => {
		for (const variant of image.variants) {
			const metadata = await sharp(variant.path).metadata();
			expect(metadata.exif, variant.variant).toBeUndefined();
		}
	});
});

describe('deriving a video', () => {
	beforeAll(async () => {
		video = await derive(FIXTURE_VIDEO, workDir);
	}, 120_000);

	it('emits 720p, 1080p and a poster frame', () => {
		expect(variantNames(video)).toEqual(['1080.mp4', '720.mp4', 'poster.jpg']);
	});

	it('records the source dimensions, duration and a blurhash from the poster', () => {
		expect(video).toMatchObject({ kind: 'video', width: 1920, height: 1080 });
		expect(video.durationS).toBeCloseTo(2, 1);
		expect(video.blurhash.length).toBeGreaterThan(20);
	});

	it('scales to each height without upscaling', () => {
		expect(video.variants.find((v) => v.variant === '720.mp4')).toMatchObject({
			width: 1280,
			height: 720
		});
		expect(video.variants.find((v) => v.variant === '1080.mp4')).toMatchObject({
			width: 1920,
			height: 1080
		});
	});

	it('strips the container location tag from every object it publishes', () => {
		for (const path of [
			video.original.path,
			...video.variants.filter((v) => v.variant.endsWith('.mp4')).map((v) => v.path)
		]) {
			expect(formatTags(path).location, path).toBeUndefined();
			expect(formatTags(path)['location-eng'], path).toBeUndefined();
		}
	});

	it('strips EXIF from the poster too', async () => {
		const poster = video.variants.find((v) => v.variant === 'poster.jpg');

		expect((await sharp(poster.path).metadata()).exif).toBeUndefined();
	});

	it('puts the moov atom first so playback and seeking can start early', () => {
		expect(moovPrecedesMdat(video.original.path)).toBe(true);
		for (const variant of video.variants.filter((v) => v.variant.endsWith('.mp4'))) {
			expect(moovPrecedesMdat(variant.path), variant.variant).toBe(true);
		}
	});
});

describe('assetIdFor', () => {
	it('is stable for the same entry and filename, which is what makes re-publishing a no-op', () => {
		expect(assetIdFor('cornwall', 'beach.jpg')).toBe(assetIdFor('cornwall', 'beach.jpg'));
	});

	it('is the 26-character Crockford shape the media route validates', () => {
		expect(assetIdFor('cornwall', 'beach.jpg')).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
	});

	it('separates two files with the same name in different entries', () => {
		expect(assetIdFor('cornwall', 'beach.jpg')).not.toBe(assetIdFor('devon', 'beach.jpg'));
	});

	it('leaks neither the entry slug nor the filename', () => {
		const id = assetIdFor('cornwall', 'beach.jpg');

		expect(id.toLowerCase()).not.toContain('cornwall');
		expect(id.toLowerCase()).not.toContain('beach');
	});
});

describe('content hashing', () => {
	it('hashes the source, so an unchanged file publishes the same hash twice', async () => {
		const again = await derive(FIXTURE_IMAGE, workDir);

		expect(again.contentHash).toBe(image.contentHash);
	});
});
