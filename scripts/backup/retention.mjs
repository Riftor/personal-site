/**
 * Key naming, manifest handling and retention selection for the D1 backups.
 *
 * Split out from `run.mjs` for the same reason `lib/access-sql.mjs` was split
 * out of `access.mjs`: the runner shells out to wrangler and dispatches on
 * argv, so nothing in it can be asserted. Everything here is pure, and the
 * thing most worth asserting is `selectForDeletion` — it is the only function
 * in this project whose job is to *destroy* data, and an off-by-one in it
 * deletes the backup you were about to need.
 *
 * Two rules shape the whole file, both in the "refuse" direction:
 *
 * 1. **Nothing is deleted that is not positively recognised.** A key that does
 *    not match `BACKUP_KEY` exactly is neither retained nor pruned — it is
 *    ignored, and it survives forever. Somebody else's object in the bucket is
 *    not this script's to remove.
 * 2. **A manifest that cannot be read is an error, not an empty list.**
 *    Treating a corrupt manifest as empty would silently orphan every previous
 *    backup, which looks exactly like success.
 */
import { resolve } from 'node:path';

/** The CLI turns this into one line; anything else keeps its stack. */
export class BackupError extends Error {}

export const fail = (message) => {
	throw new BackupError(message);
};

/**
 * `personal-site-backups`, and deliberately **not** `personal-site-media`.
 *
 * A dump carries every approved address, every live `session` row and the
 * whole audit log — it is the most sensitive artefact this system produces.
 * The Worker has a binding to the media bucket, so a bug in `/m/[assetId]`
 * could in principle stream any key in it. It has **no binding to this one**,
 * and there is nothing in `wrangler.toml` naming it, so no code path in the
 * deployed Worker can reach a backup by construction rather than by argument.
 * Same reasoning as invariant 2 in HANDOFF.md.
 *
 * The CLI addresses the bucket by name, which needs no binding.
 */
export const BUCKET = 'personal-site-backups';

const KEY_PREFIX = 'd1/personal-site-';
const KEY_SUFFIX = '.sql';

/**
 * `d1/personal-site-2026-08-13T21-08-08Z.sql` — an RFC3339 instant with the
 * colons swapped for dashes, because a colon in an object key is legal but
 * awkward on every shell and filesystem a restore might pass through.
 *
 * Fixed width and zero-padded, so lexicographic order is chronological order.
 * Nothing below relies on that — `selectForDeletion` sorts on the parsed
 * instant — but it means a human reading the bucket sees them in order.
 */
const BACKUP_KEY = /^d1\/personal-site-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.sql$/;

/** The manifest, at a fixed key, because R2 has no list command in wrangler. */
export const MANIFEST_KEY = 'manifest.json';

/** Two weeks of nightly backups. Enough to notice damage before it ages out. */
export const DEFAULT_KEEP = 14;

/**
 * A ceiling on how much one run may destroy.
 *
 * Nothing should ever reach it: a nightly run prunes one object. It exists so
 * that a manifest which somehow accumulated thousands of entries cannot turn
 * a routine backup into a mass delete — the excess is pruned over the
 * following runs instead, which is slower and entirely fine.
 */
export const MAX_DELETES_PER_RUN = 50;

/** The object key for a backup taken at `date`. */
export function backupKey(date) {
	const at = new Date(date);
	// `toISOString` throws a bare RangeError on an invalid date, which reaches
	// a cron log as a stack with no hint of what produced it.
	if (Number.isNaN(at.getTime())) fail(`backupKey needs a valid date, not ${String(date)}.`);
	return `${KEY_PREFIX}${at
		.toISOString()
		.replace(/\.\d+Z$/, 'Z')
		.replaceAll(':', '-')}${KEY_SUFFIX}`;
}

/**
 * The instant a key names, in ms, or `null` for anything this script did not
 * write. `null` is what keeps rule 1 above true, so callers must treat it as
 * "not mine" rather than as "old".
 */
export function backupTimeOf(key) {
	const match = BACKUP_KEY.exec(String(key));
	if (!match) return null;

	const [, year, month, day, hour, minute, second] = match;
	const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
	const at = Date.parse(iso);
	// `Date.parse` accepts 2026-02-31 and rolls it into March, so the only way
	// to reject an impossible date is to render the result back and compare.
	if (Number.isNaN(at) || new Date(at).toISOString() !== `${iso.slice(0, -1)}.000Z`) return null;
	return at;
}

/**
 * Which keys this run should delete: everything past the newest `keep`.
 *
 * Returned oldest first, so a run that hits `max` removes the least useful
 * objects and leaves the rest for next time.
 *
 * `protect` is never returned, whatever its position in the ordering.
 *
 * REVIEW FINDING 2026-08-13, fixed here. Selection ranks purely on the instant
 * encoded in the key's *name*, and `run.mjs` passes the key it is about to
 * upload in with the rest. So if the clock is behind when a backup runs — an
 * NTP correction, a VM resumed from a snapshot, a machine that boots without a
 * battery-backed clock — the fresh key encodes a time older than backups
 * already in the manifest, sorts into the doomed set, and is deleted in the
 * same run that created it. The run then logs "uploaded" and "pruned" and
 * exits 0, so a cron log reads as perfectly healthy while that night's backup
 * was destroyed on arrival and the window quietly stopped advancing.
 *
 * Ranking on the key name is still right — it is the only ordering a restorer
 * can reconstruct from the bucket alone, and object mtimes move when objects
 * are copied. The fix is to exempt the one key the caller knows it just wrote
 * rather than to trust the clock that named it.
 */
export function selectForDeletion(
	keys,
	{ keep = DEFAULT_KEEP, max = MAX_DELETES_PER_RUN, protect = null } = {}
) {
	// A keep of 0 would delete the backup the caller just uploaded. There is no
	// reading of "keep none" that is a backup policy.
	if (!Number.isInteger(keep) || keep < 1) fail(`--keep must be a whole number of 1 or more.`);

	const dated = [...new Set(keys)]
		.map((key) => ({ key, at: backupTimeOf(key) }))
		.filter((entry) => entry.at !== null)
		// Newest first, so the retained window is a prefix. Equal instants are
		// impossible in practice (the key is per-second) but ordering on the key
		// keeps the result deterministic if two ever collide.
		.sort((a, b) => b.at - a.at || b.key.localeCompare(a.key));

	return (
		dated
			.slice(keep)
			.map((entry) => entry.key)
			// After the slice, not before: sparing `protect` should keep one more
			// object than `keep` asks for, never promote an older one into the
			// window to take its place.
			.filter((key) => key !== protect)
			.reverse()
			.slice(0, max)
	);
}

/** The manifest body to upload for `keys`, newest first so it reads usefully. */
export function serialiseManifest(keys) {
	const ordered = [...new Set(keys)].sort(
		(a, b) => (backupTimeOf(b) ?? 0) - (backupTimeOf(a) ?? 0)
	);
	return `${JSON.stringify({ version: 1, backups: ordered }, null, '\t')}\n`;
}

/**
 * The keys a manifest lists. Refuses anything it cannot read rather than
 * falling back to an empty list — see rule 2 at the top of the file.
 */
export function parseManifest(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		fail(`the backup manifest is not readable JSON (${cause.message}). Nothing was pruned.`);
	}

	const backups = parsed?.backups;
	if (!Array.isArray(backups) || backups.some((key) => typeof key !== 'string')) {
		fail('the backup manifest has no `backups` array of strings. Nothing was pruned.');
	}
	return backups;
}

/**
 * Refuses a dump path inside the repository.
 *
 * The export contains live session tokens. If it ever landed under the working
 * tree it could be committed to a public repo, and — worse, because it needs
 * no mistake by a human — swept into `.svelte-kit/cloudflare/` as a static
 * asset, which Cloudflare serves *before* the Worker runs. That is invariant 1
 * pointed at a file nobody would think to look for.
 */
export function assertOutsideRepo(path, repoRoot) {
	// REVIEW FINDING 2026-08-13: this compared the strings as given, so a path
	// that *resolves* inside the repo but is not spelled that way sailed
	// through — `/tmp/x/../../repo/dump.sql` against `/repo` returned rather
	// than failed. No caller passes such a path today, but the guard's whole
	// point is to hold for the one that eventually does, and a check narrower
	// than its own docstring is worse than none: it reads as covered.
	//
	// `resolve` collapses `..` and makes a relative path absolute against cwd.
	// It does not follow symlinks — a symlinked TMPDIR pointing into the repo
	// would still pass — which is why the dump is also written into a fresh
	// `mkdtemp` directory rather than a path from the environment.
	const normalised = resolve(String(path)).replaceAll('\\', '/').replace(/\/+$/, '');
	const root = resolve(String(repoRoot)).replaceAll('\\', '/').replace(/\/+$/, '');
	if (normalised === root || normalised.startsWith(`${root}/`)) {
		fail(`refusing to write a database dump inside the repository: ${path}`);
	}
	return path;
}
