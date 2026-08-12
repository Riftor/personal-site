import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MediaGrid from './MediaGrid.svelte';

/**
 * The grid the memory and photo-set templates share.
 *
 * The assertions worth having here are the ones e2e cannot reach cheaply: that
 * `srcset` is built from the variant rows rather than a hard-coded width list,
 * so a half-finished publish produces fewer `<source>` entries instead of
 * `<source>` entries that 404.
 */

const image = {
	id: '8TS0CB45B387JXNANJXHC7BZVF',
	kind: 'image' as const,
	width: 2000,
	height: 1333,
	durationS: null,
	caption: 'First morning',
	placeholder: null,
	variants: [
		{ name: 'w400.avif', width: 400, height: 267 },
		{ name: 'w400.webp', width: 400, height: 267 },
		{ name: 'w800.webp', width: 800, height: 533 }
	]
};

const video = {
	id: 'K3TNBXTSRKPFEYJ3CWRDSB39Q9',
	kind: 'video' as const,
	width: 1920,
	height: 1080,
	durationS: 125,
	caption: null,
	placeholder: null,
	variants: [
		{ name: '720.mp4', width: 1280, height: 720 },
		{ name: '1080.mp4', width: 1920, height: 1080 },
		{ name: 'poster.jpg', width: 1920, height: 1080 }
	]
};

describe('MediaGrid.svelte', () => {
	it('builds each srcset from the variants that exist, and nothing else', () => {
		render(MediaGrid, { assets: [image] });

		expect(document.querySelector('source[type="image/avif"]')?.getAttribute('srcset')).toBe(
			`/m/${image.id}/w400.avif 400w`
		);
		expect(document.querySelector('source[type="image/webp"]')?.getAttribute('srcset')).toBe(
			`/m/${image.id}/w400.webp 400w, /m/${image.id}/w800.webp 800w`
		);
		// The `w1600` this asset never got must not be requested.
		expect(document.body.innerHTML).not.toContain('w1600');
	});

	it('falls back to the widest WebP and carries the caption as alt text', async () => {
		render(MediaGrid, { assets: [image] });

		await expect
			.element(page.getByAltText('First morning'))
			.toHaveAttribute('src', `/m/${image.id}/w800.webp`);
	});

	it('reserves the aspect ratio so the grid does not reflow when bytes land', () => {
		render(MediaGrid, { assets: [image] });

		expect(document.querySelector('.tile__frame')?.getAttribute('style')).toContain(
			'aspect-ratio: 2000 / 1333'
		);
	});

	it('points a video at 720p with a poster and metadata-only preload', () => {
		render(MediaGrid, { assets: [video] });

		const element = document.querySelector('video');
		expect(element?.getAttribute('src')).toBe(`/m/${video.id}/720.mp4`);
		expect(element?.getAttribute('poster')).toBe(`/m/${video.id}/poster.jpg`);
		expect(element?.getAttribute('preload')).toBe('metadata');
	});

	it('offers the quality switch only when both renditions were published', async () => {
		render(MediaGrid, { assets: [video] });

		await expect.element(page.getByRole('button', { name: '1080p' })).toBeInTheDocument();
		expect(document.querySelector('figcaption')?.textContent).toContain('2:05');
	});

	it('omits the quality switch when only one rendition exists', () => {
		render(MediaGrid, {
			assets: [{ ...video, variants: video.variants.filter((v) => v.name !== '1080.mp4') }]
		});

		expect(document.querySelector('.quality')).toBeNull();
	});

	it('renders nothing at all for an entry whose media the viewer may not see', () => {
		render(MediaGrid, { assets: [] });

		expect(document.querySelectorAll('figure').length).toBe(0);
	});
});
