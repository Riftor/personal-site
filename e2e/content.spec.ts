import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext } from '@playwright/test';

/**
 * M6.2: the memory, photo-set and activity templates rendering **from real
 * published content** — the entries `scripts/seed-e2e-content.mjs` put into D1
 * by running `pnpm run publish` over the folders in `content/`. Nothing in
 * this suite is seeded by raw SQL, so a break in the CLI shows up here as a
 * page with nothing on it.
 *
 * Two properties get more attention than the rendering itself, because they
 * are the ones that lose private data rather than merely looking wrong:
 *
 *  - **A draft is not servable at any tier.** Not listed, not reachable by
 *    URL, not present in the serialised data payload.
 *  - **An entry's own `min_tier` beats the route floor.** `/private/memories`
 *    is gated at `family`, and a memory published at `partner` inside it must
 *    be invisible to a family session and answer its URL with the same 403 a
 *    slug that does not exist gets.
 */

type Fixture = { email: string; tier: string | null; revoked: boolean; cookie: string };

const { cookieName, fixtures } = JSON.parse(
	readFileSync(new URL('./.access-fixtures.json', import.meta.url), 'utf8')
) as { cookieName: string; fixtures: Record<string, Fixture> };

const content = JSON.parse(
	readFileSync(new URL('./.content-fixtures.json', import.meta.url), 'utf8')
) as {
	memorySlug: string;
	photosetSlug: string;
	activitySlug: string;
	draftMemorySlug: string;
	partnerMemorySlug: string;
	familyImage: string;
	partnerVideo: string;
};

const MEMORY = `/private/memories/${content.memorySlug}`;

async function signIn(context: BrowserContext, key: string, baseURL: string) {
	const fixture = fixtures[key];
	expect(fixture, `fixture "${key}" was not seeded`).toBeTruthy();

	await context.addCookies([{ name: cookieName, value: fixture.cookie, url: baseURL }]);
	return fixture;
}

/* ------------------------------------------------------------------ *
 * The memory template.
 * ------------------------------------------------------------------ */

test('the memory index lists a published memory with its date and summary', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto('/private/memories');

	const card = page.getByRole('link', { name: /Cornwall, July 2026/ });
	await expect(card).toHaveAttribute('href', MEMORY);
	await expect(page.getByText('July 2026', { exact: true })).toBeVisible();
	await expect(page.getByText('Three days of rain and one very good afternoon.')).toBeVisible();
});

test('a memory renders its markdown body as real HTML, not as source', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto(MEMORY);

	await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cornwall, July 2026');
	// A heading, a list and a blockquote, each rendered as an element rather
	// than as the characters that produced it.
	await expect(page.getByRole('heading', { name: 'The one good afternoon' })).toBeVisible();
	await expect(
		page.getByRole('listitem').filter({ hasText: 'The bakery in the village opens at seven' })
	).toBeVisible();
	await expect(page.locator('blockquote')).toContainText('Never turn your back on the sea.');
	expect(await page.content()).not.toContain('## The one good afternoon');
});

test('a memory renders its media through the guarded route', async ({ page, context, baseURL }) => {
	await signIn(context, 'family', baseURL!);
	await page.goto(MEMORY);

	const figure = page.locator('figure').first();
	await expect(figure.locator('source[type="image/avif"]')).toHaveAttribute(
		'srcset',
		new RegExp(`/m/${content.familyImage}/w400\\.avif 400w`)
	);
	await expect(figure.locator('figcaption')).toContainText('First morning, before the weather');

	// Decoded, which means the bytes came back through `/m/...`.
	await expect
		.poll(async () => figure.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
		.toBeGreaterThan(0);
});

test('a partner-only clip inside a family memory reaches neither the page nor the viewer', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto(MEMORY);

	// Plan §6's own example: `surf.mov` at `partner` in a `family` memory.
	// Absent from the markup *and* the serialised payload, and refused on the
	// raw URL — the two refusals are independent.
	expect(await page.content()).not.toContain(content.partnerVideo);
	expect(
		(await context.request.get(`/m/${content.partnerVideo}/720.mp4`, { maxRedirects: 0 })).status()
	).toBe(403);
});

test('the partner session sees the clip the family session could not', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'partner', baseURL!);
	await page.goto(MEMORY);

	await expect(page.locator('video')).toHaveAttribute('src', `/m/${content.partnerVideo}/720.mp4`);
	await expect(page.locator('figcaption').filter({ hasText: 'Caden eating sand' })).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * The photo-set template.
 * ------------------------------------------------------------------ */

test('a published photo set renders its body and its captioned photos', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);
	await page.goto('/private/photos');

	// Titled distinctly from the raw-SQL set `seed-e2e-media.mjs` writes, so
	// this locator can only match the one the CLI published.
	const set = page.locator('section.set').filter({ hasText: 'Sunday roast, June 2026' });
	await expect(set).toContainText('Mum cooked for nine');
	await expect(set.locator('figcaption').filter({ hasText: 'Before' })).toBeVisible();
	await expect(set.locator('img').first()).toHaveAttribute('src', /^\/m\//);
});

/* ------------------------------------------------------------------ *
 * The activity template.
 * ------------------------------------------------------------------ */

test('the activity feed renders a month of published entries for a friend', async ({
	page,
	context,
	baseURL
}) => {
	await signIn(context, 'friend', baseURL!);
	await page.goto('/private/now');

	await expect(page.getByRole('heading', { name: 'August 2026' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '12 August' })).toBeVisible();
	await expect(page.getByText('Learning to solder without burning the bench')).toBeVisible();
	expect(await page.content()).not.toContain('## 12 August');
});

/* ------------------------------------------------------------------ *
 * Drafts, and per-entry tiers above the route floor.
 * ------------------------------------------------------------------ */

test('a draft memory is neither listed nor reachable by URL', async ({ context, baseURL }) => {
	await signIn(context, 'family', baseURL!);

	const index = await context.request.get('/private/memories');
	expect(await index.text()).not.toContain('Draft memory, not published');

	const direct = await context.request.get(`/private/memories/${content.draftMemorySlug}`, {
		maxRedirects: 0
	});
	expect(direct.status()).toBe(403);
	expect(await direct.text()).not.toContain('Draft memory, not published');
});

test('a draft activity month never reaches /private/now', async ({ context, baseURL }) => {
	await signIn(context, 'partner', baseURL!);

	const response = await context.request.get('/private/now');

	expect(response.status()).toBe(200);
	expect(await response.text()).not.toContain('Draft activity');
});

test('a memory above the route floor is invisible to a family session', async ({
	context,
	baseURL
}) => {
	const fixture = await signIn(context, 'family', baseURL!);

	const index = await context.request.get('/private/memories');
	expect(await index.text()).not.toContain('Partner-only memory');

	const direct = await context.request.get(`/private/memories/${content.partnerMemorySlug}`, {
		maxRedirects: 0
	});
	expect(direct.status()).toBe(403);
	expect(await direct.text()).toContain(fixture.email);
	expect(await direct.text()).not.toContain('Partner-only memory');
});

test('the partner session reads the memory the family session could not', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'partner', baseURL!);

	const response = await context.request.get(`/private/memories/${content.partnerMemorySlug}`);

	expect(response.status()).toBe(200);
	expect(await response.text()).toContain('Partner-only memory');
});

test('a memory slug that was never published is byte-identical to one that was refused', async ({
	context,
	baseURL
}) => {
	await signIn(context, 'family', baseURL!);

	// If these differed, a family grant could enumerate which memories exist
	// above its tier by watching the status code or the body change.
	const refused = await context.request.get(`/private/memories/${content.partnerMemorySlug}`, {
		maxRedirects: 0
	});
	const invented = await context.request.get('/private/memories/no-such-memory', {
		maxRedirects: 0
	});

	expect(refused.status()).toBe(403);
	expect(invented.status()).toBe(403);
	expect(await invented.text()).toBe(await refused.text());
});

test('a signed-out request for a memory is a redirect, not a 403', async ({ request }) => {
	const response = await request.get(MEMORY, { maxRedirects: 0 });

	expect(response.status()).toBe(302);
	expect(response.headers()['location']).toBe(`/signin?next=${encodeURIComponent(MEMORY)}`);
});
