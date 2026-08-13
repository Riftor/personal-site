import { describe, expect, it, vi } from 'vitest';
import {
	auditRow,
	CLIENT_IP_HEADER,
	ipPrefix,
	ipPrefixFrom,
	recordDenial,
	recordSignIn,
	writeAuditRow,
	type AuditRow
} from './audit';
import type { Viewer } from './access/viewer';

/**
 * `audit_log` is a privacy control before it is a diagnostic. Two properties
 * carry that, and both are asserted here rather than read:
 *
 *  - **no full addresses.** The column is `ip_prefix`, and anything that is
 *    not a /24 or a /48 lands as NULL rather than as itself.
 *  - **no path names and no asset ids.** A 403 for a private page that exists
 *    is byte-identical to one for a page that does not, and a log that
 *    recorded which had been asked for would answer the question the response
 *    refuses to.
 *
 * The third property — that a failed write cannot fail a request — is the one
 * that would otherwise be discovered in production, on the day D1 is slow.
 */

const VIEWER: Viewer = {
	signedIn: true,
	userId: 'user-1',
	email: 'friend@example.test',
	tierSlug: 'friend',
	rank: 10
};

/**
 * Enough of `platform` to reach D1, with the statement and its bound values
 * captured. Asserting on the bound values rather than on a mocked-out helper
 * is what makes "the path is not in the row" a real claim.
 */
function fakePlatform({ failing = false } = {}) {
	const writes: { sql: string; values: unknown[] }[] = [];
	const waited: Promise<unknown>[] = [];

	const DB = {
		prepare: (sql: string) => {
			if (failing) throw new Error('D1_ERROR: no such table: audit_log');

			const write = { sql, values: [] as unknown[] };
			writes.push(write);

			const statement = {
				bind: (...values: unknown[]) => {
					write.values = values;
					return statement;
				},
				run: async () => ({ success: true, results: [], meta: {} }),
				all: async () => ({ success: true, results: [], meta: {} }),
				first: async () => null,
				raw: async () => []
			};

			return statement;
		},
		batch: async () => [],
		exec: async () => ({ count: 0, duration: 0 })
	} as unknown as D1Database;

	const platform = {
		env: { DB },
		ctx: { waitUntil: (promise: Promise<unknown>) => waited.push(promise) }
	} as unknown as App.Platform;

	/** Everything one write put into the database, statement and values alike. */
	const written = async () => {
		await Promise.all(waited);
		return writes.map((write) => `${write.sql} ${write.values.map(String).join(' ')}`).join('\n');
	};

	return { platform, writes, waited, written };
}

const headersWith = (ip: string) => new Headers({ [CLIENT_IP_HEADER]: ip });

/** Silences the `console.error` a deliberately broken write is meant to make. */
const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

describe('ipPrefix', () => {
	it('cuts IPv4 to a /24', () => {
		expect(ipPrefix('203.0.113.47')).toBe('203.0.113.0/24');
		expect(ipPrefix('8.8.8.8')).toBe('8.8.8.0/24');
	});

	it('cuts IPv6 to a /48', () => {
		expect(ipPrefix('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe('2001:db8:85a3::/48');
		expect(ipPrefix('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:85a3::/48');
		expect(ipPrefix('fe80::1')).toBe('fe80:0:0::/48');
		expect(ipPrefix('2001:DB8:85A3::1')).toBe('2001:db8:85a3::/48');
	});

	it('never returns the host part of an address', () => {
		// The whole point of the column. If this ever fails, the table has
		// become a list of people's home addresses.
		expect(ipPrefix('203.0.113.47')).not.toContain('47');
		expect(ipPrefix('2001:db8:85a3:aaaa:bbbb:cccc:dddd:eeee')).toBe('2001:db8:85a3::/48');
	});

	it('is NULL for anything that is not an address', () => {
		// Untrusted input: `CF-Connecting-IP` is a header, absent locally, and
		// a malformed value must not reach the table unparsed.
		const bad: unknown[] = [
			null,
			undefined,
			'',
			'   ',
			'not-an-ip',
			'203.0.113.256',
			'203.0.113',
			'203.0.113.1.1',
			'203.0.113.1, 10.0.0.1', // an XFF-style list, which this header never is
			'2001:db8::1::2', // two elisions
			'2001:db8:85a3:0:0:8a2e:370', // seven groups
			'2001:db8:85a3:0:0:8a2e:370:7334:1', // nine
			'gggg::1',
			'::1/128',
			'<script>alert(1)</script>',
			"'; drop table audit_log; --",
			42,
			{ ip: '203.0.113.1' }
		];

		for (const value of bad) {
			expect(ipPrefix(value), JSON.stringify(value)).toBeNull();
		}
	});

	it('refuses an absurdly long value before it parses anything', () => {
		expect(ipPrefix(`${'2001:'.repeat(1000)}1`)).toBeNull();
	});

	it('reads only Cloudflare’s header, and tolerates its absence', () => {
		expect(ipPrefixFrom(headersWith('203.0.113.9'))).toBe('203.0.113.0/24');
		// `pnpm dev` and `pnpm preview` send nothing of the sort, and a header
		// this site does not trust is not a fallback.
		expect(ipPrefixFrom(new Headers())).toBeNull();
		expect(ipPrefixFrom(new Headers({ 'x-forwarded-for': '203.0.113.9' }))).toBeNull();
		expect(ipPrefixFrom(undefined)).toBeNull();
	});
});

describe('auditRow', () => {
	it('stamps seconds, matching the timestamps the CLI writes', () => {
		const row = auditRow('signin');

		expect(row.at).toBe(Math.floor(Date.now() / 1000));
		expect(row.id).toHaveLength(36);
	});

	it('leaves every optional column NULL rather than empty', () => {
		expect(auditRow('denied')).toMatchObject({
			action: 'denied',
			actor: null,
			target: null,
			detail: null,
			ipPrefix: null
		});
	});

	it('serialises detail as JSON, because the column is text', () => {
		expect(auditRow('signin', { detail: { provider: 'google' } }).detail).toBe(
			'{"provider":"google"}'
		);
	});
});

describe('writeAuditRow', () => {
	const row: AuditRow = {
		id: 'row-1',
		at: 1_760_000_000,
		actor: 'friend@example.test',
		action: 'denied',
		target: null,
		detail: '{"tier":"friend","rank":10}',
		ipPrefix: '203.0.113.0/24'
	};

	it('inserts into audit_log', async () => {
		const { platform, writes } = fakePlatform();

		await writeAuditRow(platform.env.DB, row);

		expect(writes[0]?.sql).toContain('audit_log');
		expect(writes[0]?.values).toContain('203.0.113.0/24');
	});

	// The rule the whole file is built around: logging a denial is not a
	// reason to turn a 403 into a 500.
	it('swallows a failed write rather than rejecting', async () => {
		const error = quiet();
		const { platform } = fakePlatform({ failing: true });

		await expect(writeAuditRow(platform.env.DB, row)).resolves.toBeUndefined();
		expect(error).toHaveBeenCalled();

		error.mockRestore();
	});

	it('swallows a missing binding too', async () => {
		const error = quiet();

		await expect(writeAuditRow(undefined, row)).resolves.toBeUndefined();
		expect(error).toHaveBeenCalled();

		error.mockRestore();
	});
});

describe('recordSignIn', () => {
	it('records the address and a truncated prefix, off the response path', async () => {
		const { platform, waited, written } = fakePlatform();

		recordSignIn(platform, headersWith('203.0.113.9'), 'friend@example.test');

		// `waitUntil`, so a slow D1 does not hold the sign-in redirect open.
		expect(waited).toHaveLength(1);

		const row = await written();
		expect(row).toContain('signin');
		expect(row).toContain('friend@example.test');
		expect(row).toContain('203.0.113.0/24');
		expect(row).not.toContain('203.0.113.9');
	});

	it('writes the row even when the address could not be resolved', async () => {
		// "Somebody signed in and we could not say who" is still a fact worth
		// having, and the alternative is a hole in the trail.
		const { platform, written } = fakePlatform();

		recordSignIn(platform, undefined, null);

		expect(await written()).toContain('signin');
	});

	it('does not throw when there is no platform at all', () => {
		const error = quiet();

		expect(() => recordSignIn(undefined, undefined, null)).not.toThrow();

		error.mockRestore();
	});
});

describe('recordDenial', () => {
	it('writes nothing at all for a request with no session', async () => {
		// `/private/*` is walked by bots constantly. An anonymous 302 to
		// `/signin` is background radiation, not an access-control event, and a
		// row per hit would spend the D1 free tier's daily writes on noise.
		const { platform, waited } = fakePlatform();

		recordDenial(platform, headersWith('203.0.113.9'), undefined, 'page');
		recordDenial(platform, headersWith('203.0.113.9'), { ...VIEWER, signedIn: false }, 'page');

		expect(waited).toHaveLength(0);
	});

	it('records who was refused, at what tier, from roughly where', async () => {
		const { platform, written } = fakePlatform();

		recordDenial(platform, headersWith('198.51.100.200'), VIEWER, 'page');

		const row = await written();
		expect(row).toContain('denied');
		expect(row).toContain('friend@example.test');
		expect(row).toContain('{"tier":"friend","rank":10}');
		expect(row).toContain('198.51.100.0/24');
		expect(row).not.toContain('198.51.100.200');
	});

	it('separates a refused page from a refused byte range', async () => {
		const { platform, written } = fakePlatform();

		recordDenial(platform, undefined, VIEWER, 'media');

		expect(await written()).toContain('media_fetch_denied');
	});

	it('records a signed-in viewer who was never granted anything', async () => {
		// Signed in with no grant is not a pending state; it is the public
		// tier, and it is refused like any other.
		const { platform, written } = fakePlatform();

		recordDenial(platform, undefined, { ...VIEWER, tierSlug: null, rank: 0 }, 'page');

		expect(await written()).toContain('{"tier":null,"rank":0}');
	});

	it('has no parameter a path or an asset id could arrive through', async () => {
		// Structural, and deliberately so. The enumeration guarantee is that a
		// refusal does not confirm what was asked for; the way to stop the log
		// confirming it is to leave it nothing to be told.
		const { platform, written } = fakePlatform();

		recordDenial(platform, headersWith('198.51.100.200'), VIEWER, 'media');

		const row = await written();
		expect(row).not.toContain('/private');
		expect(row).not.toContain('/m/');
	});
});
