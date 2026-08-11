import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	// `preview` is `wrangler dev` against the built Worker, so the tests run on
	// the real runtime with the local D1 binding — the same path production takes.
	webServer: { command: 'npm run build && npm run preview', port: 4173 },
	use: { baseURL: 'http://localhost:4173' }
});
