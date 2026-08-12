/**
 * Publishing a list of source files against one `content_entry`: transcode,
 * upload, upsert.
 *
 * This is the body of what `pnpm media:publish` was in M4, lifted out so that
 * `scripts/content/publish.mjs` can drive the same pipeline from frontmatter
 * instead of from argv. There is deliberately only one transcoder, one
 * idempotency rule and one public-cache refusal in this repo, and they are
 * here — a second copy reached from the content CLI would be a second set of
 * decisions about who can see a photo.
 *
 * Two properties are worth stating because the rest is plumbing:
 *
 *  - **Idempotent.** The asset id is derived from the entry slug and the
 *    filename, and the source file's sha256 is stored on the row. Re-running
 *    against an unchanged folder transcodes nothing and uploads nothing.
 *  - **Nothing is published loose.** An asset's rank is chosen by the caller
 *    and `findServableVariant` serves the stricter of the asset's and the
 *    entry's at fetch time, so a per-asset rank can only ever tighten one file
 *    below its page.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
	execute,
	fail,
	query,
	REPO_ROOT,
	sqlNumber,
	sqlProse,
	sqlString,
	upload
} from '../lib/d1.mjs';
import { assetIdFor, derive, keyFor, kindOf, originalKeyFor, sha256 } from './derive.mjs';

/** How many variant rows a finished asset of each kind must have. */
const EXPECTED_VARIANTS = { image: 6, video: 3 };

/**
 * Whether raising this asset's rank in place has to be refused.
 *
 * True only for an asset that is currently **public**. Its bytes are served
 * `public, max-age=3600` and may sit in a shared cache under a URL that does
 * not change when the rank does, so a cache hit keeps serving them to
 * anonymous requests with the Worker — and every access check in this codebase
 * — never running.
 *
 * Written as a predicate so the rule is testable without a database, and so
 * the branch it guards cannot quietly acquire a condition. Every comparison is
 * on a coerced number and fails closed on a rank that is not one: a row whose
 * `min_tier_rank` is the string `'family'` yields `NaN`, `NaN <= 0` is false,
 * and the answer is "this was never public, so there is nothing cached
 * publicly to worry about" — which is right, and is also what the media route
 * refuses to serve anyway.
 */
export function refusesInPlaceTightening(existingRank, desiredRank) {
	if (existingRank === null || existingRank === undefined) return false;

	const current = Number(existingRank);
	return current <= 0 && Number(desiredRank) > current;
}

/**
 * What the database already knows about this asset. `variantCount` is what
 * decides whether a half-finished previous run is treated as done: an asset
 * whose hash matches but whose variant rows are incomplete is re-derived.
 */
function existingAsset(assetId, remote) {
	const [asset] = query(
		`SELECT content_hash, position, min_tier_rank, caption,
		        (SELECT count(*) FROM media_variant WHERE asset_id = ${sqlString(assetId)}) AS variant_count
		 FROM media_asset WHERE id = ${sqlString(assetId)}`,
		remote
	);

	return asset ?? null;
}

/** Every asset currently hanging off an entry, oldest position first. */
export function listEntryAssets(entryId, remote) {
	return query(
		`SELECT a.id, a.original_key, a.position,
		        (SELECT group_concat(r2_key, char(10)) FROM media_variant WHERE asset_id = a.id) AS variant_keys
		 FROM media_asset a WHERE a.entry_id = ${sqlString(entryId)} ORDER BY a.position`,
		remote
	);
}

function upsertStatements(asset) {
	const { id, entryId, kind, originalKey, derived, minTierRank, caption, position, now } = asset;

	// `undefined` means the caller does not manage captions, so an existing one
	// survives a re-transcode. A new row still starts at NULL.
	const captionUpdate = caption === undefined ? 'caption' : 'excluded.caption';

	const statements = [
		`INSERT INTO media_asset (id, entry_id, kind, original_key, mime, bytes, width, height,
			duration_s, blurhash, caption, taken_at, min_tier_rank, position, content_hash, created_at)
		 VALUES (${sqlString(id)}, ${sqlString(entryId)}, ${sqlString(kind)}, ${sqlString(originalKey)},
			${sqlString(derived.original.mime)}, ${sqlNumber(derived.original.bytes)},
			${sqlNumber(derived.width)}, ${sqlNumber(derived.height)}, ${sqlNumber(derived.durationS)},
			${sqlString(derived.blurhash)}, ${sqlProse(caption ?? null)}, NULL, ${sqlNumber(minTierRank)},
			${sqlNumber(position)}, ${sqlString(derived.contentHash)}, ${sqlNumber(now)})
		 ON CONFLICT(id) DO UPDATE SET
			entry_id = excluded.entry_id, kind = excluded.kind, original_key = excluded.original_key,
			mime = excluded.mime, bytes = excluded.bytes, width = excluded.width, height = excluded.height,
			duration_s = excluded.duration_s, blurhash = excluded.blurhash, caption = ${captionUpdate},
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

/**
 * Publishes `files` against `entry`, in the order given.
 *
 * `files` are `{ path, minTierRank, caption }`. The caller owns the tier
 * decision — `scripts/content/publish.mjs` refuses a per-asset tier looser
 * than its entry before it ever gets here, and `pnpm media:publish` warns and
 * lets the fetch-time comparison handle it.
 *
 * `log` is where the per-file lines go; callers pass their own prefix.
 */
export async function publishAssets({ entry, files, dryRun, force, remote, log }) {
	const [{ next_position: nextPosition } = { next_position: 0 }] = query(
		`SELECT coalesce(max(position), -1) + 1 AS next_position
		 FROM media_asset WHERE entry_id = ${sqlString(entry.id)}`,
		remote
	);

	const workRoot = mkdtempSync(join(tmpdir(), 'personal-site-publish-'));
	const published = [];
	let position = Number(nextPosition) || 0;
	let uploaded = 0;
	let unchanged = 0;

	try {
		for (const file of files) {
			const sourcePath = resolve(REPO_ROOT, file.path);
			if (!existsSync(sourcePath)) fail(`${file.path}: no such file.`);

			const fileName = basename(sourcePath);
			const kind = kindOf(sourcePath);
			if (!kind) fail(`${fileName}: not an image or a video this pipeline handles.`);

			const assetId = assetIdFor(entry.slug, fileName);
			const contentHash = sha256(readFileSync(sourcePath));
			const existing = existingAsset(assetId, remote);
			// A caption the caller did not supply is left alone rather than
			// cleared: `pnpm media:publish` knows nothing about captions and
			// must not wipe one the frontmatter set. An explicit `null` is a
			// caption being removed, and does clear it.
			const managesCaption = file.caption !== undefined;
			const caption = file.caption;

			published.push({ fileName, assetId, kind, minTierRank: file.minTierRank });

			const existingRank = existing ? Number(existing.min_tier_rank) : null;

			// Tightening an already-published *public* asset in place is refused.
			//
			// REVIEW FINDING 2026-08-11. A public asset's bytes may sit in a
			// shared cache. Editing its rank in D1 does not evict them, so the
			// old URL keeps serving to anyone — the Worker is never consulted on
			// a cache hit. Loosening is fine; tightening is the dangerous
			// direction, and it is exactly what someone does after publishing a
			// photo more widely than they meant to.
			//
			// The safe move is a NEW asset id, which is a URL nothing has cached.
			// Refuse here rather than documenting it, because the person hitting
			// this is mid-mistake and already anxious.
			//
			// REVIEW FINDING 2026-08-12 (M6): this check used to sit *inside* the
			// unchanged-and-not-forced branch, so `--force` skipped it entirely
			// and re-uploaded the asset at the tighter rank — the one thing plan
			// §M4 and HANDOFF invariant 3 both say `--force` must not do. It is
			// unconditional now. New bytes at the same key do not help either:
			// the URL is unchanged, so a cache hit still serves what it has.
			if (refusesInPlaceTightening(existingRank, file.minTierRank)) {
				fail(
					`REFUSING to tighten ${fileName} (${assetId}) from rank ${existingRank} to ` +
						`${file.minTierRank} in place.\n` +
						`  Its bytes were served publicly and may still sit in a shared cache, which\n` +
						`  a rank change cannot evict. Republish under a NEW asset id instead (rename\n` +
						`  the file or use a different entry slug), then delete the old row.\n` +
						`  --force does not override this; a cached public object is not recallable.`
				);
			}

			if (
				existing &&
				existing.content_hash === contentHash &&
				Number(existing.variant_count) === EXPECTED_VARIANTS[kind] &&
				!force
			) {
				unchanged += 1;

				// The bytes are already in R2 and correct. The rank and the
				// caption may still have moved, and that costs one row write and
				// no upload.
				const rankMoved = existingRank !== file.minTierRank;
				const captionMoved = managesCaption && (existing.caption ?? null) !== caption;

				if ((rankMoved || captionMoved) && !dryRun) {
					const sets = [`min_tier_rank = ${sqlNumber(file.minTierRank)}`];
					if (captionMoved) sets.push(`caption = ${sqlProse(caption)}`);

					execute(
						[`UPDATE media_asset SET ${sets.join(', ')} WHERE id = ${sqlString(assetId)};`],
						remote
					);
					log(`${fileName} unchanged, row updated (rank ${file.minTierRank})`);
				} else {
					log(`${fileName} unchanged (${assetId}), nothing uploaded`);
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
				log(`[dry run] ${fileName} -> ${assetId} (rank ${file.minTierRank})`);
				for (const object of objects) log(`[dry run]   ${object.key}`);
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
					minTierRank: file.minTierRank,
					caption,
					position: rowPosition,
					now: Math.floor(Date.now() / 1000)
				}),
				remote
			);

			log(
				`${fileName} -> ${assetId} (${kind}, rank ${file.minTierRank}, ` +
					`${objects.length} objects, position ${rowPosition})`
			);
		}
	} finally {
		rmSync(workRoot, { recursive: true, force: true });
	}

	return { uploaded, unchanged, published };
}
