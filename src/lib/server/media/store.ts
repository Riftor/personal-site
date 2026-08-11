/**
 * The object-storage seam (plan §1, "the honest case against Cloudflare").
 *
 * R2 bindings are the least portable thing in this codebase, so every byte
 * that leaves storage goes through this interface and the only file that names
 * `R2Bucket` is the implementation below. R2 speaks the S3 API, so the exit
 * hatch — an S3/MinIO implementation of the same three methods — is genuinely
 * small, and nothing above this line would change.
 *
 * The shape is R2's rather than an invention of ours, because the two
 * properties the media route depends on are exactly the two R2 gives for free:
 * conditional gets and byte ranges resolved by the store, so a 500 MB video is
 * never read into Worker memory to serve a 1 KB slice of it.
 */

/** A resolved byte range: absolute offset into the object, and a length. */
export type StoredRange = { offset: number; length: number };

export type StoredObject = {
	/** Size of the whole object, not of the range being returned. */
	size: number;
	/** Quoted and ready to be an `ETag` header value. */
	httpEtag: string;
	contentType: string | null;
	/**
	 * The slice actually being returned, resolved to an absolute offset and
	 * length. **Not** a signal that the caller asked for a range: R2 reports
	 * `{ offset: 0, length: size }` for an unconditioned get, so only the
	 * presence of a `Range` header on the request can decide 200 versus 206.
	 * `store.spec.ts` pins that behaviour.
	 */
	range: StoredRange | null;
	/**
	 * `null` when the caller's `onlyIf` preconditions were not met and the
	 * store is deliberately sending no bytes. The caller decides whether that
	 * is a 304 or a 412 — it is the only one that can see which condition
	 * header was sent.
	 */
	body: ReadableStream<Uint8Array> | null;
};

export type GetOptions = {
	/** The request's own headers. The store parses `Range` out of them. */
	range?: Headers;
	/** The request's own headers. The store parses the `If-*` family. */
	onlyIf?: Headers;
};

export interface MediaStore {
	/** `null` means no such object. Never throws for a missing key. */
	get(key: string, options?: GetOptions): Promise<StoredObject | null>;
	put(
		key: string,
		body: ArrayBuffer | ArrayBufferView,
		options?: { contentType?: string }
	): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * R2's `range` is a three-way union — an offset, a length, or a suffix, any of
 * which may be partial — and the media route needs one canonical
 * `offset`/`length` pair to build `Content-Range` from. Resolving it here
 * rather than at the call site keeps that arithmetic in one place, where the
 * object's real size is known.
 *
 * Every field is checked with `typeof`, not with `in`. The union is a *type*;
 * what `workerd` actually hands back is one object carrying all three keys
 * with the unused ones set to `undefined`, so `'suffix' in range` is true for
 * a plain `bytes=0-99` and `Math.min(undefined, size)` is `NaN`. That produced
 * a `Content-Range: bytes NaN-NaN/316137` in the e2e suite before this was
 * written this way; do not simplify it back to `in` and `??`.
 */
export function resolveRange(range: R2Range | undefined, size: number): StoredRange | null {
	if (!range) return null;

	const { offset, length, suffix } = range as {
		offset?: number;
		length?: number;
		suffix?: number;
	};

	if (typeof suffix === 'number') {
		const clamped = Math.min(suffix, size);
		return { offset: size - clamped, length: clamped };
	}

	const start = typeof offset === 'number' ? offset : 0;
	return { offset: start, length: typeof length === 'number' ? length : size - start };
}

/** Whether an `R2Object` is the flavour that carries bytes. */
function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
	return 'body' in object;
}

export function r2MediaStore(bucket: R2Bucket): MediaStore {
	return {
		async get(key, options = {}) {
			const object = await bucket.get(key, {
				range: options.range,
				onlyIf: options.onlyIf
			});

			if (!object) return null;

			return {
				size: object.size,
				httpEtag: object.httpEtag,
				contentType: object.httpMetadata?.contentType ?? null,
				range: resolveRange(object.range, object.size),
				body: hasBody(object) ? object.body : null
			};
		},

		async put(key, body, options = {}) {
			await bucket.put(key, body, {
				httpMetadata: options.contentType ? { contentType: options.contentType } : undefined
			});
		},

		async delete(key) {
			await bucket.delete(key);
		}
	};
}
