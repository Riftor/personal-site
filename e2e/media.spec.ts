import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * Done-condition #6 and M4.5: private media is served through the Worker, the
 * tier is re-checked on every fetch, and a media URL is not a bearer token.
 *
 * Written the same way as `access.spec.ts` and for the same reason: every
 * request here is made against the raw `/m/...` URL with no page in front of
 * it, because that is the threat — a URL pasted into a chat, or an `<img>`
 * pointed at the site from somewhere else.
 *
 * The two statuses are asserted separately and exactly. A signed-out request
 * for a subresource must be **401**, never a 302 to `/signin`: an `<img>`
 * cannot follow a login flow, and a redirect here would render as a broken
 * image and hide the reason. An under-privileged request must be **403**.
 */

type Fixture = { email: string; tier: string | null; revoked: boolean; cookie: string };

const { cookieName, fixtures } = JSON.parse(
	readFileSync(new URL('./.access-fixtures.json', import.meta.url), 'utf8')
) as { cookieName: string; fixtures: Record<string, Fixture> };

const media = JSON.parse(
	readFileSync(new URL('./.media-fixtures.json', import.meta.url), 'utf8')
) as {
	familyImage: string;
	partnerImage: string;
	familyVideo: string;
	draftEntryAsset: string;
	orphanAsset: string;
	badRankAsset: string;
};

const url = (assetId: string, variant: string) => `/m/${assetId}/${variant}`;

const VIDEO = url(media.familyVideo, '720.mp4');
const IMAGE = url(media.familyImage, 'w800.webp');
const PARTNER_IMAGE = url(media.partnerImage, 'w800.webp');

async function signIn(context: BrowserContext, key: string, baseURL: string) {
	const fixture = fixtures[key];
	expect(fixture, `fixture "${key}" was not seeded`).toBeTruthy();

	await context.addCookies([{ name: cookieName, value: fixture.cookie, url: baseURL }]);
	return fixture;
}

/* ------------------------------------------------------------------ *
 * The two the milestone names explicitly.
 * ------------------------------------------------------------------ */

test('the video URL with no cookie at all returns 401, not a redirect', async ({ request }) => {
	const response = await request.get(VIDEO, { maxRedirects: 0 });

	expect(response.status()).toBe(401);
	expect(response.headers()['location']).toBeUndefined();
	// It is not the sign-in page in disguise either.
	expect(await response.text()).not.toContain('Continue with Google');
});

test('an under-privileged session gets 403 on the raw media URL', async ({ context, baseURL }) => {
	await signIn(context, 'friend', baseURL!);

	const response = await context.request.get(IMAGE, { maxRedirects: 0 });

	expect(response.status()).toBe(403);
});

/* ------------------------------------------------------------------ *
 * Range, conditional requests, and the headers.
 * ------------------------------------------------------------------ */

test('an authorized ranged request is a 206 with a Content-Range', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	const response = await context.request.get(VIDEO, {
		headers: { Range: 'bytes=0-99' },
		maxRedirects: 0
	});

	expect(response.status()).toBe(206);
	expect(response.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
	expect(response.headers()['content-length']).toBe('100');
	expect(response.headers()['accept-ranges']).toBe('bytes');
	expect((await response.body()).length).toBe(100);
});

test('a second range returns different bytes, so seeking works', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	const head = await context.request.get(VIDEO, { headers: { Range: 'bytes=0-15' } });
	const later = await context.request.get(VIDEO, { headers: { Range: 'bytes=2000-2015' } });

	expect(later.status()).toBe(206);
	expect(later.headers()['content-range']).toMatch(/^bytes 2000-2015\/\d+$/);
	expect((await later.body()).equals(await head.body())).toBe(false);
});

test('every range request re-checks the tier; a media URL is not a bearer token', async ({
	context,
	baseURL
}) => {
	// The family session fetches a range successfully, then the same URL and
	// the same range is asked for by a friend session in a fresh context. If
	// the first fetch had minted anything reusable, the second would work.
	await signIn(context, 'family', baseURL!);
	expect((await context.request.get(VIDEO, { headers: { Range: 'bytes=0-99' } })).status()).toBe(
		206
	);

	await context.clearCookies();
	await signIn(context, 'friend', baseURL!);

	const refused = await context.request.get(VIDEO, {
		headers: { Range: 'bytes=0-99' },
		maxRedirects: 0
	});
	expect(refused.status()).toBe(403);
});

test('a matching If-None-Match gets a 304 with no body', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	const first = await context.request.get(IMAGE);
	const etag = first.headers()['etag'];
	expect(etag).toBeTruthy();

	const second = await context.request.get(IMAGE, { headers: { 'If-None-Match': etag } });

	expect(second.status()).toBe(304);
	expect((await second.body()).length).toBe(0);
});

test('gated media is marked uncacheable and varies by cookie', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	const response = await context.request.get(IMAGE);

	expect(response.status()).toBe(200);
	expect(response.headers()['cache-control']).toBe('private, no-store');
	expect(response.headers()['vary']).toContain('Cookie');
	expect(response.headers()['content-type']).toBe('image/webp');
	expect(response.headers()['x-content-type-options']).toBe('nosniff');
	expect(response.headers()['cross-origin-resource-policy']).toBe('same-origin');
});

/* ------------------------------------------------------------------ *
 * Default deny. Every one of these refuses, and none of them says why.
 * ------------------------------------------------------------------ */

test('a per-asset tier can be stricter than the set it sits in', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	// Same entry, same page, one rank higher on the asset row.
	expect((await context.request.get(IMAGE)).status()).toBe(200);
	expect((await context.request.get(PARTNER_IMAGE, { maxRedirects: 0 })).status()).toBe(403);
});

test('a partner session reads the stricter asset the family session could not', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'partner', baseURL!);

	expect((await context.request.get(PARTNER_IMAGE)).status()).toBe(200);
});

test('unknown ids, unknown variants and broken rows all refuse identically', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);

	const refusals = {
		'an id that was never issued': url('0ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'w800.webp'),
		'an id that is not even the right shape': url('nonsense', 'w800.webp'),
		'a variant that is not on the allowlist': url(media.familyImage, 'w1234.webp'),
		'the untouched original': url(media.familyImage, 'original.jpg'),
		'a traversal in the variant': url(media.familyImage, '..%2F..%2Foriginals%2Fx.jpg'),
		'an asset on a draft entry': url(media.draftEntryAsset, 'w800.webp'),
		'an asset owned by no entry': url(media.orphanAsset, 'w800.webp'),
		'an asset whose min_tier_rank is not a rank': url(media.badRankAsset, 'w800.webp')
	};

	const bodies = new Set<string>();

	for (const [label, path] of Object.entries(refusals)) {
		const response = await context.request.get(path, { maxRedirects: 0 });

		expect(response.status(), label).toBe(403);
		bodies.add(await response.text());
	}

	// One body across all eight, so no probe distinguishes "does not exist"
	// from "not yours", and none of them names the asset.
	expect(bodies.size).toBe(1);
	expect([...bodies][0]).toBe('403 Forbidden\n');
});

test('a refused asset is indistinguishable from an invented one, signed out too', async ({
	request
}) => {
	const real = await request.get(IMAGE, { maxRedirects: 0 });
	const invented = await request.get(url('0ZZZZZZZZZZZZZZZZZZZZZZZZZ', 'w800.webp'), {
		maxRedirects: 0
	});

	expect(real.status()).toBe(401);
	expect(invented.status()).toBe(401);
	expect(await invented.text()).toBe(await real.text());
});

test('a soft-revoked grant stops the bytes on the next fetch', async ({ context, baseURL }) => {
	const fixture = await signIn(context, 'revoked', baseURL!);
	expect(fixture.tier).toBe('family');

	expect((await context.request.get(IMAGE, { maxRedirects: 0 })).status()).toBe(403);
});

test('a signed-in visitor with no grant is refused like anyone else', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'nogrant', baseURL!);

	expect((await context.request.get(IMAGE, { maxRedirects: 0 })).status()).toBe(403);
	expect((await context.request.get(VIDEO, { maxRedirects: 0 })).status()).toBe(403);
});

/* ------------------------------------------------------------------ *
 * The gallery.
 * ------------------------------------------------------------------ */

test('the gallery renders a picture with AVIF and WebP srcsets and a placeholder', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto('/private/photos');

	const figure = page.locator('figure').first();
	await expect(figure.locator('source[type="image/avif"]')).toHaveAttribute(
		'srcset',
		new RegExp(`/m/${media.familyImage}/w400\\.avif 400w`)
	);
	await expect(figure.locator('source[type="image/webp"]')).toHaveAttribute(
		'srcset',
		new RegExp(`/m/${media.familyImage}/w1600\\.webp 1600w`)
	);

	// The blurhash, decoded on the server and inlined so there is no second
	// request and nothing to wait for.
	await expect(figure.locator('.tile__frame')).toHaveAttribute(
		'style',
		/background-image:\s*url\("data:image\/bmp;base64,/
	);

	// Decoded, which means the bytes came back through the guarded route.
	// Which width the browser chose is up to it and the viewport.
	await expect
		.poll(async () => figure.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBeGreaterThan(0);
});

test('the gallery renders the video with a poster and metadata-only preload', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto('/private/photos');

	const video = page.locator('video');
	await expect(video).toHaveAttribute('preload', 'metadata');
	await expect(video).toHaveAttribute('poster', `/m/${media.familyVideo}/poster.jpg`);
	await expect(video).toHaveAttribute('src', `/m/${media.familyVideo}/720.mp4`);

	// The metadata really loaded, which means the poster and the moov atom
	// both came back through the guarded route.
	await expect(video).toHaveJSProperty('videoHeight', 720);
});

test('the gallery never lists an asset above the viewer tier', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto('/private/photos');

	// Rendered and serialised: the partner-only id must be in neither.
	const html = await page.content();
	expect(html).toContain(media.familyImage);
	expect(html).not.toContain(media.partnerImage);
});

test('the gallery does not list a draft set', async ({ page, context, baseURL }) => {
	await signIn(context, 'family', baseURL!);
	await page.goto('/private/photos');

	expect(await page.content()).not.toContain('Draft set, not published');
});
