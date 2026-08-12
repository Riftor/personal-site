/**
 * Frontmatter → the row `content_entry` is about to get.
 *
 * This is the file that decides who can see a memory, so it is pure: no fs, no
 * D1, no argv. `entry.spec.mjs` drives every refusal below directly, because
 * "an unknown tier is a hard error" is a claim that has to be testable without
 * a database.
 *
 * The governing rule throughout is plan §3's default-deny, restated for an
 * author: **an unrecognised value is never a default.** `min_tier: freind`,
 * `kind: memry` and `status: publshed` each stop the publish. The alternative
 * — falling back to something — means a typo silently chooses an audience, and
 * the audience is the entire point of this half of the site.
 */
import { fail } from '../lib/d1.mjs';
import { crockfordId } from '../lib/id.mjs';
import { rankOf, TIER_SLUGS } from '../lib/tiers.mjs';

/**
 * `content_entry.id`, derived from the slug so that re-publishing a folder
 * updates the row rather than inserting a second one. Plan §6: the sync is
 * one-directional and keyed on `slug`.
 */
export function entryIdFor(slug) {
	return crockfordId(`entry\u0000${slug}`);
}

/** Mirrors `CONTENT_KINDS` in `src/lib/server/db/schema.ts`. */
export const CONTENT_KINDS = ['page', 'project', 'memory', 'photoset', 'activity'];

/** Mirrors `CONTENT_STATUSES`. */
export const CONTENT_STATUSES = ['draft', 'published'];

/**
 * The kinds whose whole purpose is that other people are in them. Publishing
 * one of these to `public` prompts; see `requiresPublicConfirmation`.
 */
export const PEOPLE_KINDS = ['memory', 'photoset'];

/** Every key the frontmatter may carry. Anything else is a typo. */
const ENTRY_KEYS = [
	'title',
	'kind',
	'slug',
	'summary',
	'min_tier',
	'status',
	'occurred_on',
	'cover',
	'sort_key',
	'media'
];

const MEDIA_KEYS = ['file', 'caption', 'min_tier'];

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A filename and not a path: no separators, no `..`, no leading dot. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireString(data, key, { required = false } = {}) {
	const value = data[key];
	if (value === undefined) {
		if (required) fail(`\`${key}\` is required in the frontmatter.`);
		return null;
	}
	if (typeof value !== 'string') fail(`\`${key}\` must be a single value, not a list.`);

	const text = value.trim();
	if (text === '') {
		if (required) fail(`\`${key}\` is empty.`);
		return null;
	}
	return text;
}

/**
 * A tier slug and its rank, or a hard error.
 *
 * `where` names the thing being published so the message is actionable — the
 * per-asset overrides all fail through here too, and "unknown tier" with no
 * filename is a bad message when a folder holds nine photos.
 */
function requireTierRank(slug, where) {
	const rank = rankOf(slug);
	if (rank === null) {
		fail(`${where}: "${slug}" is not a tier. One of: ${TIER_SLUGS.join(', ')}.`);
	}
	return rank;
}

/** A real calendar date, not merely a well-shaped one. `2026-02-31` fails. */
function requireIsoDate(value, key) {
	if (!ISO_DATE.test(value))
		fail(`\`${key}\` must be an ISO date, \`YYYY-MM-DD\`. Got "${value}".`);

	const date = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
		fail(`\`${key}\` is not a real date: "${value}".`);
	}
	return value;
}

function rejectUnknownKeys(data, allowed, where) {
	for (const key of Object.keys(data)) {
		if (allowed.includes(key)) continue;

		const near = allowed.find(
			(candidate) => candidate.replaceAll('_', '') === key.replaceAll('_', '')
		);
		fail(
			`${where}: unknown key \`${key}\`${near ? ` — did you mean \`${near}\`?` : ''}. ` +
				`Known keys: ${allowed.join(', ')}.`
		);
	}
}

/**
 * The per-asset overrides.
 *
 * The only direction an override may go is **stricter**. Plan §6's example is
 * `surf.mov` at `partner` inside a `family` memory, and that is the whole use
 * case: one file in a set that not everyone who can read the page should see.
 * A *looser* override — a `friend` photo inside a `family` memory — is refused
 * rather than honoured, and refused rather than quietly ignored:
 *
 *  - Honouring it would mean the entry's `min_tier` no longer describes the
 *    set, so reading the frontmatter would not tell you who can see the photos.
 *  - Ignoring it (which is what the fetch-time `strictestRank` comparison
 *    would do on its own) leaves the author believing something the site does
 *    not do.
 *
 * So it stops here, at the only point where the author is still holding the
 * file and can decide what they actually meant.
 */
function buildMedia(rawList, { entryRank, entryTier, mediaFiles }) {
	if (rawList === undefined) return [];
	if (!Array.isArray(rawList)) fail('`media` must be a list of `- file: name.jpg` items.');

	const media = [];
	const seen = new Set();

	for (const [index, raw] of rawList.entries()) {
		const where = `media item ${index + 1}`;
		rejectUnknownKeys(raw, MEDIA_KEYS, where);

		const file = requireString(raw, 'file', { required: true });
		if (!FILE_NAME.test(file)) {
			fail(`${where}: \`file\` must be a plain filename inside \`media/\`. Got "${file}".`);
		}
		if (seen.has(file)) fail(`${where}: "${file}" is listed twice.`);
		seen.add(file);

		if (!mediaFiles.has(file)) {
			fail(`${where}: \`media/${file}\` does not exist.`);
		}

		const slug = requireString(raw, 'min_tier');
		const rank = slug === null ? entryRank : requireTierRank(slug, `${where} (${file})`);

		if (rank < entryRank) {
			fail(
				`${where}: \`min_tier: ${slug}\` (rank ${rank}) is LOOSER than the entry's ` +
					`\`min_tier: ${entryTier}\` (rank ${entryRank}).\n` +
					`  A per-asset tier may only be stricter. Publishing this would mean the entry's\n` +
					`  own tier no longer describes who can see its media. Raise the entry's tier, or\n` +
					`  move "${file}" into its own entry.`
			);
		}

		media.push({
			file,
			caption: requireString(raw, 'caption'),
			minTier: slug ?? entryTier,
			minTierRank: rank
		});
	}

	return media;
}

/**
 * True when publishing this needs a typed "yes" (plan §6).
 *
 * Only memories and photo sets, because those are the kinds that are about
 * other people. It is not conditioned on any flag, and the caller must not
 * make it one — the failure this exists to prevent is the one where somebody
 * is in a hurry.
 */
export function requiresPublicConfirmation(kind, minTier) {
	return minTier === 'public' && PEOPLE_KINDS.includes(kind);
}

/**
 * Validates one parsed file and returns the entry to publish.
 *
 * `defaultSlug` is the folder or file name; `mediaFiles` is what is actually
 * on disk in `media/`, passed in rather than read here so this stays pure.
 */
export function buildEntrySpec({ data, body, defaultSlug, mediaFiles = new Set() }) {
	rejectUnknownKeys(data, ENTRY_KEYS, 'frontmatter');

	const kind = requireString(data, 'kind', { required: true });
	if (!CONTENT_KINDS.includes(kind)) {
		fail(`\`kind\` must be one of: ${CONTENT_KINDS.join(', ')}. Got "${kind}".`);
	}

	const status = requireString(data, 'status') ?? 'draft';
	if (!CONTENT_STATUSES.includes(status)) {
		fail(`\`status\` must be one of: ${CONTENT_STATUSES.join(', ')}. Got "${status}".`);
	}

	// Absent means owner-only. The schema's column default is the same, and it
	// is the direction a forgotten field has to fail in: "nobody can see my
	// photo" is recoverable and "everybody can" is not.
	const minTier = requireString(data, 'min_tier') ?? 'owner';
	const minTierRank = requireTierRank(minTier, 'frontmatter `min_tier`');

	const slug = requireString(data, 'slug') ?? defaultSlug;
	if (!SLUG.test(slug)) {
		fail(
			`the slug "${slug}" is not usable in a URL. Lowercase letters, digits and hyphens only — ` +
				`rename the folder, or set \`slug:\` in the frontmatter.`
		);
	}

	const occurredOn =
		data.occurred_on === undefined
			? null
			: requireIsoDate(requireString(data, 'occurred_on', { required: true }), 'occurred_on');

	const media = buildMedia(data.media, { entryRank: minTierRank, entryTier: minTier, mediaFiles });

	const cover = requireString(data, 'cover');
	if (cover !== null && !media.some((asset) => asset.file === cover)) {
		fail(`\`cover: ${cover}\` is not in the \`media:\` list.`);
	}

	return {
		slug,
		kind,
		title: requireString(data, 'title', { required: true }),
		summary: requireString(data, 'summary'),
		minTier,
		minTierRank,
		status,
		occurredOn,
		sortKey: requireString(data, 'sort_key'),
		cover,
		bodyMd: body.trim() === '' ? null : body.replace(/\s+$/, ''),
		media
	};
}
