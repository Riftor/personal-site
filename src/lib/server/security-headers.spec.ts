import { describe, expect, it } from 'vitest';
import {
	applySecurityHeaders,
	HSTS_MAX_AGE_SECONDS,
	PERMISSIONS_POLICY,
	REFERRER_POLICY
} from './security-headers';

const stamp = (href: string, init?: ResponseInit) =>
	applySecurityHeaders(new Response('body', init), new URL(href));

const PRODUCTION = 'https://caden.example/';
const PREVIEW = 'http://localhost:4173/';

describe('applySecurityHeaders', () => {
	it('sends the four headers plan §7.4 names, plus nosniff', () => {
		const { headers } = stamp(PRODUCTION);

		expect(headers.get('strict-transport-security')).toBe(
			`max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`
		);
		expect(headers.get('referrer-policy')).toBe(REFERRER_POLICY);
		expect(headers.get('x-frame-options')).toBe('DENY');
		expect(headers.get('x-content-type-options')).toBe('nosniff');
		expect(headers.get('permissions-policy')).toBe(PERMISSIONS_POLICY);
	});

	it('asks for a year of HSTS on subdomains too', () => {
		// A year is what the scanners and the preload list expect. If this ever
		// drops it should be a deliberate edit, not a typo nobody noticed.
		expect(HSTS_MAX_AGE_SECONDS).toBe(31_536_000);
	});

	it('does not ask for preload', () => {
		// Preload is a submission to a list that ships inside browsers and is
		// slow to undo. It is a decision for a domain that exists, and the
		// domain does not exist yet.
		expect(stamp(PRODUCTION).headers.get('strict-transport-security')).not.toContain('preload');
	});

	it('omits HSTS over plain HTTP, so `pnpm preview` cannot pin localhost', () => {
		// RFC 6797 §7.2: an HSTS host must not send the header over insecure
		// transport. A browser that honoured it on `localhost:4173` would pin
		// every port on localhost to HTTPS.
		expect(stamp(PREVIEW).headers.get('strict-transport-security')).toBeNull();

		// The rest are not transport-dependent and are sent either way.
		expect(stamp(PREVIEW).headers.get('x-frame-options')).toBe('DENY');
		expect(stamp(PREVIEW).headers.get('referrer-policy')).toBe(REFERRER_POLICY);
	});

	it('overwrites rather than appends, so /m/* does not end up with two nosniffs', () => {
		// `media/response.ts` sets `x-content-type-options` itself on every
		// answer it gives, refusals included.
		const headers = stamp(PRODUCTION, {
			headers: { 'x-content-type-options': 'nosniff' }
		}).headers.get('x-content-type-options');

		expect(headers).toBe('nosniff');
	});

	it('leaves the caching and vary headers a private response set alone', () => {
		// Invariant: private responses stay uncacheable and vary by cookie.
		// Nothing here may quietly undo that.
		const { headers } = stamp(PRODUCTION, {
			headers: { 'cache-control': 'private, no-store', vary: 'Cookie' }
		});

		expect(headers.get('cache-control')).toBe('private, no-store');
		expect(headers.get('vary')).toBe('Cookie');
	});

	it('does not set a CSP — that is `kit.csp`, which alone can nonce the bootstrap', () => {
		expect(stamp(PRODUCTION).headers.get('content-security-policy')).toBeNull();
	});

	it('returns the same response object, so it can wrap a return', () => {
		const response = new Response('body');

		expect(applySecurityHeaders(response, new URL(PRODUCTION))).toBe(response);
	});
});

describe('PERMISSIONS_POLICY', () => {
	it('denies the features the site does not use', () => {
		for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'browsing-topics']) {
			expect(PERMISSIONS_POLICY).toContain(`${feature}=()`);
		}
	});

	it('leaves the gated <video> its controls', () => {
		// `fullscreen=()` would grey out the native fullscreen button, and
		// `autoplay=()` reaches `play()`. Both are same-origin only.
		expect(PERMISSIONS_POLICY).toContain('fullscreen=(self)');
		expect(PERMISSIONS_POLICY).toContain('autoplay=(self)');
	});

	it('grants nothing to a third-party origin', () => {
		// Every allowlist in here is `()` or `(self)`. A bare origin appearing
		// would mean somebody widened one without saying why.
		expect(PERMISSIONS_POLICY).not.toMatch(/https?:/);
		expect(PERMISSIONS_POLICY).not.toContain('*');
	});
});
