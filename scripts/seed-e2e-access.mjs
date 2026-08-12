#!/usr/bin/env node
/**
 * Seeds the local D1 with the accounts `e2e/access.spec.ts` drives.
 *
 * Done-condition #2 has to be tested by URL against real sessions, and a real
 * session normally costs a real Google account and a real consent screen —
 * which cannot run in CI and cannot run twelve times in a row. So the rows
 * Google's callback would have written are written here instead: a `user`, a
 * `session`, and an `access_grant`, straight into the same tables the running
 * Worker reads.
 *
 * Nothing about the code under test is stubbed. There is no test-only
 * endpoint, no bypass flag, and no branch in `src/` that knows this file
 * exists — deliberately, because a backdoor built for a security test is
 * still a backdoor. The session cookies handed to Playwright are signed with
 * the same HMAC Better Auth uses, so the server verifies them exactly as it
 * verifies a real one; if the signing were wrong, every signed-in case in the
 * suite would fail as signed-out.
 *
 * Runs between `vite build` and `wrangler dev` in the Playwright `webServer`
 * command, so it never contends with the dev server for the SQLite file.
 *
 * LOCAL D1 ONLY. There is no `--remote` path here and there must never be one.
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE = 'personal-site';
const FIXTURES_PATH = join(REPO_ROOT, 'e2e', '.access-fixtures.json');
const SESSION_COOKIE = 'better-auth.session_token';

const WRANGLER =
	['wrangler', 'wrangler.cmd']
		.map((name) => join(REPO_ROOT, 'node_modules', '.bin', name))
		.find((path) => existsSync(path)) ?? 'wrangler';

/**
 * The cast. Emails are under `.test`, a reserved TLD that can never be a real
 * Google account, and every one of them starts `e2e-` so the cleanup below
 * cannot touch a row Caden created by hand.
 */
const FIXTURES = [
	{ key: 'friend', tier: 'friend', revoked: false },
	{ key: 'family', tier: 'family', revoked: false },
	{ key: 'partner', tier: 'partner', revoked: false },
	// Signed in, never granted anything. Plan §2: this is not a pending state,
	// it is simply the public tier.
	{ key: 'nogrant', tier: null, revoked: false },
	// A live grant that names the tier whose `calendar_detail` is `none`.
	// Nothing is wrong with this row; it simply grants no calendar, and the
	// page has to refuse rather than render an empty week.
	{ key: 'publictier', tier: 'public', revoked: false },
	// Granted, then soft-revoked. Must behave exactly like `nogrant`.
	{ key: 'revoked', tier: 'family', revoked: true }
];

const EMAIL_PREFIX = 'e2e-';
const EMAIL_DOMAIN = '@example.test';

function fail(message) {
	console.error(`seed-e2e-access: ${message}`);
	process.exit(1);
}

/**
 * Reads one key out of `.dev.vars`. The file holds real Google credentials, so
 * this returns the value and never logs it, and the caller only ever uses it
 * as an HMAC key.
 */
function devVar(name) {
	const path = join(REPO_ROOT, '.dev.vars');
	if (!existsSync(path)) fail('.dev.vars is missing; the e2e sessions cannot be signed.');

	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (match?.[1] !== name) continue;

		return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
	}
	fail(`${name} is not set in .dev.vars.`);
}

/**
 * Better Auth stores the session token in a cookie signed by `better-call`:
 * `encodeURIComponent(token + "." + base64(HMAC-SHA256(secret, token)))`.
 * Reproduced here rather than imported because the import path is an internal
 * one; `e2e/access.spec.ts` would fail loudly if this ever drifted.
 */
function signedSessionCookie(token, secret) {
	const signature = createHmac('sha256', secret).update(token).digest('base64');
	return encodeURIComponent(`${token}.${signature}`);
}

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;

function d1(statements) {
	const dir = mkdtempSync(join(tmpdir(), 'personal-site-seed-'));
	const file = join(dir, 'seed.sql');
	writeFileSync(file, statements.join('\n'));

	try {
		execFileSync(WRANGLER, ['d1', 'execute', DATABASE, '--local', '--file', file], {
			cwd: REPO_ROOT,
			stdio: ['ignore', 'ignore', 'inherit']
		});
	} catch (cause) {
		fail(`wrangler d1 execute failed. ${cause.message}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const secret = devVar('BETTER_AUTH_SECRET');
const now = Date.now();
const thirtyDays = 30 * 24 * 60 * 60 * 1000;

// Migrations first: a fresh checkout has no `access_grant` table, and a suite
// that fails on a missing table teaches nobody anything.
execFileSync(WRANGLER, ['d1', 'migrations', 'apply', DATABASE, '--local'], {
	cwd: REPO_ROOT,
	stdio: ['ignore', 'ignore', 'inherit']
});

const statements = [
	// Idempotent: every run starts from no fixture rows at all, so a tier
	// changed in this file cannot be shadowed by last run's grant.
	`DELETE FROM session WHERE user_id LIKE 'e2e_%';`,
	`DELETE FROM user WHERE id LIKE 'e2e_%';`,
	`DELETE FROM access_grant WHERE email LIKE '${EMAIL_PREFIX}%${EMAIL_DOMAIN}';`
];

const fixtures = {};

for (const { key, tier, revoked } of FIXTURES) {
	const email = `${EMAIL_PREFIX}${key}${EMAIL_DOMAIN}`;
	const userId = `e2e_${key}`;
	const token = `e2e-${key}-${randomUUID()}`;

	statements.push(
		`INSERT INTO user (id, name, email, email_verified, image, created_at, updated_at)
VALUES (${sql(userId)}, ${sql(`E2E ${key}`)}, ${sql(email)}, 1, NULL, ${now}, ${now});`,
		`INSERT INTO session (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id)
VALUES (${sql(`e2e_session_${key}`)}, ${now + thirtyDays}, ${sql(token)}, ${now}, ${now}, NULL, NULL, ${sql(userId)});`
	);

	if (tier) {
		statements.push(
			`INSERT INTO access_grant (email, tier_slug, note, granted_at, granted_by, revoked_at)
VALUES (${sql(email)}, ${sql(tier)}, 'e2e fixture', ${Math.floor(now / 1000)}, 'e2e',
	${revoked ? Math.floor(now / 1000) : 'NULL'});`
		);
	}

	fixtures[key] = { email, tier, revoked, cookie: signedSessionCookie(token, secret) };
}

d1(statements);

writeFileSync(
	FIXTURES_PATH,
	`${JSON.stringify({ cookieName: SESSION_COOKIE, fixtures }, null, '\t')}\n`
);

console.error(
	`seed-e2e-access: seeded ${FIXTURES.length} accounts into local D1 -> e2e/.access-fixtures.json`
);
