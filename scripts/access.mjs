#!/usr/bin/env node
/**
 * Grant and revoke access to the private half of the site.
 *
 *   pnpm access:grant  <email> <tier> [--note "..."] [--by "..."] [--allow-owner] [--remote]
 *   pnpm access:revoke <email>                       [--by "..."]                [--remote]
 *   node scripts/access.mjs list                                                 [--remote]
 *
 * This is the *only* writer of `access_grant`, and that is deliberate: plan §2
 * keeps the highest-privilege operation in the system off the public internet
 * entirely, so there is no HTTP endpoint anywhere that can escalate a tier.
 *
 * Everything goes through `wrangler d1 execute`, local by default. Statements
 * are written to a temp file rather than passed on a command line so nothing
 * depends on shell quoting, and every value interpolated into SQL is either a
 * literal from a fixed allowlist or has been through `sqlString()` below.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const DATABASE = 'personal-site';

/**
 * `node_modules/.bin` is only on PATH when this runs through `pnpm access:*`.
 * Resolving the binary from the repo root means `node scripts/access.mjs …`
 * works too, which is what anyone debugging this will actually type.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER =
	['wrangler', 'wrangler.cmd']
		.map((name) => join(REPO_ROOT, 'node_modules', '.bin', name))
		.find((path) => existsSync(path)) ?? 'wrangler';

/**
 * Mirrors `TIER_SLUGS` in `src/lib/server/db/schema.ts`. The `tier` table is
 * still consulted before anything is written — this list only turns a typo
 * into an error message instead of a query.
 */
const TIER_SLUGS = ['public', 'friend', 'family', 'partner', 'owner'];

/** Granting this needs `--allow-owner`; a typo must not mint an administrator. */
const OWNER_SLUG = 'owner';

const USAGE = `Usage:
  pnpm access:grant  <email> <tier> [--note "..."] [--by "..."] [--allow-owner] [--remote]
  pnpm access:revoke <email> [--by "..."] [--remote]
  node scripts/access.mjs list [--remote]

Tiers: ${TIER_SLUGS.join(', ')}
Local D1 unless --remote is passed.`;

function fail(message) {
	console.error(`access: ${message}`);
	process.exit(1);
}

/**
 * A SQL string literal. Rejects anything it cannot represent rather than
 * trying to clean it up: the inputs here are an email address and a short
 * note, and a value containing a control character or a backslash is a
 * mistake worth stopping on, not worth escaping around.
 */
function sqlString(value) {
	const text = String(value);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(text)) {
		fail(`refusing to write a value containing control characters or a backslash: ${text}`);
	}
	return `'${text.replaceAll("'", "''")}'`;
}

/**
 * Conservative on purpose. Google will only ever hand back an address that
 * matches this, and a grant that does not match one is a grant nobody can
 * ever claim — better to reject it at the prompt than to leave a dead row.
 */
function normaliseEmail(raw) {
	const email = String(raw ?? '')
		.trim()
		.toLowerCase();
	if (!/^[^\s@'"\\]+@[^\s@'"\\.]+(\.[^\s@'"\\.]+)+$/.test(email)) {
		fail(`"${raw}" does not look like an email address.`);
	}
	return email;
}

/** Splits `--flag value` / `--flag` out of argv, leaving the positionals. */
function parseArgs(argv) {
	const positional = [];
	const flags = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		if (name === 'remote' || name === 'allow-owner' || name === 'help') {
			flags[name] = true;
		} else if (name === 'note' || name === 'by') {
			const value = argv[++i];
			if (value === undefined) fail(`--${name} needs a value.`);
			flags[name] = value;
		} else {
			fail(`unknown option --${name}.\n\n${USAGE}`);
		}
	}

	return { positional, flags };
}

/** Runs one or more statements against D1 and returns the parsed results. */
/**
 * `--command`, never `--file`.
 *
 * FIXED 2026-08-13. This used to write the SQL to a temp file and pass
 * `--file`, on the reasoning that a temp file cannot be mangled by shell
 * quoting. It cannot anyway — `execFileSync` takes an argv array and never
 * spawns a shell — and `--file` has a behaviour that quietly broke every
 * remote command:
 *
 *   wrangler d1 execute … --remote --file q.sql --json
 *     -> [{ "results": [{ "Total queries executed": 1, "Rows read": 3, … }] }]
 *   wrangler d1 execute … --remote --command "…" --json
 *     -> [{ "results": [{ "email": "…", "tier_slug": "owner", … }] }]
 *
 * With `--remote --file`, wrangler *uploads* the statements and reports a
 * summary instead of the rows. Locally it returns the rows either way, so the
 * whole class of bug was invisible until the first production command:
 * `list --remote` printed `undefined -> undefined`, and `grant --remote` was
 * worse — `requireTierExists` tests `rows.length !== 1`, and the summary IS
 * one row, so the guard passed and handed back a "tier" whose `rank` was
 * `undefined`, which then went into the `audit_log` insert as a bare
 * `undefined` token and failed the batch.
 *
 * `--command` accepts the same multi-statement batches and returns one result
 * object per statement, remote and local alike. Verified against production.
 */
function d1(sql, { remote }) {
	try {
		const args = [
			'd1',
			'execute',
			DATABASE,
			remote ? '--remote' : '--local',
			'--json',
			'--command',
			sql
		];
		const stdout = execFileSync(WRANGLER, args, {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'inherit']
		});
		// `--json` still prints wrangler's banner on some versions; take the JSON.
		const start = stdout.indexOf('[');
		if (start === -1) fail(`could not parse wrangler output:\n${stdout}`);
		const parsed = JSON.parse(stdout.slice(start));

		// The shape this function exists to avoid. If a future wrangler returns
		// the upload summary from `--command` too, stop rather than report
		// `undefined` as though it were data.
		if (parsed[0]?.results?.[0] && 'Total queries executed' in parsed[0].results[0]) {
			fail(
				'wrangler returned a batch summary instead of rows, so nothing below could be\n' +
					'trusted. See the comment above `d1()` in this file.'
			);
		}

		return parsed;
	} catch (cause) {
		if (cause instanceof SyntaxError) throw cause;
		fail(`wrangler d1 execute failed. ${cause.message}`);
	}
}

/** Rows from the first (or only) statement in a batch. */
const rowsOf = (results, index = 0) => results[index]?.results ?? [];

const nowLiteral = 'unixepoch()';
const auditId = () => sqlString(randomUUID());

function requireTierExists(slug, options) {
	if (!TIER_SLUGS.includes(slug)) {
		fail(`"${slug}" is not a tier. Known tiers: ${TIER_SLUGS.join(', ')}.`);
	}
	const rows = rowsOf(d1(`SELECT slug, rank FROM tier WHERE slug = ${sqlString(slug)};`, options));
	if (rows.length !== 1) {
		fail(`the tier table has no row for "${slug}". Has \`pnpm db:apply\` been run?`);
	}
	return rows[0];
}

function grant(positional, flags) {
	const [rawEmail, rawTier] = positional;
	if (!rawEmail || !rawTier) fail(`grant needs an email and a tier.\n\n${USAGE}`);

	const email = normaliseEmail(rawEmail);
	const slug = String(rawTier).trim().toLowerCase();

	if (slug === OWNER_SLUG && !flags['allow-owner']) {
		fail(
			`granting "${OWNER_SLUG}" hands over the whole site. Re-run with --allow-owner if you mean it.`
		);
	}

	const tier = requireTierExists(slug, flags);
	const actor = sqlString(flags.by ?? 'cli');
	const note = flags.note === undefined ? 'NULL' : sqlString(flags.note);

	// The grant and its audit row go in one batch so a failure part-way through
	// is visible immediately, and the trailing SELECT is what this reports —
	// nothing is printed as granted that was not read back out of the table.
	const results = d1(
		`INSERT INTO access_grant (email, tier_slug, note, granted_at, granted_by, revoked_at)
VALUES (${sqlString(email)}, ${sqlString(slug)}, ${note}, ${nowLiteral}, ${actor}, NULL)
ON CONFLICT(email) DO UPDATE SET
	tier_slug = excluded.tier_slug,
	note = excluded.note,
	granted_at = excluded.granted_at,
	granted_by = excluded.granted_by,
	revoked_at = NULL;
INSERT INTO audit_log (id, at, actor, action, target, detail, ip_prefix)
VALUES (${auditId()}, ${nowLiteral}, ${actor}, 'grant', ${sqlString(email)},
	json_object('tier', ${sqlString(slug)}, 'rank', ${tier.rank}), NULL);
SELECT email, tier_slug, note, granted_at, granted_by, revoked_at FROM access_grant WHERE email = ${sqlString(email)};`,
		flags
	);

	const [row] = rowsOf(results, 2);
	if (!row) fail('the grant did not land; nothing was written.');
	console.log(`granted ${row.email} -> ${row.tier_slug} (rank ${tier.rank})`);
	console.log('audit_log row written.');
}

function revoke(positional, flags) {
	const [rawEmail] = positional;
	if (!rawEmail) fail(`revoke needs an email.\n\n${USAGE}`);

	const email = normaliseEmail(rawEmail);
	const actor = sqlString(flags.by ?? 'cli');

	const existing = rowsOf(
		d1(
			`SELECT tier_slug FROM access_grant WHERE email = ${sqlString(email)} AND revoked_at IS NULL;`,
			flags
		)
	);
	if (existing.length === 0) {
		fail(`${email} has no active grant, so there is nothing to revoke.`);
	}

	d1(
		`UPDATE access_grant SET revoked_at = ${nowLiteral}
WHERE email = ${sqlString(email)} AND revoked_at IS NULL;
INSERT INTO audit_log (id, at, actor, action, target, detail, ip_prefix)
VALUES (${auditId()}, ${nowLiteral}, ${actor}, 'revoke', ${sqlString(email)},
	json_object('tier', ${sqlString(existing[0].tier_slug)}), NULL);`,
		flags
	);

	console.log(`revoked ${email} (was ${existing[0].tier_slug})`);
	console.log('audit_log row written.');
	// The tier is resolved from `access_grant` on every request and nothing
	// caches it, so this takes effect on their next page load. Deleting their
	// `session` rows as well — which also forces a re-auth — is M8.1.
	console.log('Their next request resolves to public. Session rows are untouched until M8.1.');
}

function list(_positional, flags) {
	const rows = rowsOf(
		d1(
			`SELECT g.email, g.tier_slug, t.rank, g.note, g.revoked_at
FROM access_grant g LEFT JOIN tier t ON t.slug = g.tier_slug
ORDER BY g.revoked_at IS NOT NULL, t.rank DESC, g.email;`,
			flags
		)
	);

	if (rows.length === 0) {
		console.log('no grants.');
		return;
	}
	for (const row of rows) {
		const state = row.revoked_at ? 'REVOKED' : 'active ';
		console.log(
			`${state} ${row.email} -> ${row.tier_slug} (rank ${row.rank ?? '??'})${row.note ? ` — ${row.note}` : ''}`
		);
	}
}

const COMMANDS = { grant, revoke, list };

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

if (flags.help || !command) {
	console.log(USAGE);
	process.exit(flags.help ? 0 : 1);
}

const run = COMMANDS[command];
if (!run) fail(`unknown command "${command}".\n\n${USAGE}`);

run(rest, flags);
