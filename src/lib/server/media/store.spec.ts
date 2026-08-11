import { Headers as WorkersHeaders, Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { r2MediaStore, resolveRange, type MediaStore } from './store';

/**
 * The M4.1 done-condition: an object round-trips through local R2.
 *
 * This runs against a real R2 — Miniflare boots the same `workerd` that
 * `wrangler dev` does, so the bucket here is the implementation the deployed
 * Worker talks to rather than a hand-written double. That matters because the
 * three behaviours the media route leans on are all R2's, not ours: it parses
 * `Range` itself, it evaluates `If-None-Match` itself, and it hands back a
 * body-less object when a precondition fails. A stub would let us assume all
 * three and be wrong in production.
 */

const BODY = new TextEncoder().encode('the quick brown fox jumps over the lazy dog');
const KEY = 'img/01J00000000000000000000000/w800.webp';

let miniflare: Miniflare;
let store: MediaStore;

beforeAll(async () => {
	miniflare = new Miniflare({
		modules: true,
		script: 'export default {};',
		compatibilityDate: '2026-08-08',
		r2Buckets: ['MEDIA']
	});

	const bucket = await miniflare.getR2Bucket('MEDIA');
	store = r2MediaStore(bucket as unknown as R2Bucket);

	await store.put(KEY, BODY, { contentType: 'image/webp' });
});

afterAll(async () => {
	await miniflare?.dispose();
});

/** The whole body, whatever slice of it the store decided to send. */
async function read(body: ReadableStream<Uint8Array> | null): Promise<string> {
	expect(body).not.toBeNull();
	return new Response(body).text();
}

/**
 * Miniflare's binding proxy serialises arguments across a process boundary and
 * only knows how to carry its own `Headers`, not Node's global one. Everything
 * else in this file is the production path; this is the one seam the harness
 * imposes.
 */
const headers = (init: Record<string, string>) => new WorkersHeaders(init) as unknown as Headers;

const rangeHeaders = (value: string) => headers({ range: value });

describe('r2MediaStore', () => {
	it('round-trips an object, its size, and its content type', async () => {
		const object = await store.get(KEY);

		expect(object).not.toBeNull();
		expect(object!.size).toBe(BODY.byteLength);
		expect(object!.contentType).toBe('image/webp');
		// R2 reports a range even when none was asked for, which is why the
		// media route decides 206 from the request's `Range` header and never
		// from this field.
		expect(object!.range).toEqual({ offset: 0, length: BODY.byteLength });
		expect(await read(object!.body)).toBe('the quick brown fox jumps over the lazy dog');
	});

	it('returns null for a key that was never written', async () => {
		expect(await store.get('img/01J00000000000000000000000/nope.webp')).toBeNull();
	});

	it('resolves a bounded range into an absolute offset and length', async () => {
		const object = await store.get(KEY, { range: rangeHeaders('bytes=4-8') });

		expect(object!.range).toEqual({ offset: 4, length: 5 });
		expect(await read(object!.body)).toBe('quick');
	});

	it('resolves an open-ended range against the object size', async () => {
		const object = await store.get(KEY, { range: rangeHeaders('bytes=35-') });

		expect(object!.range).toEqual({ offset: 35, length: BODY.byteLength - 35 });
		expect(await read(object!.body)).toBe('lazy dog');
	});

	it('resolves a suffix range into an absolute offset', async () => {
		const object = await store.get(KEY, { range: rangeHeaders('bytes=-3') });

		expect(object!.range).toEqual({ offset: BODY.byteLength - 3, length: 3 });
		expect(await read(object!.body)).toBe('dog');
	});

	it('withholds the body when If-None-Match matches, and reports the same etag', async () => {
		const fresh = await store.get(KEY);
		const conditional = await store.get(KEY, {
			onlyIf: headers({ 'if-none-match': fresh!.httpEtag })
		});

		// A body-less object rather than a null one: the object exists, the
		// caller already has it, and the route turns this into a 304.
		expect(conditional).not.toBeNull();
		expect(conditional!.body).toBeNull();
		expect(conditional!.httpEtag).toBe(fresh!.httpEtag);
	});

	it('sends the body when If-None-Match does not match', async () => {
		const object = await store.get(KEY, {
			onlyIf: headers({ 'if-none-match': '"not-the-etag"' })
		});

		expect(await read(object!.body)).toContain('quick brown fox');
	});

	/**
	 * The proxy above normalises `range` on its way across the process
	 * boundary; the real binding does not. `workerd` returns one object with
	 * all three keys and `undefined` in the unused ones, which is not the
	 * three-way union the type says it is. These cases are that object.
	 */
	it('reads the range shape workerd actually returns, not the one the type describes', () => {
		expect(resolveRange({ offset: 0, length: 100, suffix: undefined } as R2Range, 316137)).toEqual({
			offset: 0,
			length: 100
		});
		expect(
			resolveRange({ offset: undefined, length: undefined, suffix: 3 } as R2Range, 43)
		).toEqual({ offset: 40, length: 3 });
		expect(
			resolveRange({ offset: 10, length: undefined, suffix: undefined } as R2Range, 43)
		).toEqual({ offset: 10, length: 33 });
		expect(resolveRange(undefined, 43)).toBeNull();
	});

	it('deletes an object so a later get finds nothing', async () => {
		const key = 'vid/01J0000000000000000000000D/poster.jpg';
		await store.put(key, new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
		expect(await store.get(key)).not.toBeNull();

		await store.delete(key);

		expect(await store.get(key)).toBeNull();
	});
});
