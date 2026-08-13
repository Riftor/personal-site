import { getDb } from './db';
import { auditLog, type AuditAction } from './db/schema';
import type { Viewer } from './access/viewer';

/**
 * The `audit_log` writes that happen at request time (plan §8.2).
 *
 * `grant` and `revoke` are written by `scripts/access.mjs`, because grants are
 * CLI-only and there is no HTTP path that can write one. This file covers the
 * three that only the running Worker can see: `signin`, `denied`, and
 * `media_fetch_denied`.
 *
 * Three rules shape everything below, and each one is a rule rather than a
 * preference:
 *
 * **1. An audit write must never be able to fail a request.** Logging a denial
 * is not a reason to turn a 403 into a 500, and logging a sign-in is not a
 * reason to fail one. Every write here is wrapped, swallows its own failure to
 * `console.error`, and is handed to `waitUntil` so it is not even on the
 * response's critical path. Nothing in this file is ever consulted by a
 * decision — `accessDecisionFor` never calls it and never will.
 *
 * **2. Truncated IP prefixes only.** The column is called `ip_prefix` because
 * a full address is personal data (plan §8, "Privacy risks"), and this is a
 * privacy control rather than a debugging aid. IPv4 is cut to /24 and IPv6 to
 * /48, and anything that does not parse as one of those is stored as NULL
 * rather than guessed at or stored raw. `CF-Connecting-IP` is a header on an
 * inbound request: it is absent locally, and a malformed or absurd value must
 * land as NULL rather than crash a request or reach the table unparsed.
 *
 * **3. A refusal must not confirm in the log what it refused to confirm in the
 * response.** Private page paths and media asset ids are exactly what the
 * byte-identical 401/403 bodies exist to keep unconfirmable, so no denial row
 * carries either — `target` stays NULL and `detail` carries only the viewer's
 * own tier. The action column already says whether a page or a media byte
 * range was refused, which is the "what kind of thing" the plan asks for. That
 * is why the entry points below are three narrow functions rather than one
 * general one: there is no parameter here that a path could be passed through.
 */

/** Cloudflare's client IP. Absent under `pnpm dev` and `pnpm preview`. */
export const CLIENT_IP_HEADER = 'cf-connecting-ip';

/** Longest legal textual IPv6, `xxxx:…:255.255.255.255`. Anything longer is not an address. */
const MAX_IP_LENGTH = 45;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/** The four octets of a dotted quad, or `null` if it is not one. */
function ipv4Octets(value: string): number[] | null {
	const match = IPV4.exec(value);
	if (!match) return null;

	const octets = match.slice(1).map(Number);
	return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * The eight groups of an IPv6 address, `::` expanded, or `null`.
 *
 * `::ffff:203.0.113.4` is handled by folding the trailing dotted quad into two
 * hex groups first — it is a shape a proxy can genuinely emit, and the
 * alternative is treating a real address as unparseable.
 */
function ipv6Groups(value: string): string[] | null {
	let text = value;

	const lastColon = text.lastIndexOf(':');
	if (lastColon === -1) return null;

	const tail = text.slice(lastColon + 1);
	if (tail.includes('.')) {
		const octets = ipv4Octets(tail);
		if (!octets) return null;

		const hex = (high: number, low: number) => ((high << 8) | low).toString(16);
		text = `${text.slice(0, lastColon + 1)}${hex(octets[0], octets[1])}:${hex(octets[2], octets[3])}`;
	}

	const halves = text.split('::');
	if (halves.length > 2) return null;

	const split = (part: string) => (part === '' ? [] : part.split(':'));
	const head = split(halves[0]);
	const rest = halves.length === 2 ? split(halves[1]) : [];

	let groups: string[];
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		groups = head;
	} else {
		const elided = 8 - head.length - rest.length;
		// `::` stands for at least one group, so a full-length address written
		// with one is malformed rather than merely redundant.
		if (elided < 1) return null;
		groups = [...head, ...Array(elided).fill('0'), ...rest];
	}

	return groups.every((group) => IPV6_GROUP.test(group)) ? groups : null;
}

/**
 * A client address reduced to the largest prefix that is not personal data:
 * `/24` for IPv4, `/48` for IPv6. `null` for anything that is not one of
 * those, which includes the absent header every local request has.
 *
 * Untrusted input, treated as such. The length cap comes first so a header
 * carrying a megabyte of text is rejected before any regex sees it.
 */
export function ipPrefix(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;

	const value = raw.trim().toLowerCase();
	if (value.length === 0 || value.length > MAX_IP_LENGTH) return null;

	const octets = ipv4Octets(value);
	if (octets) return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;

	const groups = ipv6Groups(value);
	if (!groups) return null;

	const prefix = groups.slice(0, 3).map((group) => parseInt(group, 16).toString(16));
	return `${prefix.join(':')}::/48`;
}

/** The truncated prefix for one request, from Cloudflare's header. */
export function ipPrefixFrom(headers: Headers | undefined): string | null {
	return ipPrefix(headers?.get(CLIENT_IP_HEADER));
}

export type AuditRow = {
	id: string;
	at: number;
	actor: string | null;
	action: AuditAction;
	target: string | null;
	detail: string | null;
	ipPrefix: string | null;
};

/**
 * Builds the row, with the same second-resolution `at` the CLI's
 * `unixepoch()` writes so the two sources sort together.
 */
export function auditRow(
	action: AuditAction,
	fields: {
		actor?: string | null;
		target?: string | null;
		detail?: Record<string, unknown> | null;
		ipPrefix?: string | null;
	} = {}
): AuditRow {
	return {
		id: crypto.randomUUID(),
		at: Math.floor(Date.now() / 1000),
		actor: fields.actor ?? null,
		action,
		target: fields.target ?? null,
		detail: fields.detail ? JSON.stringify(fields.detail) : null,
		ipPrefix: fields.ipPrefix ?? null
	};
}

/**
 * Inserts the row, and **never rejects**. A missing binding, a D1 outage and a
 * constraint violation are all the same thing here: an audit trail with a hole
 * in it, which is worth a log line and is not worth a failed request.
 */
export async function writeAuditRow(d1: D1Database | undefined, row: AuditRow): Promise<void> {
	if (!d1) {
		console.error(`audit: the D1 binding DB is missing; "${row.action}" was not recorded.`);
		return;
	}

	try {
		await getDb(d1).insert(auditLog).values(row);
	} catch (cause) {
		console.error(`audit: "${row.action}" could not be written.`, cause);
	}
}

/**
 * Writes the row off the response's critical path.
 *
 * `waitUntil` keeps the request from waiting on D1 at all, which matters twice:
 * a refusal must not become slower or more fragile for having been logged, and
 * the Worker must not hold a 403 open while a write retries. Where there is no
 * `ctx` — some local dev shapes — the promise is simply left running; it cannot
 * reject, so an unhandled rejection is not a thing it can produce.
 */
function record(platform: App.Platform | undefined, row: AuditRow): void {
	const written = writeAuditRow(platform?.env?.DB, row);
	platform?.ctx?.waitUntil?.(written);
}

/** A sign-in that produced a session. `actor` is the address Google proved. */
export function recordSignIn(
	platform: App.Platform | undefined,
	headers: Headers | undefined,
	email: string | null
): void {
	record(
		platform,
		auditRow('signin', {
			actor: email,
			detail: { provider: 'google' },
			ipPrefix: ipPrefixFrom(headers)
		})
	);
}

/** Which of the two denial actions a refusal is. */
export type DeniedKind = 'page' | 'media';

const DENIED_ACTION: Readonly<Record<DeniedKind, AuditAction>> = Object.freeze({
	page: 'denied',
	media: 'media_fetch_denied'
});

/**
 * A 403: somebody with a session asked for something their tier does not
 * cover.
 *
 * **Only a signed-in refusal is recorded**, and that is deliberate on two
 * counts. A row whose actor is unknown answers none of the questions this
 * table exists to answer, and `/private/*` is walked by bots constantly — an
 * anonymous 302 to `/signin` is not an access-control event, it is background
 * radiation, and writing a row for each would spend the D1 free tier's daily
 * writes on noise. What is left is exactly "a person who signed in was
 * refused", which is the thing worth reading later.
 *
 * Neither the path nor the asset id is passed in, let alone stored: see rule 3
 * in this file's header.
 */
export function recordDenial(
	platform: App.Platform | undefined,
	headers: Headers | undefined,
	viewer: Viewer | undefined,
	kind: DeniedKind
): void {
	if (!viewer?.signedIn) return;

	record(
		platform,
		auditRow(DENIED_ACTION[kind], {
			actor: viewer.email,
			detail: { tier: viewer.tierSlug, rank: viewer.rank },
			ipPrefix: ipPrefixFrom(headers)
		})
	);
}
