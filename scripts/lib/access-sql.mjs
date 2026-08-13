/**
 * The SQL `scripts/access.mjs` writes for a revocation, and the escaping it is
 * written with.
 *
 * Split out of the CLI because `scripts/access.mjs` dispatches on `argv` the
 * moment it is imported, so nothing in it can be asserted by a test — and
 * revocation has a property that is worth asserting rather than reading:
 * plan §8.1 makes it delete the revoked person's `session` rows, and "exactly
 * theirs, and nobody else's" is the kind of thing a `WHERE` clause gets subtly
 * wrong once and silently thereafter.
 *
 * Only the revoke batch lives here. The grant batch has no equivalent property
 * — it writes one row keyed by a primary key — and moving it would be churn
 * for symmetry's sake.
 */

/** A message the CLI should print as one line and exit 1 on, rather than a stack. */
export class AccessError extends Error {}

/** `unixepoch()`: seconds, matching every other timestamp these tables carry. */
export const NOW_SECONDS = 'unixepoch()';

/**
 * A SQL string literal. Rejects anything it cannot represent rather than
 * trying to clean it up: the inputs here are an email address and a short
 * note, and a value containing a control character or a backslash is a
 * mistake worth stopping on, not worth escaping around.
 */
export function sqlString(value) {
	const text = String(value);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(text)) {
		throw new AccessError(
			`refusing to write a value containing control characters or a backslash: ${text}`
		);
	}
	return `'${text.replaceAll("'", "''")}'`;
}

/**
 * The `session` rows one address owns, as a `WHERE` fragment.
 *
 * Written once and shared by the count and the delete below, so the thing that
 * is reported and the thing that is deleted cannot come to mean different
 * sets. Two details in it:
 *
 *  - It matches on `lower(user.email)`. `access_grant.email` is lowercased by
 *    this CLI and `resolveViewer` lowercases the session's address before
 *    looking a grant up, so a `user` row Google wrote with a capital letter in
 *    it is governed by the lowercase grant. Matching the column as-is would
 *    leave exactly that person signed in.
 *  - It is scoped through `user_id`, so it cannot reach a session belonging to
 *    anybody else. `session` has no email column; the subquery is the join.
 */
const sessionsOwnedBy = (email) => `user_id IN (
	SELECT id FROM user WHERE lower(email) = ${sqlString(email)}
)`;

/** How many sessions a revoke is about to end, for the CLI to report. */
export function countSessionsFor(email) {
	return `SELECT count(*) AS n FROM session WHERE ${sessionsOwnedBy(email)};`;
}

/**
 * Ends every live session belonging to a revoked address (plan §8.1).
 *
 * Without this, revocation was *effective* but not *complete*. `resolveViewer`
 * re-reads `access_grant` on every request and nothing caches the tier, so a
 * revoked person's next request already resolves to public — but their
 * `session` row survived, so they stayed signed in, and the only evidence of
 * the revocation was a 403 on the pages that had worked a second earlier.
 * Deleting the rows forces a re-auth, and makes the state in the database
 * match the sentence "they no longer have access".
 */
export function deleteSessionsFor(email) {
	return `DELETE FROM session WHERE ${sessionsOwnedBy(email)};`;
}

/**
 * The whole revocation, as one batch.
 *
 * The order is deliberate. The `UPDATE` lands first, because it is the half
 * that actually removes access — if the batch dies part way through, the grant
 * is revoked and the worst outcome is a session that outlives it by one
 * request, which is the behaviour this task started from. The audit row is
 * last, and carries the tier that was held rather than the address's sessions:
 * `ip_prefix` is NULL because there is no request here, only Caden at a
 * terminal.
 */
export function revokeStatements({ email, tierSlug, actor, auditId }) {
	return `UPDATE access_grant SET revoked_at = ${NOW_SECONDS}
WHERE email = ${sqlString(email)} AND revoked_at IS NULL;
${deleteSessionsFor(email)}
INSERT INTO audit_log (id, at, actor, action, target, detail, ip_prefix)
VALUES (${sqlString(auditId)}, ${NOW_SECONDS}, ${sqlString(actor)}, 'revoke', ${sqlString(email)},
	json_object('tier', ${sqlString(tierSlug)}), NULL);`;
}
