#!/usr/bin/env node
/**
 * Transcodes source media, uploads the objects to R2, and upserts the
 * `media_asset` / `media_variant` rows that make them reachable.
 *
 *   pnpm media:publish <entry-slug> <file...> [--min-tier <slug>] [--dry-run] [--force] [--remote]
 *
 * This is the M4 half of the publish CLI plan §6 describes: the media half.
 * Frontmatter parsing, markdown rendering and `content_entry` upserts are M6's
 * and are deliberately not here — this command requires the entry to exist
 * already and refuses if it does not, rather than inventing one at a tier
 * nobody chose.
 *
 * Two properties are worth stating because the rest of the file is plumbing:
 *
 *  - **Idempotent.** The asset id is derived from the entry slug and the
 *    filename, and the source file's sha256 is stored on the row. Re-running
 *    against an unchanged folder transcodes nothing and uploads nothing; the
 *    summary line prints `0 objects uploaded` and that is the test.
 *  - **Nothing is published loose.** An asset's rank defaults to its entry's,
 *    and `findServableVariant` serves the stricter of the two at fetch time,
 *    so `--min-tier` can only ever tighten one file below its page.
 *
 * Local D1 and local R2 unless `--remote` is passed, exactly like
 * `scripts/access.mjs`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetIdFor, derive, keyFor, kindOf, originalKeyFor, sha256 } from './derive.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATABASE = 'personal-site';
const BUCKET = 'personal-site-media';

/** Mirrors `TIER_RANK` in `src/lib/server/access/tiers.ts`. */
const TIER_RANK = { public: 0, friend: 10, family: 20, partner: 30, owner: 100 };

/** How many variant rows a finished asset of each kind must have. */
const EXPECTED_VARIANTS = { image: 6, video: 3 };

const WRANGLER =
	['wrangler', 'wrangler.cmd']
		.map((name) => join(REPO_ROOT, 'node_modules', '.bin', name))
		.find((path) => existsSync(path)) ?? 'wrangler';

const USAGE = `Usage:
  pnpm media:publish <entry-slug> <file...> [--min-tier <slug>] [--dry-run] [--force] [--remote]

Tiers: ${Object.keys(TIER_RANK).join(', ')}
The entry must already exist in content_entry. Local D1 and R2 unless --remote.`;

function fail(message) {
	console.error(`media: ${message}`);
	process.exit(1);
}

/** Same rule as `scripts/access.mjs`: reject what cannot be represented. */
function sqlString(value) {
	const text = String(value);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(text)) {
		fail(`refusing to write a value containing control characters or a backslash: ${text}`);
	}
	return `'${text.replaceAll("'", "''")}'`;
}

const sqlNumber = (value) =>
	value === null || value === undefined || !Number.isFinite(Number(value)) ? 'NULL' : String(value);

function wrangler(args) {
	try {
		return execFileSync(WRANGLER, args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit']
		});
	} catch (cause) {
		fail(`wrangler ${args.slice(0, 3).join(' ')} failed. ${cause.message}`);
	}
}

function query(sql, remote) {
	const output = wrangler([
		'd1',
		'execute',
		DATABASE,
		remote ? '--remote' : '--local',
		'--json',
		'--command',
		sql
	]);

	// `--json` prints the result array and nothing else, but a stray notice
	// before it would make `JSON.parse` throw an unreadable error.
	const start = output.indexOf('[');
	if (start === -1) fail(`could not read a JSON result from wrangler:\n${output}`);

	return JSON.parse(output.slice(start))[0]?.results ?? [];
}

function execute(statements, remote) {
	if (statements.length === 0) return;

	const dir = mkdtempSync(join(tmpdir(), 'personal-site-media-'));
	const file = join(dir, 'publish.sql');
	writeFileSync(file, statements.join('\n'));

	try {
		wrangler(['d1', 'execute', DATABASE, remote ? '--remote' : '--local', '--file', file]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function upload(key, path, mime, remote) {
	wrangler([
		'r2',
		'object',
		'put',
		`${BUCKET}/${key}`,
		'--file',
		path,
		'--content-type',
		mime,
		remote ? '--remote' : '--local'
	]);
}

function parseArgs(argv) {
	const options = { dryRun: false, force: false, remote: false, minTier: null };
	const positional = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--force') options.force = true;
		else if (arg === '--remote') options.remote = true;
		else if (arg === '--min-tier') options.minTier = argv[(i += 1)];
		else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${USAGE}`);
		else positional.push(arg);
	}

	if (positional.length < 2) fail(USAGE);
	if (options.minTier !== null && !(options.minTier in TIER_RANK)) {
		fail(`unknown tier "${options.minTier}". One of: ${Object.keys(TIER_RANK).join(', ')}`);
	}

	return { ...options, entrySlug: positional[0], files: positional.slice(1) };
}

/**
 * What the database already knows about this asset. `variantCount` is what
 * decides whether a half-finished previous run is treated as done: an asset
 * whose hash matches but whose variant rows are incomplete is re-derived.
 */
function existingAsset(assetId, remote) {
	const [asset] = query(
		`SELECT content_hash, position, min_tier_rank,
		        (SELECT count(*) FROM media_variant WHERE asset_id = ${sqlString(assetId)}) AS variant_count
		 FROM media_asset WHERE id = ${sqlString(assetId)}`,
		remote
	);

	return asset ?? null;
}

function upsertStatements(asset) {
	const { id, entryId, kind, originalKey, derived, minTierRank, position, now } = asset;

	const statements = [
		`INSERT INTO media_asset (id, entry_id, kind, original_key, mime, bytes, width, height,
			duration_s, blurhash, caption, taken_at, min_tier_rank, position, content_hash, created_at)
		 VALUES (${sqlString(id)}, ${sqlString(entryId)}, ${sqlString(kind)}, ${sqlString(originalKey)},
			${sqlString(derived.original.mime)}, ${sqlNumber(derived.original.bytes)},
			${sqlNumber(derived.width)}, ${sqlNumber(derived.height)}, ${sqlNumber(derived.durationS)},
			${sqlString(derived.blurhash)}, NULL, NULL, ${sqlNumber(minTierRank)}, ${sqlNumber(position)},
			${sqlString(derived.contentHash)}, ${sqlNumber(now)})
		 ON CONFLICT(id) DO UPDATE SET
			entry_id = excluded.entry_id, kind = excluded.kind, original_key = excluded.original_key,
			mime = excluded.mime, bytes = excluded.bytes, width = excluded.width, height = excluded.height,
			duration_s = excluded.duration_s, blurhash = excluded.blurhash,
			min_tier_rank = excluded.min_tier_rank, position = excluded.position,
			content_hash = excluded.content_hash;`
	];

	for (const variant of derived.variants) {
		const variantId = `${id}-${variant.variant}`;
		statements.push(
			`INSERT INTO media_variant (id, asset_id, variant, r2_key, mime, bytes, width, height)
			 VALUES (${sqlString(variantId)}, ${sqlString(id)}, ${sqlString(variant.variant)},
				${sqlString(keyFor(id, kind, variant.variant))}, ${sqlString(variant.mime)},
				${sqlNumber(variant.bytes)}, ${sqlNumber(variant.width)}, ${sqlNumber(variant.height)})
			 ON CONFLICT(id) DO UPDATE SET
				r2_key = excluded.r2_key, mime = excluded.mime, bytes = excluded.bytes,
				width = excluded.width, height = excluded.height;`
		);
	}

	return statements;
}

async function main() {
	const { entrySlug, files, minTier, dryRun, force, remote } = parseArgs(process.argv.slice(2));

	const [entry] = query(
		`SELECT id, min_tier_rank, status FROM content_entry WHERE slug = ${sqlString(entrySlug)}`,
		remote
	);
	if (!entry) fail(`no content_entry with slug "${entrySlug}". Create the entry first.`);

	const entryRank = Number(entry.min_tier_rank);
	const minTierRank = minTier === null ? entryRank : TIER_RANK[minTier];
	if (minTierRank < entryRank) {
		console.error(
			`media: warning — --min-tier ${minTier} (rank ${minTierRank}) is looser than the entry's ` +
				`rank ${entryRank}. The stricter of the two is enforced at fetch time, so this has no effect.`
		);
	}

	const [{ next_position: nextPosition } = { next_position: 0 }] = query(
		`SELECT coalesce(max(position), -1) + 1 AS next_position
		 FROM media_asset WHERE entry_id = ${sqlString(entry.id)}`,
		remote
	);

	const workRoot = mkdtempSync(join(tmpdir(), 'personal-site-publish-'));
	let position = Number(nextPosition) || 0;
	let uploaded = 0;
	let unchanged = 0;

	try {
		for (const file of files) {
			const sourcePath = resolve(REPO_ROOT, file);
			if (!existsSync(sourcePath)) fail(`${file}: no such file.`);

			const fileName = basename(sourcePath);
			const kind = kindOf(sourcePath);
			if (!kind) fail(`${fileName}: not an image or a video this pipeline handles.`);

			const assetId = assetIdFor(entrySlug, fileName);
			const contentHash = sha256(readFileSync(sourcePath));
			const existing = existingAsset(assetId, remote);

			if (
				existing &&
				existing.content_hash === contentHash &&
				Number(existing.variant_count) === EXPECTED_VARIANTS[kind] &&
				!force
			) {
				unchanged += 1;

				// Tightening an already-published asset in place is refused.
				//
				// REVIEW FINDING 2026-08-11. A public asset's bytes may sit in a
				// shared cache. Editing its rank in D1 does not evict them, so
				// the old URL keeps serving to anyone — the Worker is never
				// consulted on a cache hit. Loosening is fine; tightening is the
				// dangerous direction, and it is exactly what someone does after
				// publishing a photo more widely than they meant to.
				//
				// The safe move is a NEW asset id, which is a URL nothing has
				// cached. Refuse here rather than documenting it, because the
				// person hitting this is mid-mistake and already anxious.
				const existingRank = Number(existing.min_tier_rank);
				if (existingRank <= 0 && minTierRank > existingRank) {
					fail(
						`REFUSING to tighten ${fileName} (${assetId}) from rank ${existingRank} to ` +
							`${minTierRank} in place.\n` +
							`  Its bytes were served publicly and may still sit in a shared cache, which\n` +
							`  a rank change cannot evict. Republish under a NEW asset id instead (rename\n` +
							`  the file or use a different entry slug), then delete the old row.\n` +
							`  --force does not override this; a cached public object is not recallable.`
					);
				}

				// The bytes are already in R2 and correct. The rank may still
				// have moved, and that costs one row write and no upload.
				if (Number(existing.min_tier_rank) !== minTierRank && !dryRun) {
					execute(
						[
							`UPDATE media_asset SET min_tier_rank = ${sqlNumber(minTierRank)} WHERE id = ${sqlString(assetId)};`
						],
						remote
					);
					console.error(`media: ${fileName} unchanged, tier moved to rank ${minTierRank}`);
				} else {
					console.error(`media: ${fileName} unchanged (${assetId}), nothing uploaded`);
				}
				continue;
			}

			// One directory per asset: `derive` writes fixed names
			// (`original.jpg`, `w800.avif`, …) and two sources in the same
			// directory would overwrite each other's objects.
			const workDir = join(workRoot, assetId);
			mkdirSync(workDir, { recursive: true });
			const derived = await derive(sourcePath, workDir);

			const originalKey = originalKeyFor(assetId, derived.original.extension);
			const objects = [
				{ key: originalKey, path: derived.original.path, mime: derived.original.mime },
				...derived.variants.map((variant) => ({
					key: keyFor(assetId, kind, variant.variant),
					path: variant.path,
					mime: variant.mime
				}))
			];

			if (dryRun) {
				console.error(`media: [dry run] ${fileName} -> ${assetId} (rank ${minTierRank})`);
				for (const object of objects) console.error(`media: [dry run]   ${object.key}`);
				continue;
			}

			for (const object of objects) {
				upload(object.key, object.path, object.mime, remote);
				uploaded += 1;
			}

			const rowPosition = existing ? Number(existing.position) : position++;
			execute(
				upsertStatements({
					id: assetId,
					entryId: entry.id,
					kind,
					originalKey,
					derived,
					minTierRank,
					position: rowPosition,
					now: Math.floor(Date.now() / 1000)
				}),
				remote
			);

			console.error(
				`media: ${fileName} -> ${assetId} (${kind}, rank ${minTierRank}, ` +
					`${objects.length} objects, position ${rowPosition})`
			);
		}
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
	}

	if (entry.status !== 'published') {
		console.error(
			`media: note — "${entrySlug}" is ${entry.status}, so none of this is servable yet.`
		);
	}

	console.error(
		`media: done. ${uploaded} objects uploaded, ${unchanged} source files unchanged${dryRun ? ' (dry run)' : ''}.`
	);
}

await main();
