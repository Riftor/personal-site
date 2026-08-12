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
	//
	// `test:seed:media` transcodes the fixtures and uploads them to local R2
	// through the real publish CLI, and `test:seed:content` does the same for
	// the `content/` folders through the M6 one. Both are slow the first time —
	// a cold run is minutes of ffmpeg and one `wrangler r2 object put` per
	// object — and close to nothing afterwards, because the publisher skips
	// anything whose content hash has not moved. The timeout is sized for the
	// cold case.
	webServer: {
		command:
			'npm run build && npm run test:seed && npm run test:seed:media && ' +
			'npm run test:seed:content && npm run preview',
		port: 4173,
		timeout: 600_000
	},
	use: { baseURL: 'http://localhost:4173' }
});
