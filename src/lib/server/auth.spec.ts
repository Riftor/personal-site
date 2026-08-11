import { describe, expect, it } from 'vitest';
import {
	SESSION_EXPIRES_IN_SECONDS,
	UNVERIFIED_EMAIL_CODE,
	assertVerifiedEmail,
	createAuth,
	rejectUnverifiedSession,
	rejectUnverifiedUser,
	withoutProviderTokens
} from './auth';

/**
 * These cover the configuration and the database hooks — the parts of M2 that
 * can be asserted without Google. The Google round trip itself cannot run
 * here: it needs a real second account and a real consent screen, so it is a
 * manual step, and nothing in this file should be read as evidence that
 * signing in works end to end.
 */

/** Enough of `platform` for `createAuth` to build; nothing here is queried. */
const platform = {
	env: {
		DB: {} as D1Database,
		BETTER_AUTH_SECRET: 'test-secret-not-a-real-one',
		BETTER_AUTH_URL: 'http://localhost:5173',
		GOOGLE_CLIENT_ID: 'test-client-id',
		GOOGLE_CLIENT_SECRET: 'test-client-secret'
	}
} as unknown as App.Platform;

const options = createAuth(platform, 'http://localhost:5173').options;

describe('auth configuration', () => {
	it('serves the callback path Google has registered', () => {
		// Changing this breaks sign-in in a way no test here would catch,
		// because the other half of the contract lives in Google's console.
		expect(`${options.basePath}/callback/google`).toBe('/api/auth/callback/google');
	});

	it('keeps sessions in the database for 30 days, refreshed daily', () => {
		expect(options.session?.expiresIn).toBe(60 * 60 * 24 * 30);
		expect(options.session?.updateAge).toBe(60 * 60 * 24);
		expect(SESSION_EXPIRES_IN_SECONDS).toBe(60 * 60 * 24 * 30);
	});

	// Plan §2: revocation in M3 depends on D1 being consulted per request. A
	// cached cookie would keep a revoked grant working until the cache aged out.
	it('never caches the session in a cookie', () => {
		expect(options.session?.cookieCache?.enabled).toBe(false);
	});

	it('does not refresh provider tokens on a returning sign-in', () => {
		expect(options.account?.updateAccountOnSignIn).toBe(false);
	});

	it('configures the Google provider with credentials and nothing else', () => {
		// Everything omitted here matters. No `scope`, so the request stays on
		// Better Auth's default `openid email profile` — a sensitive scope, a
		// calendar scope above all, would drag the app into Google's
		// verification review and be conceptually wrong, since visitors prove
		// identity rather than granting Caden anything. No `accessType`, so
		// Google is never asked for offline access and issues no refresh
		// token — there is then nothing to store.
		expect(Object.keys(options.socialProviders?.google ?? {}).sort()).toEqual([
			'clientId',
			'clientSecret'
		]);
		expect(JSON.stringify(options.socialProviders)).not.toContain('calendar');
	});

	it('sends a failed callback back to the sign-in page', () => {
		expect(options.onAPIError?.errorURL).toBe('/signin');
	});

	it('offers no credential other than Google', () => {
		expect(options.emailAndPassword?.enabled).toBe(false);
	});
});

describe('withoutProviderTokens', () => {
	const account = {
		id: 'acct-1',
		accountId: 'google-sub-1',
		providerId: 'google',
		userId: 'user-1',
		accessToken: 'ya29.a-real-looking-token',
		refreshToken: '1//a-real-looking-refresh-token',
		idToken: 'header.payload.signature',
		accessTokenExpiresAt: new Date(),
		refreshTokenExpiresAt: new Date(),
		scope: 'email profile openid',
		createdAt: new Date(),
		updatedAt: new Date()
	};

	it('blanks every provider token on its way to the database', async () => {
		const { data } = (await withoutProviderTokens(account, null)) as { data: typeof account };

		expect(data.accessToken).toBeNull();
		expect(data.refreshToken).toBeNull();
		expect(data.idToken).toBeNull();
		expect(data.accessTokenExpiresAt).toBeNull();
		expect(data.refreshTokenExpiresAt).toBeNull();
	});

	it('keeps the columns that identify the account', async () => {
		const { data } = (await withoutProviderTokens(account, null)) as { data: typeof account };

		expect(data.accountId).toBe('google-sub-1');
		expect(data.providerId).toBe('google');
		expect(data.userId).toBe('user-1');
		// `scope` records what was consented to. It is not a credential.
		expect(data.scope).toBe('email profile openid');
	});
});

describe('assertVerifiedEmail', () => {
	it('accepts an address Google says it has verified', () => {
		expect(() => assertVerifiedEmail({ emailVerified: true })).not.toThrow();
	});

	// Fails closed. M3 matches `session.user.email` against `access_grant`, so
	// an address nobody has proved they own must never reach a session.
	it.each([
		['false', false],
		['missing', undefined],
		['null', null],
		['the string "true"', 'true'],
		['1', 1]
	])('refuses an address whose verified flag is %s', (_label, emailVerified) => {
		expect(() => assertVerifiedEmail({ emailVerified })).toThrowError(UNVERIFIED_EMAIL_CODE);
	});

	it('refuses when there is no user at all', () => {
		expect(() => assertVerifiedEmail(null)).toThrowError(UNVERIFIED_EMAIL_CODE);
		expect(() => assertVerifiedEmail(undefined)).toThrowError(UNVERIFIED_EMAIL_CODE);
	});
});

describe('the sign-in hooks', () => {
	type SessionHookArgs = Parameters<typeof rejectUnverifiedSession>;

	/** Stands in for the endpoint context the session hook is handed. */
	const contextFor = (user: { emailVerified: boolean } | null) =>
		({
			context: { internalAdapter: { findUserById: async () => user } }
		}) as unknown as SessionHookArgs[1];

	const session = { userId: 'user-1' } as SessionHookArgs[0];

	it('stops an unverified address at user creation', async () => {
		await expect(rejectUnverifiedUser({ emailVerified: false } as never, null)).rejects.toThrow(
			UNVERIFIED_EMAIL_CODE
		);
	});

	it('lets a verified address through', async () => {
		await expect(
			rejectUnverifiedUser({ emailVerified: true } as never, null)
		).resolves.toBeUndefined();
		await expect(
			rejectUnverifiedSession(session, contextFor({ emailVerified: true }))
		).resolves.toBeUndefined();
	});

	// `user.create.before` only runs once, so this is what catches a returning
	// visitor whose address Google has stopped vouching for.
	it('stops an unverified address at session creation', async () => {
		await expect(
			rejectUnverifiedSession(session, contextFor({ emailVerified: false }))
		).rejects.toThrow(UNVERIFIED_EMAIL_CODE);
	});

	it('refuses rather than guesses when the user cannot be read', async () => {
		await expect(rejectUnverifiedSession(session, contextFor(null))).rejects.toThrow(
			UNVERIFIED_EMAIL_CODE
		);
		await expect(rejectUnverifiedSession(session, null)).rejects.toThrow(UNVERIFIED_EMAIL_CODE);
		await expect(
			rejectUnverifiedSession({} as SessionHookArgs[0], contextFor({ emailVerified: true }))
		).rejects.toThrow(UNVERIFIED_EMAIL_CODE);
	});
});
