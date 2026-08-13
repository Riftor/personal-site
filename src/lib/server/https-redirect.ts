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
 * **The destination is an allowlist of one, and that is the whole design.**
 * The first version of this file built `https://${url.hostname}${…}` from the
 * request's own `Host` header and checked only that it was not loopback. The
 * M8 review pointed a spoofed header at it:
 *
 *     curl -H 'Host: attacker.example' http://…/private/photos
 *     -> 301 Location: http://attacker.example/private/photos
 *
 * An open redirect, firing *before* `resolveViewer`, on exactly the pre-auth
 * hop this layer exists to protect — a link to `http://cadenedam.com/signin`
 * could have bounced a visitor to somebody else's login page. `Host` is
 * attacker-controlled input like any other header, and the only safe use of it
 * here is as a value to *compare*, never as a value to emit. So the hostname is
 * matched against `BETTER_AUTH_URL`, the origin the deployment already knows
 * itself by, and the redirect is built from the configured hostname rather than
 * from the request's. A request naming anything else is refused with a bare
 * 400 that repeats none of it back.
 *
 * The same applies when `BETTER_AUTH_URL` is missing or unparseable: there is
 * then no hostname this site can prove is its own, and the answer is a refusal
 * rather than a guess. That fails closed and costs nothing real — it can only
 * ever affect a cleartext request to a non-loopback name, which is precisely
 * the request that should not be served anyway.
 *
 * **Loopback is exempt, and that is not a convenience.** `pnpm dev` (:5173) and
 * `pnpm preview` (:4173) are both plain HTTP, and `playwright.config.ts` points
 * the whole e2e suite at `http://localhost:4173` — refusing or redirecting on
 * protocol alone would take every one of those tests with it. The condition is
 * therefore on the *hostname*, not the protocol alone.
 */

/**
 * Hostnames that mean "this machine", where plain HTTP is the normal and
 * correct transport.
 *
 * `[::1]` is how a URL spells the IPv6 loopback, brackets and all, and
 * `127.0.0.0/8` is loopback in its entirety rather than just `127.0.0.1` —
 * `http://127.0.0.2:4173` is the same interface. Nothing outside this list is
 * trusted to be local: a name like `localhost.evil.example` resolves off-box,
 * which is why the check is equality and a bounded numeric pattern rather than
 * a suffix match.
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
 * What `handle` should do about the transport this request arrived on.
 *
 * Three answers rather than a nullable string, because "refuse" is a real
 * outcome here and collapsing it into either of the others would either serve
 * a request addressed to a name this site does not answer to, or redirect one.
 */
export type TransportDecision =
	{ action: 'serve' } | { action: 'redirect'; location: string } | { action: 'refuse' };

const SERVE: TransportDecision = Object.freeze({ action: 'serve' });
const REFUSE: TransportDecision = Object.freeze({ action: 'refuse' });

/** The hostname a configured origin names, or `null` if it names none. */
function canonicalHostname(origin: unknown): string | null {
	if (typeof origin !== 'string' || origin.length === 0) return null;

	try {
		const hostname = new URL(origin).hostname.toLowerCase();
		return hostname.length > 0 ? hostname : null;
	} catch {
		return null;
	}
}

/**
 * The decision for one request, given the origin this deployment knows itself
 * by (`BETTER_AUTH_URL`).
 *
 * The target is assembled by hand rather than by assigning to `URL.protocol`,
 * and that is not a style choice: workerd's `URL` silently ignores an
 * `http:` → `https:` assignment, so the setter version produced a 301 back to
 * the cleartext URL the visitor already had. Building the string leaves nothing
 * to an implementation's discretion.
 *
 * Its hostname comes from `canonical`, not from `url` — they are equal by the
 * time the line runs, but sourcing it from the allowlist rather than from the
 * request is what makes "a `Host` header can never reach a `Location`" true by
 * construction rather than by argument.
 *
 * The port is dropped along with the scheme: `https://host:80/…` would be a
 * redirect to a port that speaks the wrong protocol, and the site is only ever
 * served on the default ones. Path and query are preserved, so a bookmark to a
 * private page still lands on that page after the hop; the fragment is not,
 * because a server never sees one — the browser reattaches it itself.
 */
export function httpsTransportFor(url: URL, configuredOrigin: unknown): TransportDecision {
	if (url.protocol !== 'http:') return SERVE;

	const hostname = url.hostname.toLowerCase();
	if (isLoopbackHostname(hostname)) return SERVE;

	const canonical = canonicalHostname(configuredOrigin);
	if (canonical === null || canonical !== hostname) return REFUSE;

	return { action: 'redirect', location: `https://${canonical}${url.pathname}${url.search}` };
}
