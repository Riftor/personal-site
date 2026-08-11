import { describe, expect, it } from 'vitest';
import { mediaResponse, parseByteRange, refuseMedia } from './response';
import type { StoredObject, StoredRange } from './store';

const SIZE = 1000;

function objectWith(range: StoredRange | null, body: string | null = 'x'): StoredObject {
	return {
		size: SIZE,
		httpEtag: '"abc123"',
		contentType: 'video/mp4',
		range,
		body: body === null ? null : new Response(body).body
	};
}

const get = (headers: Record<string, string> = {}) =>
	new Request('https://example.test/m/01K3ZQ7B9C0000000000000101/720.mp4', { headers });

const serve = (request: Request, object: StoredObject, requiredRank = 20) =>
	mediaResponse(request, object, { mime: 'video/mp4', requiredRank });

describe('parseByteRange', () => {
	it('reads a bounded range', () => {
		expect(parseByteRange('bytes=0-99', SIZE)).toEqual({ offset: 0, length: 100 });
		expect(parseByteRange('bytes=100-199', SIZE)).toEqual({ offset: 100, length: 100 });
	});

	it('reads an open-ended range to the end of the object', () => {
		expect(parseByteRange('bytes=900-', SIZE)).toEqual({ offset: 900, length: 100 });
	});

	it('reads a suffix range, clamped to the object', () => {
		expect(parseByteRange('bytes=-50', SIZE)).toEqual({ offset: 950, length: 50 });
		expect(parseByteRange('bytes=-99999', SIZE)).toEqual({ offset: 0, length: SIZE });
	});

	it('clamps an end past the last byte rather than over-promising', () => {
		expect(parseByteRange('bytes=990-99999', SIZE)).toEqual({ offset: 990, length: 10 });
	});

	it('ignores a header it cannot make sense of', () => {
		for (const header of [
			null,
			'',
			'bytes=',
			'bytes=abc',
			'bytes=5-2',
			'bytes=-0',
			'items=0-10',
			// Multi-range. Answering it would mean multipart/byteranges; a 200
			// with the whole object is legal and far less to get wrong.
			'bytes=0-10,20-30'
		]) {
			expect(parseByteRange(header, SIZE), String(header)).toBeNull();
		}
	});

	it('ignores a range that starts past the end of the object', () => {
		expect(parseByteRange('bytes=1000-1100', SIZE)).toBeNull();
	});
});

describe('mediaResponse', () => {
	it('serves a whole object as 200 with a length and an etag', () => {
		const response = serve(get(), objectWith({ offset: 0, length: SIZE }));

		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe(String(SIZE));
		expect(response.headers.get('etag')).toBe('"abc123"');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('content-type')).toBe('video/mp4');
		expect(response.headers.get('content-range')).toBeNull();
	});

	it('serves a range as 206 with a Content-Range describing the bytes actually sent', () => {
		const response = serve(get({ range: 'bytes=0-99' }), objectWith({ offset: 0, length: 100 }));

		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 0-99/1000');
		expect(response.headers.get('content-length')).toBe('100');
	});

	it('describes the slice the store returned, not the one the client asked for', () => {
		// R2 silently ignores a range it cannot satisfy and returns everything.
		// A 206 claiming `bytes 2000-2099` would be a lie about the body.
		const response = serve(
			get({ range: 'bytes=2000-2099' }),
			objectWith({ offset: 0, length: SIZE })
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-range')).toBeNull();
		expect(response.headers.get('content-length')).toBe(String(SIZE));
	});

	it('answers a revalidating conditional request with 304 and no body', async () => {
		const response = serve(get({ 'if-none-match': '"abc123"' }), objectWith(null, null));

		expect(response.status).toBe(304);
		expect(await response.text()).toBe('');
		expect(response.headers.get('etag')).toBe('"abc123"');
	});

	it('answers a failed If-Match with 412 rather than pretending it is fresh', () => {
		const response = serve(get({ 'if-match': '"stale"' }), objectWith(null, null));

		expect(response.status).toBe(412);
	});

	it('marks gated media uncacheable and varying by cookie', () => {
		const response = serve(get(), objectWith({ offset: 0, length: SIZE }), 20);

		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('vary')).toContain('Cookie');
	});

	it('lets genuinely public media be cached, and does not vary it by cookie', () => {
		const response = serve(get(), objectWith({ offset: 0, length: SIZE }), 0);

		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('vary')).toBeNull();
	});

	it('keeps a gated 304 out of shared caches too', () => {
		const response = serve(get({ 'if-none-match': '"abc123"' }), objectWith(null, null), 20);

		expect(response.headers.get('cache-control')).toBe('private, no-store');
	});

	it('never lets a browser sniff the type or another origin embed the bytes', () => {
		const response = serve(get(), objectWith({ offset: 0, length: SIZE }));

		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
		expect(response.headers.get('content-disposition')).toBe('inline');
	});
});

describe('refuseMedia', () => {
	it('answers a subresource with no session 401, never a redirect', async () => {
		const response = refuseMedia('unauthenticated');

		expect(response.status).toBe(401);
		expect(response.headers.get('location')).toBeNull();
		expect(await response.text()).toBe('401 Unauthorized\n');
	});

	it('answers an insufficient tier 403', async () => {
		const response = refuseMedia('forbidden');

		expect(response.status).toBe(403);
		expect(await response.text()).toBe('403 Forbidden\n');
	});

	it('says nothing about the asset and is never cached', () => {
		const response = refuseMedia('forbidden');

		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('vary')).toContain('Cookie');
		expect(response.headers.get('etag')).toBeNull();
		expect(response.headers.get('content-range')).toBeNull();
	});
});
