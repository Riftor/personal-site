/**
 * The second of the two Google credentials in this system (plan §2, §4): the
 * service account that reads *Caden's* calendar. It has nothing to do with
 * visitor sign-in, and the two must never be confused — visitors authenticate
 * with `openid email profile` and grant this site nothing.
 *
 * There is no Node crypto on Workers and `google-auth-library` is Node-shaped,
 * so the whole flow is WebCrypto: build a JWT claim set, sign it RS256, and
 * trade the assertion for a one-hour access token. Plan §4 budgets ~40 lines
 * for this and forbids pulling in a Node-targeted Google SDK.
 *
 * Three properties this file has to keep:
 *
 *  1. **The private key never leaves this module.** It is read from the
 *     environment, imported into a non-extractable `CryptoKey`, and used to
 *     sign. No error message in here quotes it, and none quotes the token
 *     either — errors carry a status code and nothing else.
 *  2. **The minted token is cached, never persisted.** 55 minutes in the Cache
 *     API against a 60-minute lifetime, so a token is replaced before it can
 *     be handed out expired. It never touches D1 (plan §4).
 *  3. **A missing or malformed credential fails loudly, not silently.** The
 *     placeholder in `.dev.vars` is PEM-shaped, so "is it non-empty" passes on
 *     it; the length check below is what actually catches it.
 */

/** The only scope this credential ever asks for. Read-only, one calendar. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Google's ceiling for a service-account assertion. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/**
 * Five minutes short of the token's own hour, so a cache entry can never be
 * handed to a request that then spends its life on an expired credential.
 */
const TOKEN_CACHE_TTL_SECONDS = 55 * 60;

/** Not a URL anything can route to — the Cache API only needs a unique key. */
const TOKEN_CACHE_KEY = 'https://cache.internal/google/sa-access-token';

const TOKEN_CACHE_NAME = 'google-sa-token';

/**
 * A real PKCS#8 RSA-2048 key is ~1,700 characters of PEM. The placeholder that
 * ships in `.dev.vars.example` — and that sat in the real `.dev.vars` through
 * M4 — is ~70, and it carries the BEGIN/END armour, so it looks valid to
 * everything except a length check. See HANDOFF.md, "Credentials".
 */
const MIN_PRIVATE_KEY_LENGTH = 1000;

export type ServiceAccountCredentials = {
	/**
	 * `something@project.iam.gserviceaccount.com`, and the JWT's `iss`. There
	 * is deliberately no `sub`: that claim impersonates another user and needs
	 * domain-wide delegation, which plan §4 rules out. This credential acts as
	 * itself, on a calendar that was shared with it.
	 */
	clientEmail: string;
	/** PKCS#8 PEM, possibly with literal `\n` two-character sequences. */
	privateKeyPem: string;
};

/**
 * Reads the credential out of the Worker environment, or `null` if what is
 * there is not one.
 *
 * `null` rather than a throw because the caller — the calendar page — has a
 * defined answer for "no calendar available" and should render that rather
 * than a 500. Every rejection is logged, because a calendar that is quietly
 * unavailable for a week is worse than one that is loudly broken for an hour.
 */
export function readServiceAccountCredentials(
	env: Partial<Env> | undefined
): ServiceAccountCredentials | null {
	const clientEmail = typeof env?.GOOGLE_SA_EMAIL === 'string' ? env.GOOGLE_SA_EMAIL.trim() : '';
	const privateKeyPem =
		typeof env?.GOOGLE_SA_PRIVATE_KEY === 'string' ? env.GOOGLE_SA_PRIVATE_KEY.trim() : '';

	if (!clientEmail.endsWith('.iam.gserviceaccount.com')) {
		console.error(
			'google: GOOGLE_SA_EMAIL is not a service-account address; the calendar cannot be read.'
		);
		return null;
	}

	if (!privateKeyPem.includes('-----BEGIN PRIVATE KEY-----')) {
		console.error('google: GOOGLE_SA_PRIVATE_KEY is not a PKCS#8 PEM private key.');
		return null;
	}

	if (privateKeyPem.length < MIN_PRIVATE_KEY_LENGTH) {
		console.error(
			`google: GOOGLE_SA_PRIVATE_KEY is ${privateKeyPem.length} characters, which is too short ` +
				'to be a real RSA key — this is almost certainly the .dev.vars placeholder.'
		);
		return null;
	}

	return { clientEmail, privateKeyPem };
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

const base64urlText = (text: string) => base64url(encoder.encode(text));

/**
 * PEM → a non-extractable signing key.
 *
 * The `\\n` replacement is not cosmetic. Both `.dev.vars` and
 * `wrangler secret put` carry the key as a single line in which the newlines
 * are literal backslash-n pairs, so the PEM arrives with no real line breaks
 * at all. Without this, the base64 body still decodes (whitespace is stripped
 * either way) but the armour lines run into it and the DER is garbage.
 */
export async function importServiceAccountKey(privateKeyPem: string): Promise<CryptoKey> {
	const pem = privateKeyPem.replaceAll('\\n', '\n');
	const body = pem
		.replace(/-----BEGIN [A-Z ]+-----/, '')
		.replace(/-----END [A-Z ]+-----/, '')
		.replace(/\s+/g, '');

	if (!body) throw new Error('google: the service-account private key has an empty PEM body.');

	let der: Uint8Array<ArrayBuffer>;
	try {
		der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
	} catch {
		// Deliberately does not quote the body.
		throw new Error('google: the service-account private key is not valid base64.');
	}

	return crypto.subtle.importKey(
		'pkcs8',
		der,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign']
	);
}

/** The signed JWT assertion Google trades for an access token. */
export async function signAssertion(
	credentials: ServiceAccountCredentials,
	issuedAtSeconds: number
): Promise<string> {
	const header = base64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
	const claims = base64urlText(
		JSON.stringify({
			iss: credentials.clientEmail,
			scope: CALENDAR_SCOPE,
			aud: TOKEN_ENDPOINT,
			iat: issuedAtSeconds,
			exp: issuedAtSeconds + ASSERTION_LIFETIME_SECONDS
		})
	);

	const signingInput = `${header}.${claims}`;
	const key = await importServiceAccountKey(credentials.privateKeyPem);
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		key,
		encoder.encode(signingInput)
	);

	return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export type MintOptions = {
	/** Injected so the unit tests can count network calls. */
	fetch?: typeof fetch;
	/** Epoch milliseconds. Injected so `iat`/`exp` are assertable. */
	now?: number;
};

/**
 * One round trip to Google's token endpoint. Always mints; the caching is one
 * level up, in `getAccessToken`.
 *
 * Every failure throws. There is no shape of response this returns a token
 * for other than a 2xx carrying a non-empty `access_token` string — an
 * unparseable upstream response refuses, per the default-deny rule.
 */
export async function mintAccessToken(
	credentials: ServiceAccountCredentials,
	options: MintOptions = {}
): Promise<string> {
	const fetchImpl = options.fetch ?? fetch;
	const assertion = await signAssertion(
		credentials,
		Math.floor((options.now ?? Date.now()) / 1000)
	);

	const response = await fetchImpl(TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ grant_type: JWT_GRANT_TYPE, assertion })
	});

	if (!response.ok) {
		// The status only. Google's error bodies echo the assertion back.
		throw new Error(`google: the token endpoint answered ${response.status}.`);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error('google: the token endpoint returned a body that is not JSON.');
	}

	const accessToken = (body as { access_token?: unknown })?.access_token;
	if (typeof accessToken !== 'string' || accessToken.length === 0) {
		throw new Error('google: the token endpoint returned no access_token.');
	}

	return accessToken;
}

/**
 * The Cache API namespace the token lives in.
 *
 * A named cache rather than `caches.default`, which the adapter's own worker
 * uses for page responses — an access token has no business sharing a
 * namespace with anything that could be served. `null` when there is no Cache
 * API at all, which is the case under `vite dev`: `getPlatformProxy` hands
 * back a no-op stub, so local development mints per request and works.
 */
export async function openTokenCache(): Promise<Cache | null> {
	try {
		if (typeof caches?.open !== 'function') return null;
		return await caches.open(TOKEN_CACHE_NAME);
	} catch (cause) {
		console.error('google: no Cache API for the access token; minting per request.', cause);
		return null;
	}
}

export type AccessTokenOptions = MintOptions & {
	credentials: ServiceAccountCredentials;
	/** `null` disables caching, which is what `vite dev` ends up doing. */
	cache?: Cache | null;
};

/**
 * A valid access token, minted at most once every 55 minutes.
 *
 * The freshness is the Cache API's own: the entry carries
 * `Cache-Control: max-age=3300` and the cache stops matching it after that, so
 * there is no expiry arithmetic here to get wrong. Unlike the calendar
 * payloads in `calendar/cache.ts` there is no serve-stale story — an expired
 * credential is worth nothing, so it must simply disappear.
 */
export async function getAccessToken(options: AccessTokenOptions): Promise<string> {
	const { credentials, cache, fetch: fetchImpl, now } = options;
	const key = new Request(TOKEN_CACHE_KEY);

	if (cache) {
		try {
			const hit = await cache.match(key);
			const cached = hit ? (await hit.text()).trim() : '';
			if (cached) return cached;
		} catch (cause) {
			console.error('google: reading the cached access token failed; minting a new one.', cause);
		}
	}

	const token = await mintAccessToken(credentials, { fetch: fetchImpl, now });

	if (cache) {
		try {
			await cache.put(
				key,
				new Response(token, {
					headers: {
						'content-type': 'text/plain; charset=utf-8',
						'cache-control': `max-age=${TOKEN_CACHE_TTL_SECONDS}`
					}
				})
			);
		} catch (cause) {
			// A cache that will not hold the token costs a round trip, not access.
			console.error('google: caching the access token failed.', cause);
		}
	}

	return token;
}
