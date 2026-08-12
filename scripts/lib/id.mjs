import { createHash } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A 26-character Crockford base32 id — the ULID shape `isAssetId` in
 * `src/lib/server/media/assets.ts` validates, and the shape `content_entry.id`
 * already uses.
 *
 * *Derived* from a seed rather than random, and that is the whole idempotency
 * story for both publish CLIs: re-publishing a folder lands on the same ids,
 * so an edited photo keeps its URL and an edited memory updates in place
 * instead of appearing twice. The trade is that these are not time-sortable
 * the way a real ULID is — ordering comes from `position` and `occurred_on`,
 * which are explicit, so nothing depended on that anyway.
 *
 * A digest, not the inputs, so an id still leaks nothing: the filename and the
 * folder it came from are not recoverable from it.
 */
export function crockfordId(seed) {
	const digest = createHash('sha256').update(seed).digest();

	let id = '';
	for (let i = 0; i < 26; i += 1) id += CROCKFORD[digest[i] % 32];
	return id;
}
