import { describe, expect, it } from 'vitest';
import {
	assertOutsideRepo,
	BackupError,
	backupKey,
	backupTimeOf,
	DEFAULT_KEEP,
	MANIFEST_KEY,
	MAX_DELETES_PER_RUN,
	parseManifest,
	selectForDeletion,
	serialiseManifest
} from './retention.mjs';

/**
 * Plan §8.3. `selectForDeletion` is the only function in this repository whose
 * output is a list of things to destroy, and the thing it destroys is the copy
 * of the database you reach for when everything else has gone wrong. Both
 * directions of an off-by-one are expensive: one short and the newest backup
 * is deleted, one long and retention quietly stops meaning anything.
 *
 * Nothing here touches R2. The runner's wrangler plumbing is exercised by
 * hand against local R2 — see the commit message — and is not what a unit test
 * can usefully hold still.
 */

/** `n` keys, one per day, oldest first. */
const keys = (n, from = Date.UTC(2026, 0, 1, 3, 0, 0)) =>
	Array.from({ length: n }, (_, i) => backupKey(from + i * 86_400_000));

describe('backupKey', () => {
	it('names the instant, with no colons in it', () => {
		expect(backupKey(Date.UTC(2026, 7, 13, 21, 8, 8))).toBe(
			'd1/personal-site-2026-08-13T21-08-08Z.sql'
		);
	});

	it('drops milliseconds, so the key is fixed width', () => {
		expect(backupKey(new Date('2026-08-13T21:08:08.910Z'))).toBe(
			'd1/personal-site-2026-08-13T21-08-08Z.sql'
		);
	});

	it('sorts lexicographically in the order it sorts chronologically', () => {
		const chronological = keys(40);
		expect([...chronological].sort()).toEqual(chronological);
	});

	it('refuses an invalid date rather than throwing a bare RangeError', () => {
		// This runs from cron. A `BackupError` is one readable line in the log.
		expect(() => backupKey(new Date('not a date'))).toThrow(BackupError);
	});

	it('round-trips through backupTimeOf', () => {
		const at = Date.UTC(2026, 7, 13, 21, 8, 8);
		expect(backupTimeOf(backupKey(at))).toBe(at);
	});
});

describe('backupTimeOf', () => {
	it('returns null for anything this script did not write', () => {
		for (const key of [
			MANIFEST_KEY,
			'd1/personal-site-2026-08-13.sql', // no time
			'd1/personal-site-2026-08-13T21-08-08Z.sql.bak', // suffixed
			'x/d1/personal-site-2026-08-13T21-08-08Z.sql', // prefixed
			'd1/personal-site-2026-08-13T21:08:08Z.sql', // colons
			'img/01J0000000000000000000/w800.webp',
			''
		]) {
			expect(backupTimeOf(key), key).toBeNull();
		}
	});

	it('rejects a date that does not exist, rather than rolling it forward', () => {
		// `Date.parse('2026-02-31')` is March 3rd. A key that parses to an
		// instant it does not name would sort into the wrong place in the
		// retention window.
		expect(backupTimeOf('d1/personal-site-2026-02-31T00-00-00Z.sql')).toBeNull();
		expect(backupTimeOf('d1/personal-site-2026-13-01T00-00-00Z.sql')).toBeNull();
		expect(backupTimeOf('d1/personal-site-2026-08-13T25-00-00Z.sql')).toBeNull();
	});

	it('accepts the leap day it should', () => {
		expect(backupTimeOf('d1/personal-site-2028-02-29T00-00-00Z.sql')).toBe(
			Date.UTC(2028, 1, 29, 0, 0, 0)
		);
	});
});

describe('selectForDeletion', () => {
	it('deletes nothing while there are exactly `keep` backups', () => {
		// The boundary. One out either way is the bug this file exists for.
		expect(selectForDeletion(keys(DEFAULT_KEEP), { keep: DEFAULT_KEEP })).toEqual([]);
	});

	it('deletes exactly the oldest one at `keep` + 1', () => {
		const all = keys(DEFAULT_KEEP + 1);
		expect(selectForDeletion(all, { keep: DEFAULT_KEEP })).toEqual([all[0]]);
	});

	it('keeps the newest `keep`, whatever order it was handed them in', () => {
		const all = keys(20);
		const doomed = selectForDeletion([...all].reverse(), { keep: 5 });

		expect(doomed).toHaveLength(15);
		expect(doomed).toEqual(all.slice(0, 15));
		for (const kept of all.slice(15)) expect(doomed).not.toContain(kept);
	});

	it('returns them oldest first, so a capped run drops the least useful', () => {
		const doomed = selectForDeletion(keys(80), { keep: 1, max: 3 });
		expect(doomed).toEqual(keys(3));
	});

	it('never deletes more than `max` in one run', () => {
		expect(selectForDeletion(keys(500), { keep: 1 })).toHaveLength(MAX_DELETES_PER_RUN);
	});

	it('ignores keys it does not recognise, and does not count them either', () => {
		// Rule 1: an object this script did not write is not this script's to
		// remove, and must not consume the retention budget either — otherwise a
		// stray file in the bucket would push a real backup out of the window.
		const all = keys(3);
		const doomed = selectForDeletion([...all, MANIFEST_KEY, 'notes.txt', 'd1/'], { keep: 2 });

		expect(doomed).toEqual([all[0]]);
	});

	it('deduplicates, so a key already in the manifest is not deleted twice', () => {
		const all = keys(3);
		expect(selectForDeletion([...all, all[0], all[2]], { keep: 2 })).toEqual([all[0]]);
	});

	it('refuses a keep of zero rather than deleting the backup just taken', () => {
		for (const keep of [0, -1, 1.5, Number.NaN, '14']) {
			expect(() => selectForDeletion(keys(3), { keep }), String(keep)).toThrow(BackupError);
		}
	});

	it('deletes nothing when there is nothing to delete', () => {
		expect(selectForDeletion([], { keep: DEFAULT_KEEP })).toEqual([]);
	});
});

describe('parseManifest', () => {
	it('reads the keys back out', () => {
		expect(parseManifest(serialiseManifest(keys(2)))).toEqual(keys(2).reverse());
	});

	it('orders newest first', () => {
		const [first, second, third] = keys(3);
		expect(parseManifest(serialiseManifest([first, third, second]))).toEqual([
			third,
			second,
			first
		]);
	});

	it('refuses what it cannot read, rather than returning an empty list', () => {
		// An empty list is indistinguishable from a first run, so it would prune
		// nothing and then write a manifest that had forgotten every object
		// already in the bucket — every previous backup orphaned, silently.
		for (const bad of ['', 'null', '[]', '{}', '{"backups": "d1/x"}', '{"backups": [1]}']) {
			expect(() => parseManifest(bad), JSON.stringify(bad)).toThrow(BackupError);
		}
	});
});

describe('assertOutsideRepo', () => {
	it('refuses a dump path inside the working tree', () => {
		// The dump carries live session tokens and the repo is public. Worse
		// than a commit: anything under the tree can be swept into the build
		// output, which Cloudflare serves before the Worker runs (invariant 1).
		for (const path of ['/repo', '/repo/', '/repo/tmp/d1.sql', '/repo/.svelte-kit/x.sql']) {
			expect(() => assertOutsideRepo(path, '/repo'), path).toThrow(BackupError);
		}
	});

	it('allows a path outside it, and hands it back', () => {
		expect(assertOutsideRepo('/tmp/personal-site-backup-a1/d1.sql', '/repo')).toBe(
			'/tmp/personal-site-backup-a1/d1.sql'
		);
	});

	it('is not fooled by a sibling directory sharing the prefix', () => {
		expect(assertOutsideRepo('/repo-backups/d1.sql', '/repo')).toBe('/repo-backups/d1.sql');
	});
});
