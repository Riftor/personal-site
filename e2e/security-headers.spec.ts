import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * Plan §7.4: the security headers, proven against the real Worker rather than
 * assumed.
 *
 * A unit test cannot catch the failure that matters here. A CSP that blocks
 * hydration, or one that blocks the blurhash placeholders, is a perfectly
 * well-formed header — `security-headers.spec.ts` would pass and the site
 * would be broken. So this file does three things a unit test cannot:
 *
 *  - reads the headers off responses `wrangler dev` actually produced, on a
 *    public page, a private page and a media response;
 *  - pulls the CSP apart directive by directive and asserts the shape, so a
 *    later `'unsafe-inline'` in `script-src` fails here rather than quietly
 *    turning the header into decoration;
 *  - **watches the console for violation reports.** A blocked resource does
 *    not fail a status-code assertion; it logs `Refused to …` and renders a
 *    slightly wrong page. That log is treated as a failure.
 *
 * Two headers cannot be proven from here and are covered in the unit spec
 * instead: `Strict-Transport-Security`, which is deliberately not sent over
 * the preview server's plain HTTP (RFC 6797 §7.2), and the `preload` token,
 * which is deliberately absent.
 */

type Fixture = { email: string; tier: string | null; revoked: boolean; cookie: string };

const { cookieName, fixtures } = JSON.parse(
	readFileSync(new URL('./.access-fixtures.json', import.meta.url), 'utf8')
) as { cookieName: string; fixtures: Record<string, Fixture> };

const media = JSON.parse(
	readFileSync(new URL('./.media-fixtures.json', import.meta.url), 'utf8')
) as { familyImage: string };

const PUBLIC_PAGE = '/';
const PRIVATE_PAGE = '/private/photos';
const MEDIA = `/m/${media.familyImage}/w800.webp`;

async function signIn(context: BrowserContext, key: string, baseURL: string) {
	const fixture = fixtures[key];
	expect(fixture, `fixture "${key}" was not seeded`).toBeTruthy();

	await context.addCookies([{ name: cookieName, value: fixture.cookie, url: baseURL }]);
}

/** `script-src 'self' 'nonce-x'; img-src 'self' data:` -> a directive lookup. */
function parseCsp(header: string | undefined): Map<string, string[]> {
	expect(header, 'no Content-Security-Policy header at all').toBeTruthy();

	return new Map(
		header!
			.split(';')
			.map((directive) => directive.trim().split(/\s+/))
			.filter(([name]) => name)
			.map(([name, ...sources]) => [name, sources])
	);
}

/**
 * The headers `handle` stamps on every response. HSTS is not in the list
 * because the preview server is HTTP; see the note at the top of the file.
 */
function expectStampedHeaders(headers: Record<string, string>, where: string) {
	expect(headers['x-frame-options'], `${where}: X-Frame-Options`).toBe('DENY');
	expect(headers['x-content-type-options'], `${where}: X-Content-Type-Options`).toBe('nosniff');
	expect(headers['referrer-policy'], `${where}: Referrer-Policy`).toBe(
		'strict-origin-when-cross-origin'
	);

	const permissions = headers['permissions-policy'];
	expect(permissions, `${where}: Permissions-Policy`).toBeTruthy();
	expect(permissions, `${where}: Permissions-Policy grants a third party`).not.toMatch(/https?:/);
	expect(permissions).toContain('camera=()');

	// The header is sent once, not once per layer of the stack.
	expect(headers['x-content-type-options'], `${where}: duplicated nosniff`).not.toContain(',');
}

/** Collects anything the browser refused, so a violation fails the test. */
function watchForViolations(page: Page): string[] {
	const violations: string[] = [];

	page.on('console', (message) => {
		if (/Refused to|Content Security Policy|Permissions policy/i.test(message.text())) {
			violations.push(message.text());
		}
	});
	page.on('pageerror', (error) => violations.push(String(error)));

	return violations;
}

/* ------------------------------------------------------------------ *
 * The headers, on each of the three kinds of response.
 * ------------------------------------------------------------------ */

test('a public page carries every header', async ({ request }) => {
	const response = await request.get(PUBLIC_PAGE);

	expect(response.status()).toBe(200);
	expectStampedHeaders(response.headers(), PUBLIC_PAGE);
	expect(response.headers()['content-security-policy']).toBeTruthy();
});

test('a private page carries them too, without losing its caching rules', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);

	const response = await context.request.get(PRIVATE_PAGE, { maxRedirects: 0 });
	const headers = response.headers();

	expect(response.status()).toBe(200);
	expectStampedHeaders(headers, PRIVATE_PAGE);
	expect(headers['content-security-policy']).toBeTruthy();

	// The invariant the new headers must not have disturbed.
	expect(headers['cache-control']).toBe('private, no-store');
	expect(headers['vary']).toContain('Cookie');
});

test('a media response carries them and keeps its own headers', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	const response = await context.request.get(MEDIA, { maxRedirects: 0 });
	const headers = response.headers();

	expect(response.status()).toBe(200);
	expectStampedHeaders(headers, MEDIA);

	// `media/response.ts` set these; nothing above may have overwritten them.
	expect(headers['cross-origin-resource-policy']).toBe('same-origin');
	expect(headers['cache-control']).toBe('private, no-store');
});

test('a refused media request carries them as well', async ({ context, baseURL }) => {
	await signIn(context, 'friend', baseURL!);

	const response = await context.request.get(MEDIA, { maxRedirects: 0 });

	expect(response.status()).toBe(403);
	expectStampedHeaders(response.headers(), `${MEDIA} (403)`);
});

test('the signed-out redirect still redirects, and /signin carries the headers', async ({
	request
}) => {
	// `handle` throws its redirect and Kit builds that response after the hook
	// has returned, so the 302 itself is the one response without the stamp —
	// a deliberate trade, documented in `hooks.server.ts`. What must hold is
	// that the redirect is unchanged and the page it lands on is covered.
	const redirect = await request.get(PRIVATE_PAGE, { maxRedirects: 0 });
	expect(redirect.status()).toBe(302);
	expect(redirect.headers()['location']).toContain('/signin');

	const signin = await request.get('/signin');
	expect(signin.status()).toBe(200);
	expectStampedHeaders(signin.headers(), '/signin');
});

/* ------------------------------------------------------------------ *
 * The CSP itself.
 * ------------------------------------------------------------------ */

test('the CSP is restrictive, and every widening is one of the known ones', async ({ request }) => {
	const csp = parseCsp((await request.get(PUBLIC_PAGE)).headers()['content-security-policy']);

	expect(csp.get('default-src')).toEqual(["'self'"]);
	expect(csp.get('object-src')).toEqual(["'none'"]);
	expect(csp.get('frame-src')).toEqual(["'none'"]);
	expect(csp.get('worker-src')).toEqual(["'none'"]);
	expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
	expect(csp.get('base-uri')).toEqual(["'self'"]);
	expect(csp.get('connect-src')).toEqual(["'self'"]);
	expect(csp.get('media-src')).toEqual(["'self'"]);

	// The blurhash placeholder is a BMP data URI; everything else is ours.
	expect(csp.get('img-src')).toEqual(["'self'", 'data:']);

	// The Google sign-in hop, and nothing else off-origin.
	expect(csp.get('form-action')).toEqual(["'self'", 'https://accounts.google.com']);

	// Inline style *attributes* only — `<style>` and `<link>` stay nonce-only.
	expect(csp.get('style-src-attr')).toEqual(["'unsafe-inline'"]);
});

test("the script and style directives are hashed, not 'unsafe-inline'", async ({ request }) => {
	const csp = parseCsp((await request.get(PUBLIC_PAGE)).headers()['content-security-policy']);

	for (const name of ['script-src', 'style-src']) {
		const sources = csp.get(name);

		expect(sources, `${name} is missing`).toBeTruthy();
		expect(sources).toContain("'self'");
		// A single `'unsafe-inline'` here makes every hash in the directive
		// ignored by the browser, which is the failure this whole approach
		// exists to avoid.
		expect(sources, `${name} allows unsafe-inline`).not.toContain("'unsafe-inline'");
		expect(sources, `${name} allows unsafe-eval`).not.toContain("'unsafe-eval'");
	}

	// Kit's inline hydration bootstrap. Without this the page arrives and never
	// becomes interactive — the assertion below the fold proves that too, but
	// this says which directive went wrong when it does.
	expect(
		csp.get('script-src')!.some((source) => source.startsWith("'sha256-")),
		'script-src has no hash, so the inline bootstrap is blocked'
	).toBe(true);
});

test('the CSP is stable across requests, so refusals stay byte-identical', async ({ request }) => {
	// A per-request nonce would make two 403 pages differ by random bytes and
	// defeat the comparison `access.spec.ts` and `content.spec.ts` rely on.
	// `mode: 'hash'` in `vite.config.ts` is what keeps this true.
	const cspOf = async () => (await request.get(PUBLIC_PAGE)).headers()['content-security-policy'];

	expect(await cspOf()).toBe(await cspOf());
});

/* ------------------------------------------------------------------ *
 * And the part that only a browser can answer: does the site still work?
 * ------------------------------------------------------------------ */

test('the public page hydrates under the CSP with nothing refused', async ({ page }) => {
	const violations = watchForViolations(page);

	await page.goto(PUBLIC_PAGE);
	await expect(page.getByRole('heading', { name: 'Selected work' })).toBeVisible();

	// Client-side navigation only happens if the bootstrap script ran, so a
	// blocked `script-src` shows up here as a full page load that never
	// resolves the router — and as a violation in the list below.
	// Scoped to the nav: page copy is free to link to /about too, and an
	// unscoped locator would go ambiguous the day it does.
	await page.getByLabel('Primary').getByRole('link', { name: 'About' }).click();
	await expect(page).toHaveURL(/\/about$/);
	await expect(page.locator('h1')).toContainText('About');

	expect(violations, violations.join('\n')).toEqual([]);
});

test('a private page renders its gated media under the CSP with nothing refused', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	const violations = watchForViolations(page);

	await page.goto(PRIVATE_PAGE);
	const tile = page.locator('.tile__frame img').first();
	await expect(tile).toBeVisible();

	// The blurhash placeholder is a `style="background-image: url(data:…)"`
	// attribute. If `style-src-attr` were missing it would be stripped, the
	// console would say so, and this assertion would find no data URI.
	const placeholder = await page
		.locator('[style*="background-image"]')
		.first()
		.getAttribute('style');
	expect(placeholder, 'the blurhash placeholder was not applied').toContain('data:image/bmp');

	// And the image itself actually decoded, so `img-src 'self'` let `/m/…`
	// through rather than only the placeholder surviving. Polled because the
	// tiles are `loading="lazy"`.
	await expect
		.poll(() => tile.evaluate((image: HTMLImageElement) => image.naturalWidth))
		.toBeGreaterThan(0);

	expect(violations, violations.join('\n')).toEqual([]);
});
