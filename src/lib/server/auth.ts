import { error } from '@sveltejs/kit';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { BetterAuthOptions } from 'better-auth/types';
import { recordSignIn } from './audit';
import { getDb } from './db';
import * as schema from './db/schema';

/**
 * Better Auth, wired to D1 through Drizzle. Identity only — see plan §2.
 *
 * A successful Google sign-in proves an email address and nothing else. There
 * is no tier lookup and no authorization decision anywhere in this file; that
 * arrives with `access_grant` and `requireTier` in M3. The one thing this file
 * owes M3 is a session whose email can be trusted, which is why the
 * `email_verified` gate below is not optional.
 */

/**
 * The `databaseHooks` callback signatures, pulled off the options type so the
 * hooks below can be written — and unit tested — as named functions without
 * importing `@better-auth/core`, a transitive dependency this project does not
 * declare.
 */
type DatabaseHooks = NonNullable<BetterAuthOptions['databaseHooks']>;
type UserCreateBefore = NonNullable<NonNullable<DatabaseHooks['user']>['create']>['before'];
type SessionCreateBefore = NonNullable<NonNullable<DatabaseHooks['session']>['create']>['before'];
type SessionCreateAfter = NonNullable<NonNullable<DatabaseHooks['session']>['create']>['after'];
type AccountCreateBefore = NonNullable<NonNullable<DatabaseHooks['account']>['create']>['before'];

const DAY_SECONDS = 60 * 60 * 24;

/** Plan §2: 30-day sessions, refreshed once they are older than a day. */
export const SESSION_EXPIRES_IN_SECONDS = 30 * DAY_SECONDS;
const SESSION_UPDATE_AGE_SECONDS = DAY_SECONDS;

/** Where the OAuth callback sends a visitor when the flow fails. */
export const SIGNIN_PATH = '/signin';

/**
 * The `?error=` value `/signin` renders copy for when Google reports an
 * address the account holder has not proved they own.
 */
export const UNVERIFIED_EMAIL_CODE = 'EMAIL_NOT_VERIFIED';

/**
 * Columns Better Auth would otherwise fill on `account` from the token
 * response. Plan §3: visitors authenticate to prove identity, so there is
 * nothing here this site can use, and storing an unused credential is pure
 * blast radius.
 */
const PROVIDER_TOKEN_COLUMNS = {
	accessToken: null,
	refreshToken: null,
	idToken: null,
	accessTokenExpiresAt: null,
	refreshTokenExpiresAt: null
};

/**
 * Blanks the provider tokens on an `account` row on its way to the database.
 *
 * `account.updateAccountOnSignIn: false` already stops Better Auth refreshing
 * them on a returning sign-in, but the *first* sign-in writes them as part of
 * the insert, and account linking writes them again. This hook is the one
 * place both paths pass through. `scope` is deliberately kept: it records what
 * was consented to and is not a credential.
 */
export const withoutProviderTokens: NonNullable<AccountCreateBefore> = async (account) => ({
	data: { ...account, ...PROVIDER_TOKEN_COLUMNS }
});

/**
 * Fails a sign-in whose Google profile carries `email_verified: false`.
 *
 * M3 resolves a viewer's tier by matching `session.user.email` against
 * `access_grant`. An address nobody has proved they own must therefore never
 * reach a session row, or a grant could be claimed by someone who merely typed
 * the address into a Google account. Fails closed: anything other than an
 * explicit `true` is a refusal.
 *
 * `message` duplicates `code` on purpose. Better Auth surfaces `e.body.code`
 * when the throw happens on the session path and `e.message` when it happens
 * on the user-create path, and `/signin` has to render one string for both.
 */
export function assertVerifiedEmail(user: { emailVerified?: unknown } | null | undefined) {
	if (user?.emailVerified === true) return;

	throw new APIError('FORBIDDEN', {
		code: UNVERIFIED_EMAIL_CODE,
		message: UNVERIFIED_EMAIL_CODE
	});
}

/** First sign-in: refuse to create the `user` row at all. */
export const rejectUnverifiedUser: NonNullable<UserCreateBefore> = async (user) => {
	assertVerifiedEmail(user);
};

/**
 * Every sign-in, including a returning visitor's — `user.create.before` only
 * runs once, so on its own it would let an address that was verified when the
 * row was written keep signing in after Google stopped vouching for it.
 * Without the endpoint context there is no way to read the user, so the
 * session is refused rather than allowed.
 */
export const rejectUnverifiedSession: NonNullable<SessionCreateBefore> = async (
	session,
	context
) => {
	const user = session.userId
		? await context?.context.internalAdapter.findUserById(session.userId)
		: null;

	assertVerifiedEmail(user);
};

/**
 * The `signin` row in `audit_log` (plan §8.2).
 *
 * `session.create.after` is the only honest place for it. A session row is
 * created exactly once per sign-in — a returning visitor's refresh is an
 * *update*, and `user.create.before` fires only the very first time an address
 * is seen — so this fires once per sign-in and never for a sign-in that was
 * refused, because `rejectUnverifiedSession` runs before it and throws.
 *
 * Two things it must not do. It must not fail a sign-in: the after-hooks are
 * awaited by Better Auth, so the user lookup is caught and `recordSignIn`
 * never rejects by construction. And it must not invent an actor: if the user
 * row cannot be read the row is still written, with a NULL actor, because
 * "somebody signed in at this time and we could not say who" is a fact worth
 * having rather than a reason to write nothing.
 */
export function auditSignIn(
	platform: App.Platform | undefined,
	headers: Headers | undefined
): NonNullable<SessionCreateAfter> {
	return async (session, context) => {
		let email: string | null = null;

		try {
			const user = session.userId
				? await context?.context.internalAdapter.findUserById(session.userId)
				: null;
			// Lowercased, because `access_grant.email` and the CLI's own audit
			// rows are, and a log that does not join to them is half a log.
			if (typeof user?.email === 'string') email = user.email.trim().toLowerCase();
		} catch (cause) {
			console.error(
				'audit: the signed-in user could not be read; recording an anonymous signin.',
				cause
			);
		}

		recordSignIn(platform, headers, email);
	};
}

/**
 * Both `vite dev` and `wrangler dev` supply the bindings and `.dev.vars`, so a
 * missing one means the server is running outside the Cloudflare runtime — a
 * misconfiguration, not a request that can degrade into an anonymous page.
 */
function requireEnv(platform: App.Platform | undefined) {
	const env = platform?.env;
	if (!env?.DB || !env.BETTER_AUTH_SECRET || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		error(500, 'Auth is not configured: DB, BETTER_AUTH_SECRET or the Google client is missing.');
	}
	return env;
}

/**
 * Builds the Better Auth instance for one request.
 *
 * It cannot be a module singleton: the D1 binding and the secrets only exist
 * on `platform.env`, which is per-request on Workers.
 *
 * `baseURL` is the origin of the request being served rather than
 * `BETTER_AUTH_URL`, because the same Worker answers on `:5173` (`pnpm dev`),
 * `:4173` (`pnpm preview`) and the production domain, and the callback URL it
 * hands Google has to match whichever one the visitor actually started from.
 * The real allowlist is Google's registered redirect URIs — a request claiming
 * an origin Caden has not registered gets `redirect_uri_mismatch` from Google
 * and never reaches a token exchange.
 *
 * `requestHeaders` is only ever read for `CF-Connecting-IP`, so that the
 * `signin` audit row can carry a truncated prefix. Every call site passes the
 * inbound request's headers; only the one that runs Better Auth's own handler
 * — the Google callback at `/api/auth/callback/google` — ever creates a session
 * and therefore ever reaches the hook that uses them.
 */
export function createAuth(
	platform: App.Platform | undefined,
	baseURL: string,
	requestHeaders?: Headers
) {
	const env = requireEnv(platform);

	return betterAuth({
		baseURL,
		basePath: '/api/auth',
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(getDb(env.DB), { provider: 'sqlite', schema }),

		// `BETTER_AUTH_URL` is the origin Caden signs in on day to day; keeping
		// it trusted means a `next=` value written against it still resolves
		// when the request came in on another registered origin.
		trustedOrigins: env.BETTER_AUTH_URL ? [env.BETTER_AUTH_URL] : [],

		// No email provider exists and none is planned (plan, assumption 4).
		// Google is the only credential this site accepts.
		emailAndPassword: { enabled: false },

		socialProviders: {
			google: {
				clientId: env.GOOGLE_CLIENT_ID,
				clientSecret: env.GOOGLE_CLIENT_SECRET
				// Scopes are left at Better Auth's default `openid email profile`.
				// Adding anything sensitive here — a calendar scope above all —
				// pulls the app into Google's verification process and is
				// conceptually wrong: visitors prove identity, they grant nothing.
				// `accessType` is likewise left at `online`, so Google is never
				// asked for a refresh token in the first place.
			}
		},

		session: {
			expiresIn: SESSION_EXPIRES_IN_SECONDS,
			updateAge: SESSION_UPDATE_AGE_SECONDS,
			// Plan §2, load-bearing: every request re-reads the session row from
			// D1. A cached copy in the cookie would keep a revoked grant working
			// until the cookie aged out, and M3's revocation story is exactly
			// "the next request sees the change". Off is Better Auth's default;
			// it is written out because it must stay off.
			cookieCache: { enabled: false }
		},

		account: {
			// Stops the token columns being refreshed on every returning
			// sign-in. The insert is handled by the database hook below.
			updateAccountOnSignIn: false
		},

		databaseHooks: {
			user: { create: { before: rejectUnverifiedUser } },
			session: {
				create: { before: rejectUnverifiedSession, after: auditSignIn(platform, requestHeaders) }
			},
			account: { create: { before: withoutProviderTokens } }
		},

		// A failed callback lands back on the sign-in page with `?error=<code>`
		// rather than on Better Auth's own error page, which is unstyled and
		// tells a visitor nothing they can act on.
		onAPIError: { errorURL: SIGNIN_PATH }
	});
}
