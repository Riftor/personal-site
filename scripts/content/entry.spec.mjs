import { describe, expect, it } from 'vitest';
import { buildEntrySpec, entryIdFor, requiresPublicConfirmation } from './entry.mjs';

/**
 * The tier rules, tested directly.
 *
 * Every refusal here is one that must not become a default. `min_tier: freind`
 * has to stop the publish, because the alternative is a typo choosing an
 * audience — which is exactly the failure the whole private half exists to
 * prevent, arriving through the one tool that is trusted to set the field.
 */

const MEDIA = new Set(['beach.jpg', 'cliff-walk.jpg', 'surf.mov']);

const build = (data, options = {}) =>
	buildEntrySpec({
		data: { title: 'Cornwall', kind: 'memory', ...data },
		body: 'Body.',
		defaultSlug: '2026-07-cornwall',
		mediaFiles: MEDIA,
		...options
	});

describe('buildEntrySpec', () => {
	it('builds plan §6’s example, media and all', () => {
		const spec = build({
			min_tier: 'family',
			status: 'published',
			occurred_on: '2026-07-14',
			cover: 'beach.jpg',
			media: [
				{ file: 'beach.jpg', caption: 'First morning' },
				{ file: 'cliff-walk.jpg' },
				{ file: 'surf.mov', caption: 'Caden eating sand', min_tier: 'partner' }
			]
		});

		expect(spec).toMatchObject({
			slug: '2026-07-cornwall',
			kind: 'memory',
			title: 'Cornwall',
			minTier: 'family',
			minTierRank: 20,
			status: 'published',
			occurredOn: '2026-07-14',
			cover: 'beach.jpg'
		});
		expect(spec.media).toEqual([
			{ file: 'beach.jpg', caption: 'First morning', minTier: 'family', minTierRank: 20 },
			{ file: 'cliff-walk.jpg', caption: null, minTier: 'family', minTierRank: 20 },
			{ file: 'surf.mov', caption: 'Caden eating sand', minTier: 'partner', minTierRank: 30 }
		]);
	});

	it('defaults an absent min_tier to owner, not to public', () => {
		const spec = build({});

		expect(spec.minTier).toBe('owner');
		expect(spec.minTierRank).toBe(100);
	});

	it('defaults an absent status to draft', () => {
		expect(build({}).status).toBe('draft');
	});

	it('takes the slug from the folder name, or from the frontmatter when given', () => {
		expect(build({}).slug).toBe('2026-07-cornwall');
		expect(build({ slug: 'cornwall' }).slug).toBe('cornwall');
	});

	it('keeps the body and drops trailing whitespace', () => {
		expect(build({}, { body: 'Body.\n\n\n' }).bodyMd).toBe('Body.');
		expect(build({}, { body: '   \n' }).bodyMd).toBeNull();
	});
});

describe('an unknown value is a hard error, never a default', () => {
	it('refuses an unknown min_tier', () => {
		expect(() => build({ min_tier: 'freind' })).toThrow(/"freind" is not a tier/);
	});

	it('refuses an unknown kind', () => {
		expect(() => build({ kind: 'memry' })).toThrow(/`kind` must be one of/);
	});

	it('refuses an unknown status', () => {
		expect(() => build({ status: 'publshed' })).toThrow(/`status` must be one of/);
	});

	it('refuses an unknown frontmatter key, and guesses at the intended one', () => {
		expect(() => build({ mintier: 'family' })).toThrow(/did you mean `min_tier`/);
		expect(() => build({ wibble: 'x' })).toThrow(/unknown key `wibble`/);
	});

	it('refuses an unknown key inside a media item', () => {
		expect(() => build({ media: [{ file: 'beach.jpg', tier: 'partner' }] })).toThrow(
			/unknown key `tier`/
		);
	});

	it('refuses a missing or empty title', () => {
		expect(() => buildEntrySpec({ data: { kind: 'page' }, body: '', defaultSlug: 'x' })).toThrow(
			/`title` is required/
		);
		expect(() => build({ title: '   ' })).toThrow(/`title` is empty/);
	});

	it('refuses an occurred_on that is not a real date', () => {
		expect(() => build({ occurred_on: '14/07/2026' })).toThrow(/must be an ISO date/);
		expect(() => build({ occurred_on: '2026-02-31' })).toThrow(/not a real date/);
	});

	it('refuses a slug that would not survive a URL', () => {
		expect(() => build({ slug: 'Cornwall Trip' })).toThrow(/not usable in a URL/);
		expect(() => build({ slug: '../../etc' })).toThrow(/not usable in a URL/);
	});
});

describe('a per-asset min_tier may only be stricter', () => {
	it('accepts a stricter one — plan §6’s partner clip in a family memory', () => {
		const spec = build({
			min_tier: 'family',
			media: [{ file: 'surf.mov', min_tier: 'partner' }]
		});

		expect(spec.media[0].minTierRank).toBe(30);
	});

	it('accepts an equal one', () => {
		expect(
			build({ min_tier: 'family', media: [{ file: 'beach.jpg', min_tier: 'family' }] }).media[0]
				.minTierRank
		).toBe(20);
	});

	it('REFUSES a looser one rather than honouring or ignoring it', () => {
		expect(() =>
			build({ min_tier: 'family', media: [{ file: 'beach.jpg', min_tier: 'friend' }] })
		).toThrow(/LOOSER than the entry/);
	});

	it('refuses a public asset inside a family entry', () => {
		expect(() =>
			build({ min_tier: 'family', media: [{ file: 'beach.jpg', min_tier: 'public' }] })
		).toThrow(/LOOSER than the entry/);
	});

	it('refuses an unknown per-asset tier, naming the file', () => {
		expect(() =>
			build({ min_tier: 'family', media: [{ file: 'beach.jpg', min_tier: 'partnr' }] })
		).toThrow(/beach\.jpg.*"partnr" is not a tier/s);
	});
});

describe('media file references', () => {
	it('refuses a file that is not on disk', () => {
		expect(() => build({ media: [{ file: 'missing.jpg' }] })).toThrow(
			/media\/missing\.jpg.*does not exist/
		);
	});

	it('refuses a path rather than a filename, so nothing can traverse out of media/', () => {
		for (const file of ['../secret.jpg', 'sub/dir.jpg', '..', '.hidden.jpg']) {
			expect(() => build({ media: [{ file }] }), file).toThrow(/plain filename/);
		}
	});

	it('refuses the same file listed twice', () => {
		expect(() => build({ media: [{ file: 'beach.jpg' }, { file: 'beach.jpg' }] })).toThrow(
			/listed twice/
		);
	});

	it('refuses a cover that is not in the media list', () => {
		expect(() => build({ cover: 'beach.jpg' })).toThrow(/is not in the `media:` list/);
		expect(() => build({ cover: 'other.jpg', media: [{ file: 'beach.jpg' }] })).toThrow(
			/is not in the `media:` list/
		);
	});
});

describe('requiresPublicConfirmation', () => {
	it('is true for a public memory and a public photo set', () => {
		expect(requiresPublicConfirmation('memory', 'public')).toBe(true);
		expect(requiresPublicConfirmation('photoset', 'public')).toBe(true);
	});

	it('is false for the same kinds at any named tier', () => {
		for (const tier of ['friend', 'family', 'partner', 'owner']) {
			expect(requiresPublicConfirmation('memory', tier), tier).toBe(false);
		}
	});

	it('is false for the portfolio kinds, which are public by design', () => {
		expect(requiresPublicConfirmation('page', 'public')).toBe(false);
		expect(requiresPublicConfirmation('project', 'public')).toBe(false);
		expect(requiresPublicConfirmation('activity', 'public')).toBe(false);
	});
});

describe('entryIdFor', () => {
	it('is stable for a slug, which is what makes re-publishing an update', () => {
		expect(entryIdFor('2026-07-cornwall')).toBe(entryIdFor('2026-07-cornwall'));
	});

	it('is the 26-character Crockford shape the schema uses', () => {
		expect(entryIdFor('2026-07-cornwall')).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
	});

	it('separates two slugs, and leaks neither', () => {
		expect(entryIdFor('cornwall')).not.toBe(entryIdFor('devon'));
		expect(entryIdFor('cornwall').toLowerCase()).not.toContain('cornwall');
	});
});
