import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.mjs';

/**
 * `body_html` goes through `{@html}` in the private templates, so the first
 * block of tests below is the security one and the rest is the feature.
 *
 * The escaping assertions are written to fail loudly if the escape-first order
 * is ever reversed: each one feeds in something that would be markup if any
 * rule ran before the escape, and asserts on the absence of the tag rather
 * than on the presence of the entity, because a half-escaping that produced
 * `&lt;script&gt;alert(1)</script>` would pass the weaker check.
 */

describe('renderMarkdown does not let raw HTML through', () => {
	it('escapes a script tag instead of emitting one', () => {
		const html = renderMarkdown('Hello <script>alert(1)</script> there');

		expect(html).not.toContain('<script');
		expect(html).not.toContain('</script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('escapes an inline event handler on an otherwise innocent tag', () => {
		const html = renderMarkdown('<img src=x onerror="alert(1)">');

		expect(html).not.toContain('<img');
		expect(html).not.toContain('onerror="');
	});

	it('escapes an iframe and an object', () => {
		const html = renderMarkdown('<iframe src="https://evil.test"></iframe>\n\n<object></object>');

		expect(html).not.toContain('<iframe');
		expect(html).not.toContain('<object');
	});

	it('escapes markup that only appears after inline rules run', () => {
		// If bold were applied before escaping, this would emit a live tag. The
		// words `onclick="x()"` survive as *text*, which is the point — they are
		// displayed, not attached to anything.
		const html = renderMarkdown('**<b onclick="x()">bold</b>**');

		expect(html).toBe('<p><strong>&lt;b onclick=&quot;x()&quot;&gt;bold&lt;/b&gt;</strong></p>');
	});

	it('escapes markup inside a code span and a fenced block', () => {
		expect(renderMarkdown('`<script>`')).not.toContain('<script>');
		expect(renderMarkdown('```\n<script>alert(1)</script>\n```')).not.toContain('<script>');
	});

	it('escapes a quote so it cannot close the href it is interpolated into', () => {
		const html = renderMarkdown('[label](/a"onmouseover=alert(1))');

		// The quote is already `&quot;` by the time the href is built, so the
		// whole thing stays inside the attribute and no second attribute exists.
		expect(html).toContain('href="/a&quot;onmouseover=alert(1"');
		expect(html).not.toMatch(/<a [^>]*\son\w+\s*=/);
	});

	it('refuses javascript:, data: and protocol-relative link targets', () => {
		for (const target of [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox',
			'//evil.test/x'
		]) {
			const html = renderMarkdown(`[click](${target})`);

			expect(html, target).not.toContain('<a href');
			// The words survive; only the navigation is dropped.
			expect(html, target).toContain('click');
		}
	});

	it('allows http, https, mailto, same-origin paths and fragments', () => {
		expect(renderMarkdown('[a](https://example.com/x)')).toContain(
			'<a href="https://example.com/x">a</a>'
		);
		expect(renderMarkdown('[b](http://example.com)')).toContain(
			'<a href="http://example.com">b</a>'
		);
		expect(renderMarkdown('[c](mailto:someone@example.com)')).toContain('href="mailto:');
		expect(renderMarkdown('[d](/private/photos)')).toContain('<a href="/private/photos">d</a>');
		expect(renderMarkdown('[e](#later)')).toContain('<a href="#later">e</a>');
	});

	it('emits an ampersand in a URL as an entity, which is what makes the attribute valid', () => {
		expect(renderMarkdown('[q](/search?a=1&b=2)')).toContain('href="/search?a=1&amp;b=2"');
	});
});

describe('renderMarkdown blocks', () => {
	it('renders paragraphs, joining wrapped lines', () => {
		expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one two</p>\n<p>three</p>');
	});

	it('renders ATX headings at their own level', () => {
		expect(renderMarkdown('## The one good afternoon')).toBe('<h2>The one good afternoon</h2>');
		expect(renderMarkdown('###### deep')).toBe('<h6>deep</h6>');
		// Seven hashes is not a heading.
		expect(renderMarkdown('####### too deep')).toContain('<p>');
	});

	it('renders unordered and ordered lists, and does not merge the two', () => {
		expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
		expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
		expect(renderMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul>\n<ol><li>b</li></ol>');
	});

	it('continues a list item across an indented line', () => {
		expect(renderMarkdown('- first\n  still first\n- second')).toBe(
			'<ul><li>first still first</li><li>second</li></ul>'
		);
	});

	it('renders a blockquote, including one with several paragraphs', () => {
		expect(renderMarkdown('> Never turn your back on the sea.')).toBe(
			'<blockquote><p>Never turn your back on the sea.</p></blockquote>'
		);
		expect(renderMarkdown('> one\n>\n> two')).toBe(
			'<blockquote><p>one</p>\n<p>two</p></blockquote>'
		);
	});

	it('renders a fenced code block and keeps its language', () => {
		expect(renderMarkdown('```js\nconst a = 1;\n```')).toBe(
			'<pre><code class="language-js">const a = 1;\n</code></pre>'
		);
		expect(renderMarkdown('```\nplain\n```')).toBe('<pre><code>plain\n</code></pre>');
	});

	it('renders a horizontal rule rather than reading --- as a list', () => {
		expect(renderMarkdown('a\n\n---\n\nb')).toBe('<p>a</p>\n<hr />\n<p>b</p>');
	});

	it('returns an empty string for an empty or whitespace-only body', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown('   \n\n  ')).toBe('');
		expect(renderMarkdown(null)).toBe('');
	});
});

describe('renderMarkdown inline', () => {
	it('renders bold, italic and code', () => {
		expect(renderMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
		expect(renderMarkdown('*italic*')).toBe('<p><em>italic</em></p>');
		expect(renderMarkdown('_italic_')).toBe('<p><em>italic</em></p>');
		expect(renderMarkdown('`code`')).toBe('<p><code>code</code></p>');
	});

	it('leaves markup inside a code span literal', () => {
		expect(renderMarkdown('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
		expect(renderMarkdown('`[not a link](/x)`')).toBe('<p><code>[not a link](/x)</code></p>');
	});

	it('leaves a lone asterisk and an underscore inside a word alone', () => {
		expect(renderMarkdown('2 * 3 = 6')).toBe('<p>2 * 3 = 6</p>');
		expect(renderMarkdown('snake_case_name')).toBe('<p>snake_case_name</p>');
	});
});
