import { PUBLIC_TIER_RANK } from '../db/schema';
import type { StoredObject, StoredRange } from './store';

/**
 * Turning a `StoredObject` into an HTTP response, and turning a refusal into
 * one that says nothing.
 *
 * Kept out of `+server.ts` so the header rules — which are the difference
 * between "private media" and "private media that a CDN cached once and now
 * serves to anybody" — are unit-testable without a Worker.
 */

/** Headers every answer from `/m/*` carries, refusals included. */
function baseHeaders(): Headers {
	return new Headers({
		// The bytes are ours to render, nobody else's to embed.
		'cross-origin-resource-policy': 'same-origin',
		'x-content-type-options': 'nosniff'
	});
}

/**
 * The refusal. Two statuses, because a subresource cannot follow a redirect:
 * an `<img>` or a `<video>` pointed at a private URL with no session must get
 * 401 rather than a 302 into the sign-in flow, which would render as a broken
 * image and tell the visitor nothing (plan §5).
 *
 * The body is the status and nothing else. It is identical for an asset that
 * exists, an asset the viewer may not read, a variant name that was never
 * generated, and an id that was never issued — so no sequence of requests here
 * enumerates what Caden has published. No `WWW-Authenticate` header either:
 * the site authenticates with a cookie, and the browser credential dialog that
 * header summons has nothing to do with Google sign-in.
 */
export function refuseMedia(reason: 'unauthenticated' | 'forbidden'): Response {
	const status = reason === 'unauthenticated' ? 401 : 403;
	const headers = baseHeaders();
	headers.set('content-type', 'text/plain; charset=utf-8');
	headers.set('cache-control', 'private, no-store');
	headers.append('vary', 'Cookie');

	return new Response(
		`${status} ${reason === 'unauthenticated' ? 'Unauthorized' : 'Forbidden'}\n`,
		{
			status,
			headers
		}
	);
}

/** A binding or a stored object that should exist and does not. Leaks nothing. */
export function mediaUnavailable(status: 404 | 500): Response {
	const headers = baseHeaders();
	headers.set('content-type', 'text/plain; charset=utf-8');
	headers.set('cache-control', 'private, no-store');

	return new Response(`${status}\n`, { status, headers });
}

/**
 * The single byte range a client asked for, clamped to the object, or `null`
 * for "no usable range: send the whole thing".
 *
 * `null` covers a missing header, a malformed one, a multi-range request, and
 * a range that starts past the end of the object. RFC 9110 lets a server
 * ignore a `Range` it does not want to honour, and answering 200 with the
 * whole object is both legal and the safest reading of a header we could not
 * make sense of — the alternative, guessing, is how a client ends up decoding
 * the wrong bytes.
 */
export function parseByteRange(header: string | null, size: number): StoredRange | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? '').trim());
	if (!match) return null;

	const [, rawStart, rawEnd] = match;
	if (rawStart === '' && rawEnd === '') return null;

	// `bytes=-N`: the last N bytes.
	if (rawStart === '') {
		const suffix = Number(rawEnd);
		if (suffix <= 0) return null;
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}

	const start = Number(rawStart);
	if (start >= size) return null;

	const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (end < start) return null;

	return { offset: start, length: end - start + 1 };
}

export type MediaResponseInit = {
	/** From `media_variant.mime`, never sniffed and never from the URL. */
	mime: string;
	/** The rank the asset demanded. Decides which caching story applies. */
	requiredRank: number;
};

/**
 * Caching, which is the header that matters.
 *
 * Gated media is `private, no-store`: not in a CDN, not on disk, not in a
 * shared cache anywhere, so a revoked grant cannot be worked around by a cache
 * that still holds the bytes. Plan §5 states the consequence plainly — every
 * private view is an R2 Class B read, which at this traffic is three orders of
 * magnitude inside the free allowance.
 *
 * Genuinely public media (`min_tier_rank = 0`) is CDN-cacheable, but for ONE
 * HOUR — not a year, and never `immutable`.
 *
 * REVIEW FINDING 2026-08-11, fixed here. This previously sent
 * `public, max-age=31536000, immutable`. A reviewer confirmed the consequence
 * live against workerd: publish an asset public, serve it once, then tighten
 * its rank in D1, and the edge keeps serving the full bytes to *anonymous*
 * requests on a cache HIT — the Worker never runs, so no access check runs
 * either. A `friend` session got a family-tier asset the same way. The window
 * was up to a year, and `scripts/media/publish.mjs` offered the exact
 * operation that triggers it (re-publishing with a stricter `--min-tier`).
 *
 * The plan called "give it a new id when tightening" an accepted procedural
 * risk. It is now an enforced one: publish.mjs refuses in-place tightening,
 * and this bounds the residual exposure to an hour for anything that slips
 * through. An hour of a mis-published photo is recoverable; a year is not.
 *
 * Do not restore `immutable` here without content-addressing the URL, which is
 * the only way a long cache lifetime and a mutable rank can safely coexist.
 */
const PUBLIC_MEDIA_MAX_AGE_SECONDS = 3600;

function cacheHeadersFor(headers: Headers, requiredRank: number): void {
	if (requiredRank <= PUBLIC_TIER_RANK) {
		headers.set('cache-control', `public, max-age=${PUBLIC_MEDIA_MAX_AGE_SECONDS}`);
		return;
	}

	headers.set('cache-control', 'private, no-store');
	headers.append('vary', 'Cookie');
}

/**
 * A 200, a 206, a 304 or a 412, built from what the store actually returned.
 *
 * `Content-Range` and `Content-Length` are always derived from the slice R2
 * says it is sending, never from what the client asked for, so the two can
 * never disagree. R2 silently ignores a range it cannot satisfy and hands back
 * the whole object; the parse above is what stops that turning into a 206 that
 * claims bytes nobody is sending.
 */
export function mediaResponse(
	request: Request,
	object: StoredObject,
	{ mime, requiredRank }: MediaResponseInit
): Response {
	const headers = baseHeaders();
	headers.set('etag', object.httpEtag);
	headers.set('accept-ranges', 'bytes');
	cacheHeadersFor(headers, requiredRank);

	// The store withheld the body: the client's precondition decided the
	// answer. `If-None-Match` / `If-Modified-Since` mean "you already have
	// it"; anything else that got us here is a failed `If-Match`.
	if (!object.body) {
		const revalidating =
			request.headers.has('if-none-match') || request.headers.has('if-modified-since');
		return new Response(null, { status: revalidating ? 304 : 412, headers });
	}

	headers.set('content-type', mime);
	headers.set('content-disposition', 'inline');

	const served = object.range ?? { offset: 0, length: object.size };
	const wholeObject = served.offset === 0 && served.length === object.size;
	const asked = parseByteRange(request.headers.get('range'), object.size);

	headers.set('content-length', String(served.length));

	if (asked !== null || !wholeObject) {
		headers.set(
			'content-range',
			`bytes ${served.offset}-${served.offset + served.length - 1}/${object.size}`
		);
		return new Response(object.body, { status: 206, headers });
	}

	return new Response(object.body, { status: 200, headers });
}
