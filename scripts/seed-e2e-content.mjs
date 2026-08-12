#!/usr/bin/env node
/**
 * Publishes the content `e2e/content.spec.ts` drives into the same local D1
 * and local R2 the Worker reads.
 *
 * Everything here goes through the real CLI. `scripts/content/fixtures.mjs`
 * synthesises the media, `scripts/content/publish.mjs` validates the
 * frontmatter, renders the markdown, transcodes, uploads and upserts. There is
 * no test-only branch and no shortcut around the publisher, for the same
 * reason `seed-e2e-media.mjs` has none: content built by a different code path
 * from the real one would test the fixture.
 *
 * The two drafts and the partner-tier memory are published too. They are the
 * states the templates have to refuse — a draft that must not be listed at any
 * tier, and an entry whose own rank sits above the route floor.
 *
 * Runs after `test:seed:media` in the Playwright `webServer` command.
 *
 * LOCAL ONLY. There is no `--remote` path here and there must never be one.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/d1.mjs';
import { assetIdFor } from './media/derive.mjs';
import { ensureContentFixtures } from './content/fixtures.mjs';

const FIXTURES_PATH = join(REPO_ROOT, 'e2e', '.content-fixtures.json');

/** In publish order. Each lands on the slug of its folder or file name. */
const TARGETS = [
	'content/memories/2026-07-cornwall',
	'content/photosets/2026-06-family-dinner',
	'content/activity/2026-08.md',
	'content/_fixtures/draft-memory',
	'content/_fixtures/draft-activity.md',
	'content/_fixtures/partner-memory'
];

await ensureContentFixtures();

for (const target of TARGETS) {
	execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'content', 'publish.mjs'), target], {
		cwd: REPO_ROOT,
		// No stdin: the `min_tier: public` confirmation must abort rather than be
		// fed a "yes" by a script. None of these is public, so it never prompts —
		// but a fixture edited to `public` should fail here, not publish quietly.
		stdio: ['ignore', 'ignore', 'inherit']
	});
}

/**
 * Slugs and asset ids the spec asserts against, so a renamed folder or a
 * renamed photo fails the seed rather than the assertion.
 */
const fixtures = {
	memorySlug: '2026-07-cornwall',
	photosetSlug: '2026-06-family-dinner',
	activitySlug: '2026-08',
	draftMemorySlug: 'draft-memory',
	partnerMemorySlug: 'partner-memory',
	// A `family` memory holding one `partner` asset — plan §6's own example.
	familyImage: assetIdFor('2026-07-cornwall', 'beach.jpg'),
	partnerVideo: assetIdFor('2026-07-cornwall', 'surf.mov')
};

writeFileSync(FIXTURES_PATH, `${JSON.stringify(fixtures, null, '\t')}\n`);

console.error(
	`seed-e2e-content: published ${TARGETS.length} entries -> e2e/.content-fixtures.json`
);
