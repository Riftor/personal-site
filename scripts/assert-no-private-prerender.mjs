#!/usr/bin/env node
/**
 * Fails the build if a private page could ever be served without the Worker.
 *
 * Cloudflare serves static assets *before* the Worker runs, so an HTML file in
 * the build output is a page that `hooks.server.ts` — and therefore every
 * access check in this codebase — never sees. Plan §2 calls this the Static
 * Assets footgun and rates it the single most dangerous failure mode in the
 * architecture, because it fails silently and successfully: the page renders,
 * looks right, and is readable by the whole internet.
 *
 * Two passes, because they catch it at different moments:
 *
 *   --source   before the build. Reads every route module under
 *              `src/routes/(private)/` and rejects any `prerender` export that
 *              is not `false`, or any `ssr` export that is not `true`. Fast,
 *              deterministic, and it names the offending line.
 *
 *   --output   after the build. Rejects any `.html` in the build output at
 *              all. Nothing in this project is prerendered — the public pages
 *              read from D1 too — so an HTML file appearing here is either a
 *              prerendered route or a configuration change nobody thought
 *              through. Also rejects any output path containing "private".
 *
 * With no flag it runs both. `pnpm build` runs `--source` first so the failure
 * arrives before Vite has spent a minute proving the same thing.
 *
 * Usage: node scripts/assert-no-private-prerender.mjs [--source] [--output] [dir]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_ROUTES_DIR = join(REPO_ROOT, 'src', 'routes', '(private)');
const DEFAULT_OUTPUT_DIRS = [
	join(REPO_ROOT, '.svelte-kit', 'cloudflare'),
	// SvelteKit writes prerendered pages here before the adapter copies them.
	join(REPO_ROOT, '.svelte-kit', 'output', 'prerendered')
];

const failures = [];

function fail(where, message) {
	failures.push(`${relative(REPO_ROOT, where) || where}: ${message}`);
}

function* walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // A directory that was never produced cannot leak anything.
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else if (entry.isFile()) yield path;
	}
}

/**
 * Matches `export const prerender = <value>` and `export const ssr = <value>`.
 * Comments are stripped first so the prose in `+layout.server.ts` — which
 * necessarily talks about `prerender = true` — is not read as code.
 */
function exportedFlags(source) {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	const flags = {};
	for (const match of code.matchAll(/export\s+const\s+(prerender|ssr)\s*=\s*([^;\n]+)/g)) {
		flags[match[1]] = match[2].trim();
	}
	return flags;
}

function checkSource() {
	let sawLayoutOptions = false;

	for (const path of walk(PRIVATE_ROUTES_DIR)) {
		if (!/\.(ts|js)$/.test(path)) continue;

		const flags = exportedFlags(readFileSync(path, 'utf8'));

		if (flags.prerender !== undefined && flags.prerender !== 'false') {
			fail(path, `exports prerender = ${flags.prerender}; a private route must never prerender.`);
		}
		if (flags.ssr !== undefined && flags.ssr !== 'true') {
			fail(path, `exports ssr = ${flags.ssr}; private content must be rendered on the server.`);
		}
		if (path.endsWith(join('(private)', '+layout.server.ts'))) {
			sawLayoutOptions = flags.prerender === 'false' && flags.ssr === 'true';
		}
	}

	if (!sawLayoutOptions) {
		fail(
			join(PRIVATE_ROUTES_DIR, '+layout.server.ts'),
			'must export both `prerender = false` and `ssr = true`; every private route inherits them.'
		);
	}
}

function checkOutput(dirs) {
	let checkedAnything = false;

	for (const dir of dirs) {
		try {
			if (!statSync(dir).isDirectory()) continue;
		} catch {
			continue;
		}
		checkedAnything = true;

		for (const path of walk(dir)) {
			const rel = relative(dir, path);

			if (rel.toLowerCase().includes('private')) {
				fail(path, 'a build artefact under a "private" path is served before the Worker runs.');
			}
			if (/\.html$/i.test(rel)) {
				fail(path, 'prerendered HTML in the build output. Nothing in this project may prerender.');
			}
		}
	}

	if (!checkedAnything) {
		fail(dirs[0], 'no build output to check. Run this after `vite build`.');
	}
}

const args = process.argv.slice(2);
const dirs = args.filter((arg) => !arg.startsWith('--'));
const wantSource = args.includes('--source') || !args.some((a) => a.startsWith('--'));
const wantOutput = args.includes('--output') || !args.some((a) => a.startsWith('--'));

if (wantSource) checkSource();
if (wantOutput)
	checkOutput(dirs.length > 0 ? dirs.map((d) => join(REPO_ROOT, d)) : DEFAULT_OUTPUT_DIRS);

if (failures.length > 0) {
	console.error('\nassert-no-private-prerender: FAILED\n');
	for (const failure of failures) console.error(`  ✗ ${failure}`);
	console.error(
		'\nA prerendered page is served from the asset store with the Worker never running,\n' +
			'which means no session, no viewer, and no tier check. See plan §2.\n'
	);
	process.exit(1);
}

console.error(
	`assert-no-private-prerender: ok (${[wantSource && 'source', wantOutput && 'output'].filter(Boolean).join(' + ')})`
);
