import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.mjs';

/**
 * The parser reads the block that decides who can see an entry, so every case
 * it cannot read has to stop the publish rather than produce a partial object.
 * These tests are as much about the refusals as the successes.
 */

const CORNWALL = `---
title: Cornwall, July 2026
kind: memory
min_tier: family
status: published
occurred_on: 2026-07-14
cover: beach.jpg
media:
  - file: beach.jpg
    caption: First morning
  - file: cliff-walk.jpg
  - file: surf.mov
    caption: Caden eating sand
    min_tier: partner
---

Markdown body here.
`;

describe('parseFrontmatter', () => {
	it('reads the block from plan §6 exactly as written', () => {
		const { data, body } = parseFrontmatter(CORNWALL);

		expect(data).toEqual({
			title: 'Cornwall, July 2026',
			kind: 'memory',
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
		expect(body).toBe('Markdown body here.\n');
	});

	it('keeps a value containing a colon, which titles routinely do', () => {
		const { data } = parseFrontmatter('---\ntitle: Cornwall: the sequel\n---\n');

		expect(data.title).toBe('Cornwall: the sequel');
	});

	it('strips one layer of quotes and leaves the rest of the value alone', () => {
		const { data } = parseFrontmatter('---\ntitle: "  spaced  "\nsummary: \'#4 of 5\'\n---\n');

		expect(data.title).toBe('  spaced  ');
		expect(data.summary).toBe('#4 of 5');
	});

	it('skips whole-line comments and blank lines', () => {
		const { data } = parseFrontmatter('---\n# a note\n\nkind: memory\n---\n');

		expect(data).toEqual({ kind: 'memory' });
	});

	it('keeps the body verbatim, including its own --- rules', () => {
		const { body } = parseFrontmatter('---\nkind: page\n---\n\nOne\n\n---\n\nTwo\n');

		expect(body).toBe('One\n\n---\n\nTwo\n');
	});

	it('normalises CRLF so a file edited on Windows parses', () => {
		const { data, body } = parseFrontmatter('---\r\nkind: page\r\n---\r\n\r\nBody.\r\n');

		expect(data.kind).toBe('page');
		expect(body).toBe('Body.\n');
	});

	it('handles an empty body', () => {
		expect(parseFrontmatter('---\nkind: page\n---\n').body).toBe('');
	});
});

describe('parseFrontmatter refuses', () => {
	it('a file with no frontmatter block at all', () => {
		expect(() => parseFrontmatter('# Just markdown\n')).toThrow(/must start with/);
	});

	it('a file that only looks like it opens one', () => {
		// A leading blank line is not accommodated: the whole block would
		// otherwise be read as body and the entry published with no title.
		expect(() => parseFrontmatter('\n---\nkind: page\n---\n')).toThrow(/must start with/);
	});

	it('a block that is never closed', () => {
		expect(() => parseFrontmatter('---\nkind: page\n')).toThrow(/never closed/);
	});

	it('a key set twice, rather than silently taking the last one', () => {
		expect(() => parseFrontmatter('---\nmin_tier: family\nmin_tier: public\n---\n')).toThrow(
			/`min_tier` is set twice/
		);
	});

	it('a duplicate key inside one media item', () => {
		const source =
			'---\nmedia:\n  - file: a.jpg\n    min_tier: family\n    min_tier: public\n---\n';

		expect(() => parseFrontmatter(source)).toThrow(/set twice in one item/);
	});

	it('a line that is not `key: value`', () => {
		expect(() => parseFrontmatter('---\njust some words\n---\n')).toThrow(/expected `key: value`/);
	});

	it('a tab used for indentation', () => {
		expect(() => parseFrontmatter('---\nmedia:\n\t- file: a.jpg\n---\n')).toThrow(/tabs/);
	});

	it('an indented line under a key that is not a list', () => {
		expect(() => parseFrontmatter('---\ntitle: x\n  file: a.jpg\n---\n')).toThrow(
			/under a key that is not a list/
		);
	});

	it('an indented line before any `- ` item', () => {
		expect(() => parseFrontmatter('---\nmedia:\n  file: a.jpg\n---\n')).toThrow(
			/expected a `- ` list item/
		);
	});

	it('a list item key with no value', () => {
		expect(() => parseFrontmatter('---\nmedia:\n  - file:\n---\n')).toThrow(/needs a value/);
	});

	it('an unterminated quoted value', () => {
		expect(() => parseFrontmatter('---\ntitle: "unclosed\n---\n')).toThrow(/is not closed/);
	});
});
