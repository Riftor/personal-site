/**
 * The `wrangler` plumbing the two publish CLIs share.
 *
 * `scripts/media/publish.mjs` grew this first; `scripts/content/publish.mjs`
 * needs the same D1 reads, the same batched writes and the same R2 puts, and a
 * second copy of `sqlString` is the kind of duplication that ends with one of
 * them being fixed and the other not. Nothing here knows what a content entry
 * or a media asset is — it is the transport and nothing else.
 *
 * Local D1 and local R2 unless a caller passes `remote: true`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATABASE = 'personal-site';
export const BUCKET = 'personal-site-media';

/**
 * `node_modules/.bin` is only on PATH when this runs through `pnpm`. Resolving
 * the binary from the repo root means `node scripts/…` works too, which is
 * what anyone debugging this will actually type.
 */
const WRANGLER =
	['wrangler', 'wrangler.cmd']
		.map((name) => join(REPO_ROOT, 'node_modules', '.bin', name))
		.find((path) => existsSync(path)) ?? 'wrangler';

/**
 * A failure the CLI should print as one line and exit on, rather than a stack.
 *
 * Thrown rather than `process.exit`ed from inside a helper so the callers'
 * `finally` blocks still run — a publish that dies half way through leaves a
 * temp directory of transcodes behind otherwise.
 */
export class PublishError extends Error {}

export function fail(message) {
	throw new PublishError(message);
}

/**
 * A SQL string literal. Rejects what it cannot represent rather than trying to
 * clean it up, exactly as `scripts/access.mjs` does: a control character or a
 * backslash in a title or a caption is a mistake worth stopping on.
 */
export function sqlString(value) {
	const text = String(value);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(text)) {
		fail(`refusing to write a value containing control characters or a backslash: ${text}`);
	}
	return `'${text.replaceAll("'", "''")}'`;
}

/** A SQL number, or `NULL` for anything that is not a finite one. */
export const sqlNumber = (value) =>
	value === null || value === undefined || !Number.isFinite(Number(value)) ? 'NULL' : String(value);

/** `sqlString`, or the literal `NULL` for null/undefined. */
export const sqlText = (value) =>
	value === null || value === undefined ? 'NULL' : sqlString(value);

/**
 * Prose — a title, a caption, a markdown body, rendered HTML — as a hex blob
 * cast back to text.
 *
 * `sqlString` cannot carry these. A body has newlines in it, which it refuses
 * as control characters, and more importantly a body can contain a semicolon,
 * while these statements reach D1 as a `.sql` file that something on the other
 * end has to split into statements. Quoting correctly and then relying on
 * every splitter between here and SQLite to respect the quotes is a bet with
 * no upside; `CAST(x'…' AS TEXT)` contains no quote, no newline and no
 * semicolon at all, so there is nothing left to get wrong.
 *
 * The cost is that the generated SQL is not readable by eye. That is a fair
 * trade for the one field an author types freely into.
 */
export const sqlProse = (value) =>
	value === null || value === undefined
		? 'NULL'
		: `CAST(x'${Buffer.from(String(value), 'utf8').toString('hex')}' AS TEXT)`;

export function wrangler(args) {
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

/** One `SELECT`, as an array of row objects. */
export function query(sql, remote) {
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

/**
 * A batch of statements, written to a temp file rather than passed on a
 * command line so nothing depends on shell quoting.
 */
export function execute(statements, remote) {
	if (statements.length === 0) return;

	const dir = mkdtempSync(join(tmpdir(), 'personal-site-publish-sql-'));
	const file = join(dir, 'publish.sql');
	writeFileSync(file, statements.join('\n'));

	try {
		wrangler(['d1', 'execute', DATABASE, remote ? '--remote' : '--local', '--file', file]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function upload(key, path, mime, remote) {
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

/**
 * Turns a `main()` into a CLI: a `PublishError` becomes one prefixed line and
 * exit 1, anything else keeps its stack because it is a bug in this code.
 */
export async function runCli(prefix, main) {
	try {
		await main();
	} catch (cause) {
		if (!(cause instanceof PublishError)) throw cause;
		console.error(`${prefix}: ${cause.message}`);
		process.exit(1);
	}
}
