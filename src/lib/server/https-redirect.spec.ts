import { describe, expect, it } from 'vitest';
import { httpsRedirectTarget, isLoopbackHostname } from './https-redirect';

const target = (href: string) => httpsRedirectTarget(new URL(href));

describe('httpsRedirectTarget', () => {
	it('sends a plain-HTTP request for the real site to HTTPS', () => {
		// The finding this exists for: `http://cadenedam.com/` served the whole
		// site in cleartext.
		expect(target('http://cadenedam.com/')).toBe('https://cadenedam.com/');
	});

	it('keeps the path and the query, so a bookmark still lands', () => {
		expect(target('http://cadenedam.com/private/photos?page=2')).toBe(
			'https://cadenedam.com/private/photos?page=2'
		);
		expect(target('http://cadenedam.com/signin?next=%2Fprivate%2Fnow')).toBe(
			'https://cadenedam.com/signin?next=%2Fprivate%2Fnow'
		);
	});

	it('drops the port, which spoke the other protocol', () => {
		expect(target('http://cadenedam.com:80/work')).toBe('https://cadenedam.com/work');
	});

	it('leaves an HTTPS request alone', () => {
		expect(target('https://cadenedam.com/private/now')).toBeNull();
	});

	// Every e2e test in the suite runs against `http://localhost:4173`, and
	// `pnpm dev` is plain HTTP on :5173. Redirecting either would be a loop
	// into a port nothing is listening on.
	it.each([
		'http://localhost:4173/private/photos',
		'http://localhost:5173/',
		'http://127.0.0.1:4173/signin',
		'http://127.0.0.2:4173/',
		'http://[::1]:4173/'
	])('leaves %s alone, because it is this machine', (href) => {
		expect(target(href)).toBeNull();
	});

	it('is not fooled by a hostname that merely contains a loopback name', () => {
		// `localhost.evil.example` resolves off-box; a suffix or substring test
		// would have handed it the exemption.
		expect(target('http://localhost.evil.example/')).toBe('https://localhost.evil.example/');
		expect(target('http://notlocalhost/')).toBe('https://notlocalhost/');
		expect(target('http://127.0.0.1.evil.example/')).toBe('https://127.0.0.1.evil.example/');
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
