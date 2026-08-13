import { describe, expect, it } from 'vitest';
import {
	AccessError,
	countSessionsFor,
	deleteSessionsFor,
	revokeStatements,
	sqlString
} from './access-sql.mjs';

/**
 * Plan §8.1: revocation ends the sessions, not just the grant.
 *
 * The revoked person's *next* request was already refused before this existed
 * — `resolveViewer` re-reads `access_grant` every request and nothing caches
 * the tier — so what these assert is the other half: that the row they are
 * still holding is deleted, that the delete reaches exactly their rows, and
 * that it cannot reach anybody else's. A `WHERE` clause is a cheap thing to
 * get subtly wrong and an expensive thing to get wrong here in either
 * direction: too narrow leaves a revoked person signed in, too wide signs the
 * whole site out.
 */

const EMAIL = 'someone@example.test';

const revoke = (overrides = {}) =>
	revokeStatements({
		email: EMAIL,
		tierSlug: 'family',
		actor: 'cli',
		auditId: '0f9d5a6e-1c2b-4d3e-8f70-a1b2c3d4e5f6',
		...overrides
	});

describe('deleteSessionsFor', () => {
	it('deletes the session rows the address owns', () => {
		const sql = deleteSessionsFor(EMAIL);

		expect(sql).toContain('DELETE FROM session');
		expect(sql).toContain(`lower(email) = '${EMAIL}'`);
	});

	it('scopes the delete through user_id, so it cannot reach anyone else', () => {
		// `session` has no email column. Without the subquery there is no join,
		// and the only ways to write this without one are "delete nothing" and
		// "delete everything".
		expect(deleteSessionsFor(EMAIL)).toMatch(
			/DELETE FROM session WHERE user_id IN \(\s*SELECT id FROM user WHERE lower\(email\) = '[^']+'\s*\);/
		);
	});

	it('matches the address case-insensitively', () => {
		// `access_grant.email` is lowercased by this CLI and `resolveViewer`
		// lowercases the session's address before looking a grant up. A `user`
		// row Google wrote as `Someone@…` is governed by the lowercase grant,
		// so it has to be governed by the lowercase revoke too.
		expect(deleteSessionsFor('Someone@Example.Test')).toContain(
			"lower(email) = 'Someone@Example.Test'"
		);
		expect(deleteSessionsFor(EMAIL)).toContain('lower(email)');
	});

	it('counts exactly the rows it deletes', () => {
		// The CLI prints the count and then runs the delete. Two different
		// predicates would make it print a number that was never true.
		const scope = /WHERE (user_id IN \([\s\S]+?\))/;

		expect(scope.exec(countSessionsFor(EMAIL))?.[1]).toBe(
			scope.exec(deleteSessionsFor(EMAIL))?.[1]
		);
	});
});

describe('revokeStatements', () => {
	it('revokes the grant, ends the sessions, and writes the audit row', () => {
		const sql = revoke();

		expect(sql).toContain('UPDATE access_grant SET revoked_at = unixepoch()');
		expect(sql).toContain('DELETE FROM session');
		expect(sql).toContain("'revoke'");
	});

	it('revokes before it deletes', () => {
		// If the batch dies part way through, the grant should already be gone:
		// that leaves the pre-8.1 behaviour, which refuses the next request
		// anyway. The other order would leave somebody signed out but still
		// granted, which fixes nothing and looks like it did.
		const sql = revoke();

		expect(sql.indexOf('UPDATE access_grant')).toBeLessThan(sql.indexOf('DELETE FROM session'));
	});

	it('only touches the row that is still active', () => {
		// Re-revoking must not move `revoked_at` forward on a row that was
		// revoked last year.
		expect(revoke()).toContain('AND revoked_at IS NULL;');
	});

	it('records no IP for a revocation, because there is no request', () => {
		// `ip_prefix` is for request-time actions. Caden at a terminal has no
		// client address worth recording, truncated or otherwise.
		expect(revoke()).toMatch(/json_object\('tier', '[a-z]+'\), NULL\);$/);
	});

	it('carries the tier that was held, so the log says what was lost', () => {
		expect(revoke({ tierSlug: 'partner' })).toContain("json_object('tier', 'partner')");
	});
});

describe('sqlString', () => {
	it('doubles a quote rather than escaping it', () => {
		expect(sqlString("o'brien@example.test")).toBe("'o''brien@example.test'");
	});

	it('refuses a value it cannot represent, rather than cleaning it up', () => {
		// A backslash or a control character in an address is a mistake worth
		// stopping on. `AccessError` is what the CLI turns into one line.
		for (const bad of ['a\\b@example.test', 'a\nb@example.test', 'a\u007fb@example.test']) {
			expect(() => sqlString(bad), JSON.stringify(bad)).toThrow(AccessError);
		}
	});

	it('refuses inside the statement builders too, not just on its own', () => {
		expect(() => deleteSessionsFor('a\\b@example.test')).toThrow(AccessError);
		expect(() => revoke({ actor: 'a\nb' })).toThrow(AccessError);
	});
});
