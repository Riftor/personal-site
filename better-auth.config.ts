import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

/**
 * Codegen-only entry point for `pnpm auth:generate`
 * (`@better-auth/cli generate`), which needs a Better Auth instance it can
 * import without a Cloudflare request.
 *
 * The real instance lives in `src/lib/server/auth.ts` and is built per request
 * from `platform.env`, so the CLI cannot load it. Only the options that change
 * the *shape* of the generated tables matter here — plugins and additional
 * fields — and this project has neither, so the output is Better Auth's stock
 * schema. Runtime settings (secret, provider credentials, session lifetime,
 * cookie cache, database hooks) are deliberately absent: none of them affect
 * codegen, and duplicating them would create two places to get them wrong.
 *
 * If a plugin or an extra column is ever added to `src/lib/server/auth.ts`,
 * mirror it here and re-run the generate step.
 *
 * `pnpm auth:generate` pins `@better-auth/cli@1.4.21`, which is the CLI's
 * latest release against a runtime `better-auth@1.6.26` — they version
 * separately. The output was checked column-for-column against the installed
 * runtime's `getAuthTables()` and matches. Re-check that when `better-auth` is
 * upgraded, and bump the pinned CLI at the same time.
 */
export const auth = betterAuth({
	// Never connected to; the adapter is named so the CLI emits Drizzle tables
	// for SQLite rather than raw SQL or a Prisma model.
	database: drizzleAdapter({}, { provider: 'sqlite' }),
	emailAndPassword: { enabled: false },
	socialProviders: { google: { clientId: '', clientSecret: '' } }
});
