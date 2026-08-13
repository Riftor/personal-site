/**
 * The response headers `handle` adds to everything (plan §7.4).
 *
 * Kept out of `hooks.server.ts` for the same reason `media/response.ts` is kept
 * out of `+server.ts`: these are the headers a scanner grades and a browser
 * enforces, and they should be assertable without standing a Worker up.
 *
 * **`Content-Security-Policy` is deliberately not here.** It is configured in
 * `vite.config.ts` under `kit.csp`, because SvelteKit is the thing that emits
 * the inline hydration script and therefore the only thing that can nonce it.
 * Hand-writing a `script-src` in this file would mean either breaking hydration
 * or writing `'unsafe-inline'`, which makes the directive decorative. Kit adds
 * the header itself, on HTML responses only; everything below is added to every
 * response, HTML or not.
 */

/**
 * One year, the value HSTS preload lists and every scanner expect. `preload` is
 * deliberately **not** sent: it is a submission to a browser-vendor list that
 * ships in binaries and is slow and unpleasant to reverse, and as of M7.4 the
 * domain does not exist yet. It is a decision to make once the site has been
 * live on HTTPS for a while, not a default to inherit.
 */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

export const HSTS_VALUE = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`;

/**
 * `strict-origin-when-cross-origin` — plan §7.4 names it, and it is also the
 * modern browser default. Stating it means the site does not inherit whatever
 * a future browser decides, and it keeps private path names out of the
 * `Referer` of any off-site link: a click from `/private/memories/cornwall`
 * sends the origin and nothing after it.
 */
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * Features this site does not use, turned off so that injected markup cannot
 * reach for them either. Two are `(self)` rather than `()` and both are the
 * gated `<video>` in `MediaGrid.svelte`: its native controls need `fullscreen`
 * to offer the fullscreen button, and `autoplay` governs `play()` — a click on
 * the controls is a user gesture and would survive `()`, but `(self)` keeps
 * the element behaving the way the markup says it does.
 *
 * `browsing-topics=()` opts the site out of Chrome's Topics API. It costs
 * nothing and a site whose entire premise is that its private half is private
 * should not be a signal in an ad-interest profile.
 */
export const PERMISSIONS_POLICY = [
	'accelerometer=()',
	'autoplay=(self)',
	'browsing-topics=()',
	'camera=()',
	'display-capture=()',
	'encrypted-media=()',
	'fullscreen=(self)',
	'geolocation=()',
	'gyroscope=()',
	'idle-detection=()',
	'local-fonts=()',
	'magnetometer=()',
	'microphone=()',
	'midi=()',
	'payment=()',
	'publickey-credentials-get=()',
	'screen-wake-lock=()',
	'serial=()',
	'usb=()',
	'xr-spatial-tracking=()'
].join(', ');

/**
 * Adds the headers to a response and hands the same response back, so it can
 * wrap a `return`.
 *
 * `set` rather than `append` throughout: `/m/*` already sends its own
 * `x-content-type-options`, and appending would produce `nosniff, nosniff` —
 * legal, ugly, and the kind of thing a scanner reports as a duplicate.
 *
 * HSTS is sent **only over HTTPS**. RFC 6797 §7.2 says a host must not send it
 * over insecure transport and that a UA must ignore it if it arrives that way,
 * so sending it unconditionally would be a no-op at best. At worst it is a
 * hazard: `pnpm preview` is plain HTTP on `localhost:4173`, and a browser that
 * honoured it there would pin every port on localhost to HTTPS and break every
 * other project on this machine. On Cloudflare the deployed origin is always
 * `https:`, so the production header is unaffected by this branch.
 */
export function applySecurityHeaders(response: Response, url: URL): Response {
	const { headers } = response;

	if (url.protocol === 'https:') {
		headers.set('strict-transport-security', HSTS_VALUE);
	}

	// Nothing on this site is ever framed, by us or by anyone. `frame-ancestors
	// 'none'` in the CSP is the directive browsers actually consult; this is
	// here for the older ones that only understand the legacy header, and
	// because securityheaders.com still grades on it.
	headers.set('x-frame-options', 'DENY');
	headers.set('x-content-type-options', 'nosniff');
	headers.set('referrer-policy', REFERRER_POLICY);
	headers.set('permissions-policy', PERMISSIONS_POLICY);

	return response;
}
