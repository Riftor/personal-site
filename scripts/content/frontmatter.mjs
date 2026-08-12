/**
 * The `---` block at the top of a content file.
 *
 * A deliberately small YAML subset rather than a YAML library, for the same
 * reason `scripts/media/jpeg.mjs` rewrites JPEG segments by hand: the input is
 * a fixed handful of keys written by one person, and the whole of YAML — its
 * anchors, its merge keys, its nine ways to write a string, its habit of
 * reading `no` as `false` and `2026-07-14` as a Date — is a large surface
 * whose extra capability this file has no use for. Plan §1 also budgets the
 * dependency list and says additions need a written reason; "so that
 * `title: Cornwall, July 2026` parses" is not one.
 *
 * What is supported, and nothing else:
 *
 *   key: scalar          top-level scalar, quoted or bare
 *   key:                 followed by an indented `- ` list of maps
 *     - subkey: scalar
 *       subkey: scalar
 *   # comment            on its own line
 *
 * Everything outside that is an error rather than a guess. A frontmatter block
 * this parser cannot read is a publish that stops, which is the only safe
 * direction: the fields in here decide who can see the entry.
 */
import { fail } from '../lib/d1.mjs';

const DELIMITER = '---';
const KEY = /^([A-Za-z][A-Za-z0-9_]*):(?:[ \t]+(.*))?$/;

/** Strips one layer of matching quotes, or returns the bare value trimmed. */
function scalar(raw, lineNumber) {
	const value = raw.trim();

	for (const quote of ['"', "'"]) {
		if (!value.startsWith(quote)) continue;

		if (value.length < 2 || !value.endsWith(quote)) {
			fail(`line ${lineNumber}: a ${quote}-quoted value is not closed.`);
		}
		const inner = value.slice(1, -1);
		if (inner.includes(quote)) {
			fail(`line ${lineNumber}: a ${quote} inside a ${quote}-quoted value is not supported.`);
		}
		return inner;
	}

	return value;
}

function parseKeyLine(line, lineNumber) {
	const match = KEY.exec(line);
	if (!match) fail(`line ${lineNumber}: expected \`key: value\`, got \`${line.trim()}\`.`);

	return { key: match[1], raw: match[2] ?? '' };
}

/**
 * Splits a document into its frontmatter object and its markdown body.
 *
 * The block must be the very first thing in the file. A file that opens with a
 * blank line and then `---` is rejected rather than accommodated, because the
 * alternative is a file whose frontmatter is silently read as body text and
 * published at the schema's default-deny rank with no title.
 */
export function parseFrontmatter(source) {
	const text = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
	const lines = text.split('\n');

	if (lines[0]?.trimEnd() !== DELIMITER) {
		fail(`the file must start with a \`${DELIMITER}\` frontmatter block.`);
	}

	const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === DELIMITER);
	if (end === -1) fail(`the \`${DELIMITER}\` frontmatter block is never closed.`);

	const data = {};
	let list = null;
	let item = null;

	for (let i = 1; i < end; i += 1) {
		const line = lines[i];
		const lineNumber = i + 1;

		if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
		if (line.includes('\t')) fail(`line ${lineNumber}: tabs cannot be used to indent YAML.`);

		const indented = line.startsWith(' ');

		if (!indented) {
			const { key, raw } = parseKeyLine(line, lineNumber);
			if (Object.hasOwn(data, key)) fail(`line ${lineNumber}: \`${key}\` is set twice.`);

			if (raw.trim() === '') {
				// An empty value opens a list. There is no support for a nested
				// map, because nothing in plan §6's frontmatter is one.
				list = [];
				item = null;
				data[key] = list;
			} else {
				list = null;
				item = null;
				data[key] = scalar(raw, lineNumber);
			}
			continue;
		}

		if (!list) fail(`line ${lineNumber}: indented line under a key that is not a list.`);

		const content = line.trimStart();

		if (content.startsWith('- ')) {
			item = {};
			list.push(item);
			const { key, raw } = parseKeyLine(content.slice(2).trimStart(), lineNumber);
			if (raw.trim() === '') fail(`line ${lineNumber}: \`${key}\` in a list item needs a value.`);
			item[key] = scalar(raw, lineNumber);
			continue;
		}

		if (!item) fail(`line ${lineNumber}: expected a \`- \` list item.`);

		const { key, raw } = parseKeyLine(content, lineNumber);
		if (Object.hasOwn(item, key)) fail(`line ${lineNumber}: \`${key}\` is set twice in one item.`);
		if (raw.trim() === '') fail(`line ${lineNumber}: \`${key}\` in a list item needs a value.`);
		item[key] = scalar(raw, lineNumber);
	}

	return {
		data,
		body: lines
			.slice(end + 1)
			.join('\n')
			.replace(/^\n+/, '')
	};
}
