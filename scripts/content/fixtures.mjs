#!/usr/bin/env node
/**
 * Fills the `media/` folders under `content/` with synthetic photographs and a
 * clip, so `pnpm run publish` has something to transcode.
 *
 * The markdown under `content/` is committed; the media is not — `.gitignore`
 * covers `content/**\/media` and the repo is public. That is the whole reason
 * this file exists: a folder of real holiday photos cannot live in git, so
 * anyone who clones this gets the frontmatter, the body, and a generator that
 * produces stand-ins of the right shape.
 *
 * They are stand-ins, and that is a decision rather than an omission (see
 * `HANDOFF.md` on DC #6). Caden replaces them by dropping his own files into
 * the same folders and re-running `pnpm run publish`; the content hash moves,
 * and the pipeline re-transcodes exactly those files.
 *
 *   node scripts/content/fixtures.mjs [--force]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/d1.mjs';
import { writeImageFixture, writeVideoFixture } from '../media/fixtures.mjs';

/**
 * Which files each entry folder expects, matching its `media:` frontmatter. A
 * name here that the frontmatter does not list, or the other way round, fails
 * the publish — `entry.mjs` checks both directions.
 */
const FOLDERS = [
	{
		dir: 'content/memories/2026-07-cornwall/media',
		images: ['beach.jpg', 'cliff-walk.jpg'],
		videos: ['surf.mov']
	},
	{
		dir: 'content/photosets/2026-06-family-dinner/media',
		images: ['table.jpg', 'pudding.jpg'],
		videos: []
	}
];

export async function ensureContentFixtures({ force = false } = {}) {
	const written = [];

	for (const [folderIndex, folder] of FOLDERS.entries()) {
		const dir = join(REPO_ROOT, folder.dir);
		mkdirSync(dir, { recursive: true });

		for (const [index, name] of folder.images.entries()) {
			const path = join(dir, name);
			if (!force && existsSync(path)) continue;

			await writeImageFixture(path, folderIndex * 3 + index);
			written.push(path);
		}

		for (const name of folder.videos) {
			const path = join(dir, name);
			if (!force && existsSync(path)) continue;

			writeVideoFixture(path);
			written.push(path);
		}
	}

	return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const written = await ensureContentFixtures({ force: process.argv.includes('--force') });

	console.error(
		written.length === 0
			? 'content fixtures: already present.'
			: written.map((path) => `content fixtures: ${path}`).join('\n')
	);
}
