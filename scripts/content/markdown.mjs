/**
 * Markdown → `content_entry.body_html`, rendered once at publish time.
 *
 * The private templates put this string through `{@html}`, so this file is a
 * stored-XSS surface if it is wrong. It is written to make that impossible by
 * construction rather than by sanitising afterwards:
 *
 *  1. **The source is HTML-escaped first, before any rule runs.** `&`, `<`,
 *     `>` and `"` become entities in the very first pass, so no later
 *     transformation can be handed a `<` that came from the file. Raw HTML in
 *     a markdown body is therefore *displayed*, not executed — which is the
 *     documented behaviour, not a bug: plan §6 wants markdown, and the
 *     convenience of inline HTML is not worth a script tag in the half of the
 *     site that holds the private photos.
 *  2. **Every tag this emits is written by this file.** There is no path where
 *     an attribute value is interpolated from the source except link `href`s,
 *     and those are checked against a scheme allowlist below — a
 *     `[x](javascript:…)` link renders as plain text.
 *
 * The dialect is small on purpose and documented in `content/README.md`:
 * headings, paragraphs, lists, blockquotes, fenced code, rules, and the four
 * inline forms. No tables, no footnotes, no inline images — images belong in
 * the frontmatter `media:` list, where they get a tier, a caption and a
 * transcode.
 */

/** The four characters that could start a tag or escape an attribute. */
export function escapeHtml(text) {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * Link targets this will render as links. Anything else — `javascript:`,
 * `data:`, `vbscript:`, a bare `//host` — falls through to plain text, so the
 * words survive and the navigation does not.
 */
function safeHref(target) {
	const href = target.trim();
	if (href === '') return null;
	if (/^(https?:|mailto:)/i.test(href)) return href;
	// Same-origin, and not the `//host` form that means another origin.
	if (/^\/(?!\/)/.test(href) || /^#/.test(href)) return href;
	return null;
}

/**
 * Inline rules, applied to already-escaped text.
 *
 * Code spans are pulled out first and reinserted at the end so that `**` and
 * `[` inside backticks stay literal. The placeholder is a private-use
 * character, which cannot appear in the escaped source.
 */
function inline(escaped) {
	// The placeholders are private-use characters. Stripping them from the
	// input first means a body that already contains one cannot be read as a
	// code-span marker and pull a different span into its place.
	const text0 = escaped.replaceAll('\uE000', '').replaceAll('\uE001', '');
	const codes = [];
	let text = text0.replace(/`([^`]+)`/g, (_, code) => {
		codes.push(code);
		return `\uE000${codes.length - 1}\uE001`;
	});

	text = text.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label, target) => {
		const href = safeHref(target);
		return href === null ? whole : `<a href="${href}">${label}</a>`;
	});

	text = text
		.replace(/\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*([^\s*](?:[^*]*[^\s*])?)\*(?![*\w])/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_([^\s_](?:[^_]*[^\s_])?)_(?![_\w])/g, '$1<em>$2</em>');

	return text.replace(/\uE000(\d+)\uE001/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const UNORDERED = /^[-*][ \t]+(.*)$/;
const ORDERED = /^\d+\.[ \t]+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^```[ \t]*([A-Za-z0-9+#-]*)[ \t]*$/;

/**
 * Renders one markdown document.
 *
 * Block structure is decided on the *raw* lines — `#`, `-` and `` ` `` all
 * survive escaping unchanged, so the two passes cannot disagree — and the text
 * of each block is escaped before any inline rule touches it.
 */
export function renderMarkdown(source) {
	if (!source || source.trim() === '') return '';

	const lines = source.replaceAll('\r\n', '\n').split('\n');
	const html = [];

	let paragraph = [];
	let list = null;
	let quote = [];

	const flushParagraph = () => {
		if (paragraph.length === 0) return;
		html.push(`<p>${inline(escapeHtml(paragraph.join('\n')).replaceAll('\n', ' '))}</p>`);
		paragraph = [];
	};

	const flushList = () => {
		if (!list) return;
		const items = list.items.map((item) => `<li>${inline(escapeHtml(item))}</li>`).join('');
		html.push(`<${list.tag}>${items}</${list.tag}>`);
		list = null;
	};

	const flushQuote = () => {
		if (quote.length === 0) return;
		html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
		quote = [];
	};

	const flushAll = () => {
		flushParagraph();
		flushList();
		flushQuote();
	};

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const trimmed = line.trim();

		const fence = FENCE.exec(trimmed);
		if (fence) {
			flushAll();

			const code = [];
			i += 1;
			while (i < lines.length && lines[i].trim() !== '```') {
				code.push(lines[i]);
				i += 1;
			}

			const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
			html.push(`<pre><code${language}>${escapeHtml(code.join('\n'))}\n</code></pre>`);
			continue;
		}

		if (trimmed === '') {
			flushAll();
			continue;
		}

		if (RULE.test(trimmed)) {
			flushAll();
			html.push('<hr />');
			continue;
		}

		const heading = HEADING.exec(trimmed);
		if (heading) {
			flushAll();
			const level = heading[1].length;
			html.push(`<h${level}>${inline(escapeHtml(heading[2].trim()))}</h${level}>`);
			continue;
		}

		if (trimmed.startsWith('>')) {
			flushParagraph();
			flushList();
			quote.push(trimmed.replace(/^>[ \t]?/, ''));
			continue;
		}
		flushQuote();

		const unordered = UNORDERED.exec(trimmed);
		const ordered = ORDERED.exec(trimmed);
		if (unordered || ordered) {
			flushParagraph();

			const tag = unordered ? 'ul' : 'ol';
			if (list && list.tag !== tag) flushList();
			list ??= { tag, items: [] };
			list.items.push((unordered ?? ordered)[1].trim());
			continue;
		}

		// A plain line directly under a list item continues it, rather than
		// silently opening a paragraph inside a `<ul>`.
		if (list && line.startsWith(' ')) {
			list.items[list.items.length - 1] += ` ${trimmed}`;
			continue;
		}

		flushList();
		paragraph.push(trimmed);
	}

	flushAll();
	return html.join('\n');
}
