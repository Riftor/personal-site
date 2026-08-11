#!/usr/bin/env node
/**
 * Synthesises the media the tests run against.
 *
 * Caden's own photos are not test fixtures — they are the thing this site
 * exists to protect, and a suite that reads them would put private files on a
 * path anyone running `pnpm test` walks. So the pipeline is exercised against
 * files this script makes: a photograph-shaped JPEG and a short H.264 clip,
 * both written under a gitignored path. The generator is committed; the bytes
 * are not.
 *
 * The image is deliberately given **real GPS EXIF, a camera model and a body
 * serial number** before anything touches it. A stripping test against a file
 * that never had GPS proves nothing at all, so `derive.spec.mjs` asserts the
 * tags are present here first and absent afterwards.
 *
 *   node scripts/media/fixtures.mjs [--force]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import piexif from 'piexifjs';
import sharp from 'sharp';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Gitignored via the existing `content/**\/media` rule. */
export const FIXTURE_DIR = join(REPO_ROOT, 'content', '_fixtures', 'media');
export const FIXTURE_IMAGE = join(FIXTURE_DIR, 'harbour.jpg');
export const FIXTURE_VIDEO = join(FIXTURE_DIR, 'clip.mp4');

/**
 * A real location — 50.1548 N, 5.0708 W is Porthleven harbour — because the
 * point of the fixture is that it is exactly as revealing as a holiday photo
 * off a phone. Encoded as EXIF rationals: degrees, minutes, seconds.
 */
const GPS = {
	latitude: [
		[50, 1],
		[9, 1],
		[1728, 100]
	],
	longitude: [
		[5, 1],
		[4, 1],
		[1488, 100]
	]
};

const jpegWithExif = (jpeg, exif) =>
	Buffer.from(piexif.insert(exif, jpeg.toString('binary')), 'binary');

/** A gradient with some structure in it, so resizing and blurhash have work to do. */
async function paintImage() {
	const width = 2000;
	const height = 1333;
	const pixels = Buffer.alloc(width * height * 3);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const offset = (y * width + x) * 3;
			const wave = Math.sin(x / 90) * Math.cos(y / 70);
			pixels[offset] = Math.round(120 + 90 * wave);
			pixels[offset + 1] = Math.round(140 + 70 * Math.sin((x + y) / 160));
			pixels[offset + 2] = Math.round(170 + 60 * Math.cos(y / 120));
		}
	}

	return sharp(pixels, { raw: { width, height, channels: 3 } })
		.jpeg({ quality: 90 })
		.toBuffer();
}

export async function writeImageFixture() {
	const exif = piexif.dump({
		'0th': {
			[piexif.ImageIFD.Make]: 'Fixture Optics',
			[piexif.ImageIFD.Model]: 'FX-1 Bodycam',
			[piexif.ImageIFD.XResolution]: [72, 1],
			[piexif.ImageIFD.YResolution]: [72, 1]
		},
		Exif: {
			[piexif.ExifIFD.DateTimeOriginal]: '2026:07:14 09:12:33',
			[piexif.ExifIFD.BodySerialNumber]: 'FX1-000-4815162342',
			[piexif.ExifIFD.LensSerialNumber]: 'LN-2718281828'
		},
		GPS: {
			[piexif.GPSIFD.GPSVersionID]: [2, 3, 0, 0],
			[piexif.GPSIFD.GPSLatitudeRef]: 'N',
			[piexif.GPSIFD.GPSLatitude]: GPS.latitude,
			[piexif.GPSIFD.GPSLongitudeRef]: 'W',
			[piexif.GPSIFD.GPSLongitude]: GPS.longitude,
			[piexif.GPSIFD.GPSAltitudeRef]: 0,
			[piexif.GPSIFD.GPSAltitude]: [12, 1]
		}
	});

	writeFileSync(FIXTURE_IMAGE, jpegWithExif(await paintImage(), exif));
	return FIXTURE_IMAGE;
}

/**
 * Two seconds of `testsrc2` at 1080p with a tone, and a location tag in the
 * container — which is where a phone puts the coordinates for a video, EXIF
 * being an image-only thing. `-map_metadata -1` in the pipeline is what has to
 * remove it, and this is what gives it something to remove.
 */
export function writeVideoFixture() {
	execFileSync(ffmpegPath, [
		'-hide_banner',
		'-loglevel',
		'error',
		'-y',
		'-f',
		'lavfi',
		'-i',
		'testsrc2=size=1920x1080:rate=15:duration=2',
		'-f',
		'lavfi',
		'-i',
		'sine=frequency=440:duration=2',
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-crf',
		'26',
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		'-b:a',
		'96k',
		'-metadata',
		'location=+50.1548-005.0708/',
		'-metadata',
		'location-eng=+50.1548-005.0708/',
		'-metadata',
		'make=Fixture Optics',
		'-metadata',
		'model=FX-1 Bodycam',
		FIXTURE_VIDEO
	]);

	return FIXTURE_VIDEO;
}

/** Both fixtures, generated only if they are not already on disk. */
export async function ensureFixtures({ force = false } = {}) {
	mkdirSync(FIXTURE_DIR, { recursive: true });

	if (force || !existsSync(FIXTURE_IMAGE)) await writeImageFixture();
	if (force || !existsSync(FIXTURE_VIDEO)) writeVideoFixture();

	return { image: FIXTURE_IMAGE, video: FIXTURE_VIDEO };
}

/** The GPS block a fixture carries, or `null`. Used by tests on both sides. */
export function readGpsTags(jpegPath) {
	const exif = piexif.load(readFileSync(jpegPath).toString('binary'));
	const gps = exif.GPS ?? {};

	return Object.keys(gps).length > 0 ? gps : null;
}

/** The camera identity a fixture carries: model, and the body/lens serials. */
export function readCameraTags(jpegPath) {
	const exif = piexif.load(readFileSync(jpegPath).toString('binary'));

	return {
		model: exif['0th']?.[piexif.ImageIFD.Model] ?? null,
		bodySerial: exif.Exif?.[piexif.ExifIFD.BodySerialNumber] ?? null,
		lensSerial: exif.Exif?.[piexif.ExifIFD.LensSerialNumber] ?? null
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { image, video } = await ensureFixtures({ force: process.argv.includes('--force') });
	console.error(`fixtures: ${image}\nfixtures: ${video}`);
}
