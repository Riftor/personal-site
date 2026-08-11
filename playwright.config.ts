import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	// `preview` is `wrangler dev` against the built Worker, so the tests run on
	// the real runtime with the local D1 binding — the same path production takes.
	//
	// The seed step sits between the build and the server on purpose: it writes
	// the access fixtures with `wrangler d1 execute --local`, and doing that
	// while `wrangler dev` holds the same SQLite file open is asking for a flaky
	// suite. Sequencing it here means the rows are in place before the Worker
	// has started, with no contention at all.
	webServer: { command: 'npm run build && npm run test:seed && npm run preview', port: 4173 },
	use: { baseURL: 'http://localhost:4173' }
});
