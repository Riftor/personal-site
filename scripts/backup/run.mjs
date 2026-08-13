#!/usr/bin/env node
/**
 * Exports D1 to a `.sql` dump and uploads it to the `personal-site-backups`
 * bucket, keeping the newest `--keep` and deleting the rest.
 *
 *   pnpm backup [--remote] [--keep <n>] [--dry-run]
 *
 * Plan task 8.3. `docs/backup-and-restore.md` is the other half of this and is
 * the file to read first — it says what this is *for* (D1's Time Travel
 * already covers "I deleted a row"; this covers losing the account or the
 * database itself) and how to put a dump back.
 *
 * **Why a script and not a Cron Trigger.** `d1 export` is a control-plane
 * operation in the CLI, not something a Worker can call — there is no binding
 * for it — so no amount of `scheduled()` gets this running on Cloudflare. It
 * is a local command, wired to a cron or a systemd timer. A GitHub Actions
 * workflow was the obvious alternative and is deliberately not used: this
 * repository is public, so it would mean minting a Cloudflare API token with
 * D1 and R2 write scope and storing it in a public repo's secrets. That is a
 * new credential and a new attack surface, permanently, in exchange for not
 * having to run a nightly command on a machine that already has wrangler
 * logged in.
 *
 * Local D1 and local R2 unless `--remote` is passed, exactly like
 * `scripts/access.mjs` and the two publish CLIs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATABASE, REPO_ROOT } from '../lib/d1.mjs';
import {
	assertOutsideRepo,
	BackupError,
	backupKey,
	backupTimeOf,
	BUCKET,
	DEFAULT_KEEP,
	fail,
	MANIFEST_KEY,
	parseManifest,
	selectForDeletion,
	serialiseManifest
} from './retention.mjs';

const WRANGLER =
	['wrangler', 'wrangler.cmd']
		.map((name) => join(REPO_ROOT, 'node_modules', '.bin', name))
		.find((path) => existsSync(path)) ?? 'wrangler';

const USAGE = `Usage:
  pnpm backup [--remote] [--keep <n>] [--dry-run]

Exports D1 to a .sql dump and uploads it to the ${BUCKET} bucket.
Local D1 and local R2 unless --remote. Keeps the newest ${DEFAULT_KEEP} by default.

The bucket must exist first:  wrangler r2 bucket create ${BUCKET}
Restoring one: docs/backup-and-restore.md`;

/**
 * stderr is captured rather than inherited, because one wrangler failure has
 * to be told apart from the others: a `get` of a manifest that is not there
 * yet is the first run, while a `get` that failed for any other reason must
 * stop the prune. Failures are re-printed, so nothing is swallowed.
 */
function wrangler(args) {
	try {
		// `stdio[2]` must be named. `execFileSync` forwards the child's stderr to
		// the parent's by default even while capturing it, so the tolerated
		// "specified key does not exist" from the first run's manifest lookup
		// would print a red ERROR block above a message saying all was well.
		const stdout = execFileSync(WRANGLER, args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe']
		});
		return { ok: true, stdout };
	} catch (cause) {
		return { ok: false, stderr: `${cause.stderr ?? ''}${cause.stdout ?? ''}` || cause.message };
	}
}

function requireWrangler(args, what) {
	const result = wrangler(args);
	if (!result.ok) fail(`${what} failed.\n${result.stderr.trim()}`);
	return result.stdout;
}

function parseArgs(argv) {
	const options = { remote: false, dryRun: false, keep: DEFAULT_KEEP };

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--remote') options.remote = true;
		else if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--help') {
			console.log(USAGE);
			process.exit(0);
		} else if (arg === '--keep') {
			options.keep = Number(argv[(i += 1)]);
			if (!Number.isInteger(options.keep) || options.keep < 1) {
				fail(`--keep needs a whole number of 1 or more.\n\n${USAGE}`);
			}
		} else fail(`unknown option ${arg}\n\n${USAGE}`);
	}

	return options;
}

/** The manifest's keys, or `[]` on the first run against an empty bucket. */
function readManifest(dir, remote) {
	const path = join(dir, 'manifest.json');
	const result = wrangler([
		'r2',
		'object',
		'get',
		`${BUCKET}/${MANIFEST_KEY}`,
		'--file',
		path,
		remote ? '--remote' : '--local'
	]);

	if (!result.ok) {
		// The only tolerable failure. Everything else — no such bucket, no
		// credentials, a network error — must not be read as "there are no
		// backups", because that answer prunes nothing and then writes a
		// manifest that has forgotten every object already in the bucket.
		if (/specified key does not exist/i.test(result.stderr)) return [];
		fail(`could not read ${MANIFEST_KEY} from ${BUCKET}.\n${result.stderr.trim()}`);
	}

	return parseManifest(readFileSync(path, 'utf8'));
}

/**
 * The dump, as schema-then-data — which is **not** what one `d1 export` gives
 * you, and this is the whole reason the backup is assembled here rather than
 * written straight to `--output`.
 *
 * A plain `wrangler d1 export` interleaves each table's `CREATE` with its
 * `INSERT`s in an order that puts `INSERT INTO "session"` *before*
 * `CREATE TABLE "user"`, which `session.user_id` references. It opens with
 * `PRAGMA defer_foreign_keys=TRUE` to cover exactly that, but the pragma is
 * scoped to a transaction and does not survive the file being split into
 * statements, so feeding wrangler's own export back to
 * `wrangler d1 execute --file` fails on the first `session` row with
 * `no such table: main.user`. Verified against local D1 on 2026-08-13: a
 * single-file export refused on that exact error, and schema-then-data
 * restored into an empty database with every table's row count matching the
 * source.
 *
 * `--no-data` and `--no-schema` are two passes over the same database rather
 * than one, so in principle a write between them could land in the data half
 * without its table in the schema half. Nothing here writes DDL at runtime —
 * migrations are a deploy-time command — so the only drift available is a new
 * row, and a new row in an existing table restores fine.
 */
function exportDump(dir, remote) {
	const halves = ['--no-data', '--no-schema'].map((only) => {
		const path = join(dir, `${only.slice(2)}.sql`);
		requireWrangler(
			['d1', 'export', DATABASE, remote ? '--remote' : '--local', '--output', path, only],
			`exporting ${DATABASE} (${only})`
		);
		const sql = readFileSync(path, 'utf8').trimEnd();
		// wrangler reporting success having written nothing is the failure this
		// catches: an empty half uploads as a plausible-looking backup and only
		// announces itself on the day it is restored.
		if (sql === '') fail(`the ${only} export of ${DATABASE} is empty. Nothing was uploaded.`);
		return sql;
	});

	const [schema] = halves;
	if (!schema.includes('CREATE TABLE')) {
		fail(`the schema export of ${DATABASE} creates no tables. Nothing was uploaded.`);
	}

	// Joined rather than concatenated: a half that does not end in a newline
	// would weld its last statement onto the next half's first one.
	return `${halves.join('\n')}\n`;
}

function put(key, path, remote) {
	requireWrangler(
		[
			'r2',
			'object',
			'put',
			`${BUCKET}/${key}`,
			'--file',
			path,
			'--content-type',
			key.endsWith('.json') ? 'application/json' : 'application/sql',
			remote ? '--remote' : '--local'
		],
		`uploading ${key}`
	);
}

async function main() {
	const { remote, dryRun, keep } = parseArgs(process.argv.slice(2));

	// Outside the working tree, and asserted rather than assumed: the dump
	// carries live session tokens, and the repo is public. Removed in `finally`
	// whatever happens below.
	const dir = assertOutsideRepo(mkdtempSync(join(tmpdir(), 'personal-site-backup-')), REPO_ROOT);

	try {
		const key = backupKey(new Date());
		const dump = assertOutsideRepo(join(dir, 'd1.sql'), REPO_ROOT);

		// Read before writing anything. A manifest this run cannot understand is
		// a reason to stop, and stopping is cheaper before the upload than after.
		const existing = readManifest(dir, remote);

		writeFileSync(dump, exportDump(dir, remote));

		const bytes = statSync(dump).size;

		// `protect` is the backup this run just made. Without it a clock that
		// is behind — an NTP correction, a resumed VM — names the fresh key
		// earlier than keys already in the manifest, and the prune deletes it
		// in the same run that uploaded it, logging success either way. See the
		// review finding above `selectForDeletion`.
		const doomed = selectForDeletion([...existing, key], { keep, protect: key });

		// Protecting it stops the loss, but does not fix the cause: the next
		// run would rank it old again and the window would stop advancing
		// without ever failing. So say it out loud.
		const newestExisting = existing.reduce(
			(latest, old) => Math.max(latest, backupTimeOf(old) ?? 0),
			0
		);
		if (newestExisting > (backupTimeOf(key) ?? 0)) {
			console.error(
				`backup: WARNING — ${key} is named earlier than a backup already in the bucket, ` +
					`so this machine's clock is behind. The new backup is kept, but check the clock: ` +
					`while it stays wrong, each run's backup is the first candidate for deletion.`
			);
		}

		if (dryRun) {
			console.error(`backup: would upload ${key} (${bytes} bytes) to ${BUCKET}`);
			for (const old of doomed) console.error(`backup: would delete ${old}`);
			console.error(`backup: dry run, nothing was written.`);
			return;
		}

		put(key, dump, remote);
		console.error(`backup: uploaded ${key} (${bytes} bytes) to ${BUCKET}`);

		// Only keys whose delete actually succeeded leave the manifest, so a
		// delete that failed is retried on the next run rather than forgotten.
		const gone = new Set();
		for (const old of doomed) {
			const result = wrangler([
				'r2',
				'object',
				'delete',
				`${BUCKET}/${old}`,
				remote ? '--remote' : '--local'
			]);
			if (result.ok) {
				gone.add(old);
				console.error(`backup: pruned ${old}`);
			} else {
				console.error(`backup: could not prune ${old}, will retry next run.`);
			}
		}

		const manifest = join(dir, 'manifest.next.json');
		writeFileSync(
			manifest,
			serialiseManifest([...existing, key].filter((entry) => !gone.has(entry)))
		);
		put(MANIFEST_KEY, manifest, remote);

		if (!remote) {
			console.error(
				'backup: this was the LOCAL simulated database in .wrangler/state, not production.\n' +
					'backup: the real one is `pnpm backup --remote`.'
			);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

try {
	await main();
} catch (cause) {
	if (!(cause instanceof BackupError)) throw cause;
	console.error(`backup: ${cause.message}`);
	process.exit(1);
}
