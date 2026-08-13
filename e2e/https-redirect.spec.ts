import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * Plan §8.7 on the wire: HTTP→HTTPS, and the open redirect the M8 review found
 * in the first version of it.
 *
 * **Why this file exists rather than three more cases in
 * `security-headers.spec.ts`.** Two properties here cannot be asserted against
 * the shared preview server, and each one costs something to get at.
 *
 * **1. `wrangler dev` rewrites the request's own origin out of every response
 * header it emits.** Not the `Location` header specifically, and not on
 * redirect statuses specifically — a probe worker returning
 * `x-copy: https://h/x` on a **200** had that custom header rewritten to
 * `http://h/x` too, while the same string for a *different* host came back
 * untouched. It is a blanket substitution that keeps dev redirects pointing at
 * the local server. The consequence for this feature is severe and was very
 * nearly shipped: the unit test asserted `https://`, passed, and the wire said
 * `http://` — which in production is an infinite redirect loop that upgrades
 * nothing.
 *
 * The substitution matches the request's whole origin, port included, so a
 * `Host` carrying the port (`site.test:4189`, which is what a browser sends to
 * a non-default port anyway) is not rewritten while the Worker still reads
 * `url.hostname` as `site.test`. That is the seam these tests use, and it is
 * the reason the assertions below insist on the port.
 *
 * **2. The shared preview's `BETTER_AUTH_URL` names a loopback origin,** as it
 * must — it is the origin Caden signs in on locally, and Google's registered
 * redirect URIs are the other half of that contract. Since loopback is exempt,
 * the 301 branch is simply unreachable there: every non-loopback name is a 400
 * and every loopback one is served. So the redirect half stands up its own
 * `wrangler dev` on the real built Worker with `--var BETTER_AUTH_URL:…`
 * pointing at a name that is not this machine.
 *
 * That second server gets `--persist-to` a temp directory, so it shares no D1
 * or R2 state with the suite's own server and cannot contend for the SQLite
 * files. It therefore has **no seeded database**, which is fine: everything
 * asserted against it is answered by `handle` before a binding is touched.
 * Nothing here may assert a 200 from it.
 */

const SITE_HOST = 'redirect-e2e.test';
const ISOLATED_PORT = 4189;
const PREVIEW_PORT = 4173; // `playwright.config.ts`, and `pnpm preview`.

type Wire = { status: number; location: string | undefined; body: string };

/**
 * One request with a `Host` header of our choosing, through `node:http`.
 *
 * The Worker builds `event.url` from `Host`, so this is the only way to make a
 * request that looks like it arrived at the real site. Playwright's request
 * context manages `Host` itself and will not be told otherwise — and a test for
 * a spoofed-`Host` vulnerability that cannot spoof `Host` is not a test.
 */
function get(port: number, host: string, path: string): Promise<Wire> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: '127.0.0.1', port, path, method: 'GET', headers: { host } },
			(res) => {
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () =>
					resolve({ status: res.statusCode ?? 0, location: res.headers.location, body })
				);
			}
		);

		req.on('error', reject);
		req.end();
	});
}

/* ------------------------------------------------------------------ *
 * Against the suite's own preview server, whose canonical origin is
 * loopback: everything non-loopback is refused, and loopback is served.
 * ------------------------------------------------------------------ */

test('a spoofed Host is refused, and the response names it nowhere', async () => {
	// The M8 review's finding, as it would be exploited: a link to
	// `http://cadenedam.com/signin` that bounces the visitor to somebody
	// else's login page, one hop before they type a Google password.
	const spoofed = await get(PREVIEW_PORT, 'attacker.example', '/private/photos');

	expect(spoofed.status).toBe(400);
	expect(spoofed.location).toBeUndefined();
	expect(spoofed.body).not.toContain('attacker.example');
});

test('every shape of a not-this-site Host is refused the same way', async () => {
	for (const host of [
		'attacker.example',
		'localhost.evil.example',
		'127.0.0.1.evil.example',
		'notlocalhost'
	]) {
		const refused = await get(PREVIEW_PORT, host, '/signin?next=%2Fprivate%2Fnow');

		expect(refused.status, host).toBe(400);
		expect(refused.location, host).toBeUndefined();
		expect(refused.body, host).not.toContain(host);
	}
});

test('a request to this machine is served, not redirected and not refused', async () => {
	// This is what keeps the other 91 tests alive: `pnpm dev` and `pnpm
	// preview` are both plain HTTP on loopback.
	expect((await get(PREVIEW_PORT, `localhost:${PREVIEW_PORT}`, '/')).status).toBe(200);
	expect((await get(PREVIEW_PORT, `127.0.0.1:${PREVIEW_PORT}`, '/')).status).toBe(200);

	// Still the signed-out 302 to `/signin`, unchanged by any of this.
	const priv = await get(PREVIEW_PORT, `localhost:${PREVIEW_PORT}`, '/private/photos');
	expect(priv.status).toBe(302);
	expect(priv.location).toContain('/signin');
});

/* ------------------------------------------------------------------ *
 * Against a Worker that believes it is `redirect-e2e.test`: the 301,
 * and the scheme on it.
 * ------------------------------------------------------------------ */

test.describe('with a non-loopback canonical origin', () => {
	let server: ChildProcess | undefined;
	let state: string | undefined;

	test.beforeAll(async () => {
		// A cold `wrangler dev` is 15–25 seconds, well past the default.
		test.setTimeout(180_000);

		state = mkdtempSync(join(tmpdir(), 'personal-site-redirect-e2e-'));
		const logPath = join(state, 'wrangler.log');
		const log = openSync(logPath, 'a');

		server = spawn(
			'node_modules/.bin/wrangler',
			[
				'dev',
				'.svelte-kit/cloudflare/_worker.js',
				'--port',
				String(ISOLATED_PORT),
				'--var',
				`BETTER_AUTH_URL:https://${SITE_HOST}`,
				'--persist-to',
				state
			],
			// Its own process group. `wrangler dev` spawns `workerd` as a child,
			// and killing only the parent leaves an orphan holding the port —
			// which then fails every later run with `Address already in use`.
			// Signalling the group is what actually stops it.
			{ cwd: process.cwd(), detached: true, stdio: ['ignore', log, log] }
		);
		closeSync(log);

		// Poll rather than parse the log: readiness is "it answers", and
		// nothing here should depend on wrangler's banner wording.
		const deadline = Date.now() + 120_000;
		for (;;) {
			try {
				await get(ISOLATED_PORT, `${SITE_HOST}:${ISOLATED_PORT}`, '/');
				return;
			} catch {
				if (Date.now() > deadline) {
					// The commonest cause is a leaked `workerd` from an earlier
					// run still on the port, and wrangler says so — so say what
					// it said rather than reporting a bare ECONNREFUSED.
					throw new Error(
						`wrangler dev never answered on :${ISOLATED_PORT}.\n\n${readFileSync(logPath, 'utf8').slice(-2000)}`
					);
				}
				await new Promise((wake) => setTimeout(wake, 500));
			}
		}
	});

	test.afterAll(() => {
		if (server?.pid) {
			try {
				process.kill(-server.pid, 'SIGKILL');
			} catch {
				// Already gone; nothing to clean up.
			}
		}
		if (state) rmSync(state, { recursive: true, force: true });
	});

	test('a cleartext request for this site is 301’d to HTTPS', async () => {
		const redirected = await get(ISOLATED_PORT, `${SITE_HOST}:${ISOLATED_PORT}`, '/private/photos');

		expect(redirected.status).toBe(301);
		// The assertion the whole file is here for. `startsWith` rather than a
		// `toContain`, because `http://…` contains neither more nor less of the
		// string than the bug did.
		expect(redirected.location?.startsWith('https://')).toBe(true);
		expect(redirected.location).toBe(`https://${SITE_HOST}/private/photos`);
	});

	test('the query survives the hop, so `?next=` still means something', async () => {
		const redirected = await get(
			ISOLATED_PORT,
			`${SITE_HOST}:${ISOLATED_PORT}`,
			'/signin?next=%2Fprivate%2Fnow'
		);

		expect(redirected.status).toBe(301);
		expect(redirected.location).toBe(`https://${SITE_HOST}/signin?next=%2Fprivate%2Fnow`);
	});

	test('a spoofed Host is still refused, even where a real one is redirected', async () => {
		// The branch that matters: this server *does* redirect, so a spoofed
		// host reaching the same code must be turned away rather than carried.
		const spoofed = await get(ISOLATED_PORT, 'attacker.example', '/private/photos');

		expect(spoofed.status).toBe(400);
		expect(spoofed.location).toBeUndefined();
		expect(spoofed.body).not.toContain('attacker.example');
	});
});
