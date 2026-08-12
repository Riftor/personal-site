/**
 * A `Cache` double for the unit tests. **Never imported by production code.**
 *
 * Miniflare boots a real `workerd`, which is what `media/store.spec.ts` uses
 * for R2 — but its bindings are proxied across a process boundary and that
 * proxy can only carry Miniflare's own `Request`/`Response` classes, not the
 * globals the Worker builds. The calendar and token caches construct their own
 * `Request` and `Response`, so a proxied cache rejects them before the code
 * under test runs. This is the seam the harness imposes; the two behaviours
 * the callers actually depend on — match-by-URL and `Cache-Control: max-age`
 * expiry — are implemented here rather than assumed.
 */

type Entry = { body: string; headers: Headers; expiresAt: number };

export type MemoryCache = Cache & {
	/** How many entries are held. Handy for asserting a put happened at all. */
	readonly size: number;
};

const MAX_AGE = /max-age=(\d+)/i;

export function memoryCache(now: () => number = Date.now): MemoryCache {
	const entries = new Map<string, Entry>();

	const urlOf = (request: RequestInfo | URL) =>
		typeof request === 'string'
			? request
			: request instanceof URL
				? request.toString()
				: request.url;

	const cache = {
		async match(request: RequestInfo | URL) {
			const entry = entries.get(urlOf(request));
			if (!entry) return undefined;
			if (entry.expiresAt <= now()) {
				entries.delete(urlOf(request));
				return undefined;
			}
			return new Response(entry.body, { headers: entry.headers });
		},

		async put(request: RequestInfo | URL, response: Response) {
			const headers = new Headers(response.headers);
			const seconds = Number(MAX_AGE.exec(headers.get('cache-control') ?? '')?.[1] ?? 0);
			entries.set(urlOf(request), {
				body: await response.text(),
				headers,
				expiresAt: now() + seconds * 1000
			});
		},

		async delete(request: RequestInfo | URL) {
			return entries.delete(urlOf(request));
		},

		get size() {
			return entries.size;
		}
	};

	return cache as unknown as MemoryCache;
}
