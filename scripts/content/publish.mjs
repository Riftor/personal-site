#!/usr/bin/env node
/**
 * Publishes one folder of `content/` — frontmatter, markdown and media — into
 * D1 and R2. Plan §6.
 *
 *   pnpm run publish content/memories/2026-07-cornwall [--dry-run] [--force] [--remote]
 *
 * (`pnpm run publish`, not `pnpm publish`: pnpm keeps `publish` as a built-in
 * command that pushes a package to the npm registry, so a bare `pnpm publish`
 * never reaches this script. `pnpm content:publish` is the unambiguous spelling
 * and matches `pnpm media:publish`.)
 *
 * It validates the frontmatter, renders the body to `body_html`, hands the
 * media to the M4 pipeline, and upserts `content_entry`. It is **idempotent and
 * keyed on `slug`**: re-running against an unchanged folder writes nothing at
 * all and says so; re-running after an edit updates in place.
 *
 * The rules that decide who can see the result live in `entry.mjs` and are
 * unit-tested there. The three worth restating here:
 *
 *  - An unknown `min_tier`, `kind` or `status` is a hard error, never a
 *    default. A typo must not choose an audience.
 *  - A per-asset `min_tier` may only be *stricter* than the entry's.
 *  - Publishing a memory or a photo set to `public` requires typing "yes", on
 *    a terminal, every time. No flag turns that off, and a non-interactive
 *    stdin aborts rather than assuming consent.
 *
 * Local D1 and local R2 unless `--remote` is passed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	execute,
	fail,
	query,
	REPO_ROOT,
	runCli,
	sqlNumber,
	sqlProse,
	sqlString,
	sqlText
} from '../lib/d1.mjs';
import { assetIdFor } from '../media/derive.mjs';
import { listEntryAssets, publishAssets } from '../media/pipeline.mjs';
import { buildEntrySpec, entryIdFor, requiresPublicConfirmation } from './entry.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { renderMarkdown } from './markdown.mjs';

const USAGE = `Usage:
  pnpm run publish <dir-or-file> [--dry-run] [--force] [--remote]

  <dir-or-file>   a folder holding index.md (with an optional media/ beside it),
                  or a markdown file on its own — content/activity/2026-08.md.

  --dry-run       validate, render and transcode, but write nothing: no D1 row,
                  no R2 object.
  --force         re-transcode and re-upload media whose content hash has not
                  moved. Does not override the refusal to tighten a public asset.
  --remote        publish to the deployed D1 and R2 instead of the local ones.

Local D1 and R2 unless --remote.`;

/** The columns a re-publish compares, to decide whether to write at all. */
const ENTRY_COLUMNS = [
	'kind',
	'title',
	'summary',
	'body_md',
	'body_html',
	'min_tier_rank',
	'status',
	'cover_asset_id',
	'occurred_on',
	'sort_key'
];

/**
 * Where each kind shows up, and the rank that route demands
 * (`src/lib/server/access/routes.ts`). Used for the "nobody will see this"
 * warning below, not for any access decision.
 */
const ROUTES = {
	memory: { path: (slug) => `/private/memories/${slug}`, floor: 20 },
	photoset: { path: () => '/private/photos', floor: 20 },
	activity: { path: () => '/private/now', floor: 10 },
	page: { path: (slug) => `/${slug}`, floor: 0 },
	project: { path: () => '/work', floor: 0 }
};

function parseArgs(argv) {
	const options = { dryRun: false, force: false, remote: false };
	const positional = [];

	for (const arg of argv) {
		if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--force') options.force = true;
		else if (arg === '--remote') options.remote = true;
		else if (arg === '--help') options.help = true;
		else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${USAGE}`);
		else positional.push(arg);
	}

	if (options.help) {
		console.log(USAGE);
		process.exit(0);
	}
	if (positional.length !== 1) fail(USAGE);

	return { ...options, target: positional[0] };
}

/**
 * Resolves the argument to a markdown file, its directory, and the slug the
 * entry defaults to.
 *
 * A folder means `<folder>/index.md` and `<folder>/media/`; a bare `.md` file
 * is the activity-and-pages shape from plan §6, and has no media directory.
 */
function locate(target) {
	const path = resolve(REPO_ROOT, target);
	if (!existsSync(path)) fail(`${target}: no such file or directory.`);

	if (statSync(path).isDirectory()) {
		const file = join(path, 'index.md');
		if (!existsSync(file)) fail(`${target}: no index.md in that folder.`);

		return { file, dir: path, defaultSlug: basename(path), mediaDir: join(path, 'media') };
	}

	if (extname(path) !== '.md') fail(`${target}: expected a folder or a .md file.`);

	return {
		file: path,
		dir: dirname(path),
		defaultSlug: basename(path, '.md'),
		mediaDir: null
	};
}

/** The filenames sitting in `media/`, or an empty set. */
function mediaFilesIn(mediaDir) {
	if (!mediaDir || !existsSync(mediaDir)) return new Set();

	return new Set(
		readdirSync(mediaDir, { withFileTypes: true })
			.filter((item) => item.isFile() && !item.name.startsWith('.'))
			.map((item) => item.name)
	);
}

/**
 * Plan §6's confirmation. Deliberately awkward: a typed "yes", on a terminal,
 * every single time, with no flag that skips it.
 *
 * Accidentally publishing a family photo set to the whole internet is the one
 * mistake in this CLI that cannot be taken back — the bytes are cacheable, and
 * `pipeline.mjs` will then refuse to tighten them in place for exactly that
 * reason. A prompt is cheap next to that.
 */
async function confirmPublic(spec) {
	if (!process.stdin.isTTY) {
		fail(
			`"${spec.slug}" is a ${spec.kind} at \`min_tier: public\`, which needs an interactive\n` +
				`  confirmation, and stdin is not a terminal. Refusing rather than assuming yes.\n` +
				`  Run it from a terminal, or publish it to a named tier.`
		);
	}

	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		console.error(
			`\npublish: "${spec.title}" is a ${spec.kind} and \`min_tier: public\` makes it readable\n` +
				`  by anyone on the internet, signed in or not${
					spec.media.length > 0 ? `, including its ${spec.media.length} media file(s)` : ''
				}.\n` +
				`  Public media is cacheable at the edge and cannot reliably be un-published.\n`
		);
		const answer = await rl.question('publish: type "yes" to continue: ');
		if (answer.trim() !== 'yes') fail('not confirmed. Nothing was written.');
	} finally {
		rl.close();
	}
}

function upsertEntryStatement(row) {
	return `INSERT INTO content_entry (id, slug, kind, title, summary, body_md, body_html,
		min_tier_rank, status, cover_asset_id, occurred_on, published_at, updated_at, sort_key)
	 VALUES (${sqlString(row.id)}, ${sqlString(row.slug)}, ${sqlString(row.kind)},
		${sqlProse(row.title)}, ${sqlProse(row.summary)}, ${sqlProse(row.body_md)},
		${sqlProse(row.body_html)}, ${sqlNumber(row.min_tier_rank)}, ${sqlString(row.status)},
		${sqlText(row.cover_asset_id)}, ${sqlText(row.occurred_on)}, ${sqlNumber(row.published_at)},
		${sqlNumber(row.updated_at)}, ${sqlText(row.sort_key)})
	 ON CONFLICT(id) DO UPDATE SET
		slug = excluded.slug, kind = excluded.kind, title = excluded.title,
		summary = excluded.summary, body_md = excluded.body_md, body_html = excluded.body_html,
		min_tier_rank = excluded.min_tier_rank, status = excluded.status,
		cover_asset_id = excluded.cover_asset_id, occurred_on = excluded.occurred_on,
		published_at = excluded.published_at, updated_at = excluded.updated_at,
		sort_key = excluded.sort_key;`;
}

function auditStatement(spec, assetCount) {
	return `INSERT INTO audit_log (id, at, actor, action, target, detail, ip_prefix)
	 VALUES (${sqlString(randomUUID())}, unixepoch(), 'cli', 'publish', ${sqlString(spec.slug)},
		json_object('kind', ${sqlString(spec.kind)}, 'rank', ${sqlNumber(spec.minTierRank)},
			'status', ${sqlString(spec.status)}, 'assets', ${sqlNumber(assetCount)}), NULL);`;
}

/**
 * Assets D1 still has for this entry that the frontmatter no longer lists.
 *
 * This is a hard error rather than a warning, and rather than a silent delete.
 * Deleting a photo out of `media:` and having it stay on the page is not a
 * tidiness problem — it is the photo still being served to everyone who could
 * see it before, from a page the author believes no longer shows it. Deleting
 * it automatically is the other way to be wrong, since the objects are gone for
 * good. So it stops, and says exactly what to run.
 */
function refuseOrphans(entryId, keptIds, remote) {
	const orphans = listEntryAssets(entryId, remote).filter((asset) => !keptIds.has(asset.id));
	if (orphans.length === 0) return;

	const keys = orphans.flatMap((asset) => [
		asset.original_key,
		...String(asset.variant_keys ?? '')
			.split('\n')
			.filter(Boolean)
	]);

	fail(
		`${orphans.length} asset(s) are still published under this entry but are no longer in\n` +
			`  its \`media:\` list. They would keep rendering. Remove them deliberately:\n\n` +
			orphans.map((asset) => `    -- ${asset.id}`).join('\n') +
			'\n' +
			keys
				.map((key) => `    wrangler r2 object delete personal-site-media/${key} --local`)
				.join('\n') +
			'\n' +
			`    wrangler d1 execute personal-site --local --command "DELETE FROM media_asset WHERE id IN (${orphans
				.map((asset) => `'${asset.id}'`)
				.join(', ')})"\n\n` +
			`  (drop --local and use --remote for the deployed copies.)`
	);
}

async function main() {
	const { target, dryRun, force, remote } = parseArgs(process.argv.slice(2));
	const { file, defaultSlug, mediaDir } = locate(target);

	const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));
	const spec = buildEntrySpec({
		data,
		body,
		defaultSlug,
		mediaFiles: mediaFilesIn(mediaDir)
	});

	if (requiresPublicConfirmation(spec.kind, spec.minTier)) await confirmPublic(spec);

	const route = ROUTES[spec.kind];
	if (route && spec.minTierRank < route.floor) {
		console.error(
			`publish: warning — ${route.path(spec.slug)} is gated at rank ${route.floor} by the route\n` +
				`  table, so \`min_tier: ${spec.minTier}\` (rank ${spec.minTierRank}) does not widen who can\n` +
				`  reach the page. The entry's own rank still applies on top of that.`
		);
	}

	const [existing] = query(
		`SELECT id, ${ENTRY_COLUMNS.join(', ')}, published_at
		 FROM content_entry WHERE slug = ${sqlString(spec.slug)}`,
		remote
	);

	if (existing && existing.kind !== spec.kind) {
		console.error(
			`publish: warning — "${spec.slug}" was a ${existing.kind} and is now a ${spec.kind}. ` +
				`It will move to ${route ? route.path(spec.slug) : 'a different page'}.`
		);
	}

	const entryId = existing?.id ?? entryIdFor(spec.slug);
	// Before anything is written, including under --dry-run: an asset left over
	// from a previous publish is a live photo on a page the author thinks no
	// longer shows it.
	refuseOrphans(entryId, new Set(spec.media.map((a) => assetIdFor(spec.slug, a.file))), remote);

	const now = Math.floor(Date.now() / 1000);
	const desired = {
		id: entryId,
		slug: spec.slug,
		kind: spec.kind,
		title: spec.title,
		summary: spec.summary,
		body_md: spec.bodyMd,
		body_html: renderMarkdown(spec.bodyMd ?? '') || null,
		min_tier_rank: spec.minTierRank,
		status: spec.status,
		cover_asset_id: spec.cover === null ? null : assetIdFor(spec.slug, spec.cover),
		occurred_on: spec.occurredOn,
		published_at: existing?.published_at ?? (spec.status === 'published' ? now : null),
		sort_key: spec.sortKey
	};

	const entryChanged =
		!existing || ENTRY_COLUMNS.some((column) => (existing[column] ?? null) !== desired[column]);

	if (entryChanged && !dryRun) {
		execute([upsertEntryStatement({ ...desired, updated_at: now })], remote);
	}

	const { uploaded, unchanged } = await publishAssets({
		entry: { id: entryId, slug: spec.slug },
		files: spec.media.map((asset) => ({
			path: join(mediaDir ?? '', asset.file),
			minTierRank: asset.minTierRank,
			caption: asset.caption
		})),
		dryRun,
		force,
		remote,
		log: (line) => console.error(`publish: ${line}`)
	});

	if (!dryRun && (entryChanged || uploaded > 0)) {
		execute([auditStatement(spec, spec.media.length)], remote);
	}

	/* ---------------------------------------------------------------- *
	 * The summary.
	 * ---------------------------------------------------------------- */

	const where = relative(REPO_ROOT, file);
	console.error(
		`\npublish: ${where}\n` +
			`  slug      ${spec.slug}\n` +
			`  kind      ${spec.kind}\n` +
			`  tier      ${spec.minTier} (rank ${spec.minTierRank})\n` +
			`  status    ${spec.status}${spec.status === 'draft' ? '  — not servable' : ''}\n` +
			`  media     ${spec.media.length} listed, ${uploaded} objects uploaded, ${unchanged} unchanged\n` +
			`  entry     ${dryRun ? '(dry run)' : entryChanged ? 'written' : 'unchanged'}`
	);

	if (!entryChanged && uploaded === 0 && !dryRun) {
		console.error('\npublish: nothing changed. Re-publishing an unedited folder is a no-op.');
	}

	if (spec.status === 'published' && route) {
		console.error(`\npublish: live at ${route.path(spec.slug)}`);
	}
	if (dryRun) console.error('\npublish: dry run — no D1 row and no R2 object was written.');
}

await runCli('publish', main);
