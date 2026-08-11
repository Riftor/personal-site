/**
 * Lossless removal of the JPEG segments that carry personal data.
 *
 * Plan §5 step 2 and plan §8 both make this mandatory rather than optional: a
 * family photo set published with EXIF intact publishes Caden's home address
 * to everyone holding the `family` tier, and the camera body's serial number
 * to anyone who looks. The derivatives are safe by construction — `sharp` and
 * `ffmpeg` write no metadata unless asked — but the untouched original is
 * archived in R2 too, and re-encoding it to clean it would defeat the point of
 * keeping it. So the original is cleaned by rewriting its segment list, which
 * touches no compressed data at all.
 *
 * There is no `exiftool` on this machine and none can be installed, so this is
 * a from-scratch walk of the marker table. It is short because JPEG's
 * container is short: a start marker, a run of length-prefixed segments, then
 * entropy-coded scan data that runs to the end of the file.
 */

/** Segments dropped. Everything personal a JPEG carries is in one of these. */
const DROPPED_MARKERS = new Set([
	0xe1, // APP1  — EXIF (GPS, camera model, body serial, lens serial) and XMP
	0xe3, // APP3  — Meta / stereoscopic, used by some camera makers
	0xe4, // APP4  — maker-specific
	0xe5, // APP5  — maker-specific
	0xe6, // APP6  — maker-specific
	0xe7, // APP7  — maker-specific
	0xe8, // APP8  — maker-specific
	0xe9, // APP9  — maker-specific
	0xea, // APP10 — maker-specific
	0xeb, // APP11 — maker-specific, JUMBF
	0xec, // APP12 — Ducky / PictureInfo, carries camera settings
	0xed, // APP13 — Photoshop IRB, which is where IPTC (author, location) lives
	0xef, // APP15
	0xfe // COM   — free-text comment
]);

/**
 * Segments kept, listed so the reasoning is visible rather than implied:
 *   APP0  (0xe0) JFIF density. Dropping it changes how the image is scaled.
 *   APP2  (0xe2) ICC colour profile. Dropping it shifts the colours.
 *   APP14 (0xee) Adobe transform flag. Dropping it can invert CMYK JPEGs.
 * None of the three can hold GPS or a serial number.
 */

/** Markers that stand alone with no length field. */
const STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

export function isJpeg(buffer) {
	return buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8;
}

/**
 * The APPn/COM markers present in `buffer`, in order. Only used by tests — but
 * a test that cannot see what it removed cannot prove it removed anything.
 */
export function jpegMetadataMarkers(buffer) {
	const markers = [];
	walk(buffer, (marker) => {
		if (marker >= 0xe0 && marker <= 0xef) markers.push(marker);
		if (marker === 0xfe) markers.push(marker);
	});
	return markers;
}

/**
 * Calls `visit(marker, start, end)` for each length-prefixed segment, then
 * stops at the start of scan data. Returns the offset scan data begins at, or
 * the buffer length if the file ended first.
 */
function walk(buffer, visit) {
	let offset = 2; // past SOI

	while (offset + 3 < buffer.length) {
		if (buffer[offset] !== 0xff) break; // Not a marker boundary: give up.

		const marker = buffer[offset + 1];
		if (marker === 0xff) {
			offset += 1; // Fill byte.
			continue;
		}
		if (STANDALONE.has(marker)) {
			offset += 2;
			continue;
		}

		const length = buffer.readUInt16BE(offset + 2);
		if (length < 2 || offset + 2 + length > buffer.length) break;

		visit(marker, offset, offset + 2 + length);

		// SOS: everything after this segment header is compressed scan data.
		if (marker === 0xda) return offset + 2 + length;

		offset += 2 + length;
	}

	return offset;
}

/**
 * Returns `buffer` with every metadata segment removed and every compressed
 * byte untouched. A non-JPEG is returned unchanged — the caller decides what
 * to do with a format this cannot clean, and silently passing it through here
 * would be the wrong default, which is why `derive.mjs` checks first.
 */
export function stripJpegMetadata(buffer) {
	if (!isJpeg(buffer)) return buffer;

	const kept = [buffer.subarray(0, 2)];
	let copiedTo = 2;

	walk(buffer, (marker, start, end) => {
		if (!DROPPED_MARKERS.has(marker)) return;

		kept.push(buffer.subarray(copiedTo, start));
		copiedTo = end;
	});

	// Everything from the last dropped segment onwards, scan data included.
	kept.push(buffer.subarray(copiedTo));

	return Buffer.concat(kept);
}
