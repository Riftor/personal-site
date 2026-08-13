/**
 * HTTP → HTTPS at the Worker, as defence in depth (plan §8.7).
 *
 * Found in production on 2026-08-13: plain `http://cadenedam.com` served the
 * whole site in cleartext, and a private path over HTTP redirected to
 * `http://…/signin`, so the Google sign-in hop could start unencrypted. HSTS
 * cannot close that: RFC 6797 §7.2 makes the header valid only on an HTTPS
 * response, so a browser arriving over HTTP is served, learns no policy, and
 * comes back over HTTP next time too.
 *
 * The canonical fix is Cloudflare's zone-level **Always Use HTTPS**, and it is
 * still the one that answers first — it never reaches the Worker at all. But it
 * is a dashboard toggle: invisible in this repo, revertible by anyone with
 * access to the account, and asserted by nothing that runs locally. So the
 * guarantee is stated here as well, where it can be read and tested.
 *
 * **Loopback is exempt, and that is not a convenience.** `pnpm dev` (:5173) and
 * `pnpm preview` (:4173) are both plain HTTP, and `playwright.config.ts` points
 * the whole e2e suite at `http://localhost:4173` — redirecting on protocol
 * alone would turn all 88 of those tests into a redirect loop into a port
 * nothing is listening on. The condition is therefore on the *hostname*, not
 * the protocol alone: a request is only redirected when it is both insecure and
 * addressed to a name that is not this machine.
 */

/**
 * Hostnames that mean "this machine", where plain HTTP is the normal and
 * correct transport.
 *
 * `[::1]` is how a URL spells the IPv6 loopback, brackets and all, and
 * `127.0.0.0/8` is loopback in its entirety rather than just `127.0.0.1` —
 * `http://127.0.0.2:4173` is the same interface. Nothing outside this list is
 * trusted to be local: a name like `localhost.evil.example` resolves off-box
 * and must be redirected, which is why the check is equality and a bounded
 * numeric pattern rather than a suffix match.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '[::1]', '::1']);

/** `127.x.x.x`, with every octet in range. */
const LOOPBACK_IPV4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isLoopbackHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (LOOPBACK_HOSTNAMES.has(host)) return true;

	const octets = LOOPBACK_IPV4.exec(host);
	return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * The `https:` form of `url`, or `null` when the request should be served as
 * it arrived.
 *
 * Assembled by hand rather than by assigning to `URL.protocol`, and that is
 * not a style choice: workerd's `URL` silently ignores an `http:` → `https:`
 * assignment, so the setter version shipped a 301 whose `Location` was the
 * cleartext URL the visitor already had. Building the string leaves nothing to
 * an implementation's discretion, and `https-redirect.spec.ts` pins it.
 *
 * The port is dropped along with the scheme: `https://host:80/…` would be a
 * redirect to a port that speaks the wrong protocol, and the site is only ever
 * served on the default ones. Path and query are preserved, so a bookmark to a
 * private page still lands on that page after the hop; the fragment is not,
 * because a server never sees one — the browser reattaches it itself.
 */
export function httpsRedirectTarget(url: URL): string | null {
	if (url.protocol !== 'http:') return null;
	if (isLoopbackHostname(url.hostname)) return null;

	return `https://${url.hostname}${url.pathname}${url.search}`;
}
