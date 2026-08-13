import { describe, expect, it } from 'vitest';
import { httpsTransportFor, isLoopbackHostname } from './https-redirect';

/**
 * Plan §8.7, after the M8 review.
 *
 * The first version of this built the redirect out of the request's own `Host`
 * header, so `curl -H 'Host: attacker.example'` was answered with a 301 to
 * `attacker.example` — an open redirect on the pre-auth hop the whole layer
 * exists to protect. Most of what is below is that bug, pinned.
 *
 * What these cannot see is the scheme on the wire: `pnpm preview` runs under
 * `wrangler dev`, which rewrites the request's own origin across every
 * response header it emits. That is `e2e/https-redirect.spec.ts`'s job, and it
 * has to stand up its own server to do it.
 */

const SITE = 'https://cadenedam.com';

const decide = (href: string, configured: unknown = SITE) =>
	httpsTransportFor(new URL(href), configured);

describe('httpsTransportFor', () => {
	it('sends a cleartext request for this site to HTTPS', () => {
		// The finding this exists for: `http://cadenedam.com/` served the whole
		// site in cleartext.
		expect(decide('http://cadenedam.com/')).toEqual({
			action: 'redirect',
			location: 'https://cadenedam.com/'
		});
	});

	it('keeps the path and the query, so a bookmark still lands', () => {
		expect(decide('http://cadenedam.com/private/photos?page=2')).toEqual({
			action: 'redirect',
			location: 'https://cadenedam.com/private/photos?page=2'
		});
		expect(decide('http://cadenedam.com/signin?next=%2Fprivate%2Fnow')).toEqual({
			action: 'redirect',
			location: 'https://cadenedam.com/signin?next=%2Fprivate%2Fnow'
		});
	});

	it('drops the port, which spoke the other protocol', () => {
		expect(decide('http://cadenedam.com:8080/work')).toEqual({
			action: 'redirect',
			location: 'https://cadenedam.com/work'
		});
	});

	it('serves an HTTPS request untouched', () => {
		expect(decide('https://cadenedam.com/private/now')).toEqual({ action: 'serve' });
		// Including one whose host is not the configured site: the transport is
		// already secure, so this layer has no opinion left to have.
		expect(decide('https://anything.example/')).toEqual({ action: 'serve' });
	});

	/* ---------------------------------------------------------------- *
	 * The open redirect, and every shape of it.
	 * ---------------------------------------------------------------- */

	it('refuses a hostname that is not this site, and names it nowhere', () => {
		const decision = decide('http://attacker.example/private/photos');

		expect(decision).toEqual({ action: 'refuse' });
		// Belt and braces on the property that matters: there is no `location`
		// on a refusal at all, so there is nothing to leak the host into.
		expect(JSON.stringify(decision)).not.toContain('attacker.example');
	});

	it('refuses a hostname that merely looks like this site', () => {
		// Every one of these would have been redirected to itself by a check
		// that only asked "is this loopback?".
		for (const host of [
			'attacker.example',
			'cadenedam.com.evil.example',
			'evil-cadenedam.com',
			'wwwcadenedam.com',
			'localhost.evil.example',
			'127.0.0.1.evil.example',
			'notlocalhost'
		]) {
			expect(decide(`http://${host}/signin`), host).toEqual({ action: 'refuse' });
		}
	});

	it('refuses a subdomain, because the allowlist is one hostname and not a suffix', () => {
		// `www.cadenedam.com` is not what `BETTER_AUTH_URL` names. If it should
		// be served, it belongs in that variable, not in a pattern here.
		expect(decide('http://www.cadenedam.com/')).toEqual({ action: 'refuse' });
	});

	it('refuses rather than guesses when the site does not know its own origin', () => {
		// No configured origin means no hostname this site can prove is its
		// own. Failing closed here only ever affects a cleartext request to a
		// non-loopback name, which is the request that should not be served.
		// Called directly rather than through `decide`, whose default argument
		// would swallow the `undefined` case this most needs to cover.
		for (const bad of [undefined, null, '', '   ', 'not a url', 'https://', 42, {}]) {
			expect(httpsTransportFor(new URL('http://cadenedam.com/'), bad), JSON.stringify(bad)).toEqual(
				{ action: 'refuse' }
			);
		}
	});

	it('matches the hostname case-insensitively, the way a host is', () => {
		expect(decide('http://CADENEDAM.com/')).toEqual({
			action: 'redirect',
			location: 'https://cadenedam.com/'
		});
		expect(decide('http://cadenedam.com/', 'https://CadenEdam.COM')).toMatchObject({
			action: 'redirect'
		});
	});

	it('reads only the hostname out of the configured origin', () => {
		// The port and path of `BETTER_AUTH_URL` are none of this function's
		// business; the site is served on the default HTTPS port.
		expect(decide('http://cadenedam.com/work', 'http://cadenedam.com:5173/base')).toEqual({
			action: 'redirect',
			location: 'https://cadenedam.com/work'
		});
	});

	/* ---------------------------------------------------------------- *
	 * Loopback, which every other test in the repo depends on.
	 * ---------------------------------------------------------------- */

	it.each([
		'http://localhost:4173/private/photos',
		'http://localhost:5173/',
		'http://127.0.0.1:4173/signin',
		'http://127.0.0.2:4173/',
		'http://[::1]:4173/'
	])('serves %s, because it is this machine', (href) => {
		// `pnpm dev` and `pnpm preview` are both plain HTTP. Redirecting these
		// would be a loop; refusing them would be 91 failing e2e tests.
		expect(decide(href)).toEqual({ action: 'serve' });
	});

	it('serves loopback even when the configured origin is missing or elsewhere', () => {
		// The exemption is checked before the allowlist on purpose: local
		// development must not depend on what `BETTER_AUTH_URL` happens to say.
		expect(httpsTransportFor(new URL('http://localhost:4173/'), undefined)).toEqual({
			action: 'serve'
		});
		expect(decide('http://localhost:4173/', 'https://somewhere.else.example')).toEqual({
			action: 'serve'
		});
	});
});

describe('isLoopbackHostname', () => {
	it('covers 127.0.0.0/8 rather than just 127.0.0.1', () => {
		expect(isLoopbackHostname('127.0.0.1')).toBe(true);
		expect(isLoopbackHostname('127.255.255.255')).toBe(true);
	});

	it('rejects an out-of-range octet and a near miss', () => {
		expect(isLoopbackHostname('127.0.0.256')).toBe(false);
		expect(isLoopbackHostname('128.0.0.1')).toBe(false);
		expect(isLoopbackHostname('127.0.0')).toBe(false);
	});

	it('ignores case, the way a hostname does', () => {
		expect(isLoopbackHostname('LOCALHOST')).toBe(true);
	});
});
