import { defineConfig } from 'drizzle-kit';

// Migrations are generated offline and applied with `wrangler d1 migrations apply`,
// so `db:generate` needs no credentials. The d1-http driver below is only exercised
// by `db:push` / `db:studio` against remote D1, which needs CLOUDFLARE_ACCOUNT_ID,
// CLOUDFLARE_DATABASE_ID and CLOUDFLARE_D1_TOKEN in the environment. No remote
// database exists yet, so those are blank until deploy.
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'sqlite',
	driver: 'd1-http',
	dbCredentials: {
		accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
		databaseId: process.env.CLOUDFLARE_DATABASE_ID ?? '',
		token: process.env.CLOUDFLARE_D1_TOKEN ?? ''
	},
	verbose: true,
	strict: true
});
