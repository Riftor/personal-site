#!/usr/bin/env node
/**
 * Seeds the photo sets and media objects `e2e/media.spec.ts` drives, into the
 * same local D1 and local R2 the Worker reads.
 *
 * Everything here goes through the real pipeline: `scripts/media/fixtures.mjs`
 * synthesises the source files, `scripts/media/publish.mjs` transcodes them,
 * strips their metadata, uploads them and writes the rows. There is no
 * test-only branch in `src/` and no shortcut around the publisher — a media
 * fixture built by a different code path from the real one would test the
 * fixture.
 *
 * Three rows at the end are written as raw SQL rather than published, because
 * the publisher cannot produce them and they are exactly the states the media
 * route has to refuse: an asset on a draft entry, an asset owned by no entry
 * at all, and an asset whose `min_tier_rank` is not a rank. None of the three
 * has an object in R2, which is the point — the refusal happens before R2 is
 * touched, so if one of them ever served bytes there would be none to serve.
 *
 * Runs between the build and `wrangler dev` in the Playwright `webServer`
 * command, after `seed-e2e-access.mjs` has applied the migrations.
 *
 * LOCAL ONLY. There is no `--remote` path here and there must never be one.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetIdFor } from './media/derive.mjs';
import { ensureFixtures, FIXTURE_DIR } from './media/fixtures.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = 'personal-site';
const FIXTURES_PATH = join(REPO_ROOT, 'e2e', '.media-fixtures.json');

const WRANGLER =
	['wrangler', 'wrangler.cmd']
		.map((name) => join(REPO_ROOT, 'node_modules', '.bin', name))
		.find((path) => existsSync(path)) ?? 'wrangler';

/**
 * The titles are the sentinels `e2e/access.spec.ts` already looks for on
 * `/private/photos`; that suite predates the gallery and must keep passing
 * against it unchanged.
 */
const SETS = [
	{
		id: '01K4E2EMEDIA00000000CORNWL',
		slug: 'e2e-cornwall',
		title: 'Cornwall, July 2026',
		summary: 'Three days of rain and one good afternoon.',
		occurredOn: '2026-07-14',
		rank: 20,
		status: 'published'
	},
	{
		id: '01K4E2EMEDIA000000000DINNR',
		slug: 'e2e-family-dinner',
		title: 'Family dinner, June 2026',
		summary: null,
		occurredOn: '2026-06-20',
		rank: 20,
		status: 'published'
	},
	{
		id: '01K4E2EMEDIA0000000000DRFT',
		slug: 'e2e-draft-set',
		title: 'Draft set, not published',
		summary: null,
		occurredOn: '2026-05-01',
		rank: 20,
		status: 'draft'
	}
];

const sql = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);

function wrangler(args) {
	execFileSync(WRANGLER, args, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
}

function d1(statements) {
	const dir = mkdtempSync(join(tmpdir(), 'personal-site-media-seed-'));
	const file = join(dir, 'seed.sql');
	writeFileSync(file, statements.join('\n'));

	try {
		wrangler(['d1', 'execute', DATABASE, '--local', '--file', file]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function publish(entrySlug, file, minTier) {
	execFileSync(
		process.execPath,
		[join(REPO_ROOT, 'scripts', 'media', 'publish.mjs'), entrySlug, file, '--min-tier', minTier],
		{ cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
	);
}

const { image, video } = await ensureFixtures();

/**
 * A second copy of the photo under a different name, so it gets a different
 * asset id and can sit in the same set at a stricter tier. That case — one
 * partner-only photo inside an otherwise family-visible set — is the reason
 * `media_asset.min_tier_rank` exists at all (plan §3).
 */
const partnerImage = join(FIXTURE_DIR, 'harbour-partner.jpg');
if (!existsSync(partnerImage)) copyFileSync(image, partnerImage);

/** 26 Crockford base32 characters, the shape `isAssetId` insists on. */
const assetId = (prefix) => (prefix + '0'.repeat(26)).slice(0, 26);

const fixtures = {
	familyImage: assetIdFor('e2e-cornwall', basename(image)),
	partnerImage: assetIdFor('e2e-cornwall', basename(partnerImage)),
	familyVideo: assetIdFor('e2e-family-dinner', basename(video)),
	// The three the publisher cannot make. No R2 objects behind any of them.
	draftEntryAsset: assetId('0DRAFT'),
	orphanAsset: assetId('0RPHAN'),
	badRankAsset: assetId('0BADRANK')
};

// Upserted rather than deleted and re-created: the published assets hang off
// these ids, and dropping the entries would cascade them away and turn every
// run into a full re-transcode instead of the no-op the content hash earns.
d1(
	SETS.map(
		(set) =>
			`INSERT INTO content_entry (id, slug, kind, title, summary, body_md, body_html,
				min_tier_rank, status, cover_asset_id, occurred_on, published_at, updated_at, sort_key)
			 VALUES (${sql(set.id)}, ${sql(set.slug)}, 'photoset', ${sql(set.title)}, ${sql(set.summary)},
				NULL, NULL, ${set.rank}, ${sql(set.status)}, NULL, ${sql(set.occurredOn)},
				unixepoch(), unixepoch(), NULL)
			 ON CONFLICT(id) DO UPDATE SET
				slug = excluded.slug, title = excluded.title, summary = excluded.summary,
				min_tier_rank = excluded.min_tier_rank, status = excluded.status,
				occurred_on = excluded.occurred_on, updated_at = excluded.updated_at;`
	)
);

publish('e2e-cornwall', image, 'family');
publish('e2e-cornwall', partnerImage, 'partner');
publish('e2e-family-dinner', video, 'family');

/**
 * `min_tier_rank` on the last row is the string `'family'`, not a number.
 * SQLite's column affinity does not stop it, `strictestRank` refuses it, and
 * the point of seeding it is that "the database cannot contain that" is a
 * belief rather than a guarantee.
 */
const brokenAsset = (id, entryId, rank) =>
	`INSERT INTO media_asset (id, entry_id, kind, original_key, mime, bytes, width, height,
		duration_s, blurhash, caption, taken_at, min_tier_rank, position, content_hash, created_at)
	 VALUES (${sql(id)}, ${entryId === null ? 'NULL' : sql(entryId)}, 'image',
		${sql(`originals/${id}.jpg`)}, 'image/jpeg', 1, 10, 10, NULL, NULL, NULL, NULL,
		${rank}, 0, ${sql(`hash-${id}`)}, unixepoch());`;

const brokenVariant = (id) =>
	`INSERT INTO media_variant (id, asset_id, variant, r2_key, mime, bytes, width, height)
	 VALUES (${sql(`${id}-w800.webp`)}, ${sql(id)}, 'w800.webp', ${sql(`img/${id}/w800.webp`)},
		'image/webp', 1, 800, 533);`;

const broken = [fixtures.draftEntryAsset, fixtures.orphanAsset, fixtures.badRankAsset];

d1([
	...broken.map((id) => `DELETE FROM media_variant WHERE asset_id = ${sql(id)};`),
	...broken.map((id) => `DELETE FROM media_asset WHERE id = ${sql(id)};`),
	brokenAsset(fixtures.draftEntryAsset, '01K4E2EMEDIA0000000000DRFT', 20),
	brokenVariant(fixtures.draftEntryAsset),
	brokenAsset(fixtures.orphanAsset, null, 20),
	brokenVariant(fixtures.orphanAsset),
	// A rank that is a word. Written deliberately; see the note above.
	brokenAsset(fixtures.badRankAsset, '01K4E2EMEDIA00000000CORNWL', `'family'`),
	brokenVariant(fixtures.badRankAsset)
]);

writeFileSync(FIXTURES_PATH, `${JSON.stringify(fixtures, null, '\t')}\n`);

console.error(
	`seed-e2e-media: published ${SETS.length} sets from ${basename(image)} and ` +
		`${basename(video)} -> e2e/.media-fixtures.json`
);
