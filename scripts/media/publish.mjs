#!/usr/bin/env node
/**
 * Transcodes source media, uploads the objects to R2, and upserts the
 * `media_asset` / `media_variant` rows that make them reachable.
 *
 *   pnpm media:publish <entry-slug> <file...> [--min-tier <slug>] [--dry-run] [--force] [--remote]
 *
 * This is the M4 half of the publish CLI plan §6 describes: the media half. It
 * requires the entry to exist already and refuses if it does not, rather than
 * inventing one at a tier nobody chose. The whole-folder command that reads
 * frontmatter, renders markdown and creates the entry is M6's
 * `scripts/content/publish.mjs`; both drive the same pipeline in
 * `scripts/media/pipeline.mjs`.
 *
 * Local D1 and local R2 unless `--remote` is passed, exactly like
 * `scripts/access.mjs`.
 */
import { fail, query, runCli, sqlString } from '../lib/d1.mjs';
import { rankOf, TIER_SLUGS } from '../lib/tiers.mjs';
import { publishAssets } from './pipeline.mjs';

const USAGE = `Usage:
  pnpm media:publish <entry-slug> <file...> [--min-tier <slug>] [--dry-run] [--force] [--remote]

Tiers: ${TIER_SLUGS.join(', ')}
The entry must already exist in content_entry. Local D1 and R2 unless --remote.`;

function parseArgs(argv) {
	const options = { dryRun: false, force: false, remote: false, minTier: null };
	const positional = [];

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--dry-run') options.dryRun = true;
		else if (arg === '--force') options.force = true;
		else if (arg === '--remote') options.remote = true;
		else if (arg === '--min-tier') options.minTier = argv[(i += 1)];
		else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${USAGE}`);
		else positional.push(arg);
	}

	if (positional.length < 2) fail(USAGE);
	if (options.minTier !== null && rankOf(options.minTier) === null) {
		fail(`unknown tier "${options.minTier}". One of: ${TIER_SLUGS.join(', ')}`);
	}

	return { ...options, entrySlug: positional[0], files: positional.slice(1) };
}

async function main() {
	const { entrySlug, files, minTier, dryRun, force, remote } = parseArgs(process.argv.slice(2));

	const [entry] = query(
		`SELECT id, min_tier_rank, status FROM content_entry WHERE slug = ${sqlString(entrySlug)}`,
		remote
	);
	if (!entry) fail(`no content_entry with slug "${entrySlug}". Create the entry first.`);

	const entryRank = Number(entry.min_tier_rank);
	const minTierRank = minTier === null ? entryRank : rankOf(minTier);
	if (minTierRank < entryRank) {
		console.error(
			`media: warning — --min-tier ${minTier} (rank ${minTierRank}) is looser than the entry's ` +
				`rank ${entryRank}. The stricter of the two is enforced at fetch time, so this has no effect.`
		);
	}

	const { uploaded, unchanged } = await publishAssets({
		entry: { id: entry.id, slug: entrySlug },
		files: files.map((path) => ({ path, minTierRank, caption: null })),
		dryRun,
		force,
		remote,
		log: (line) => console.error(`media: ${line}`)
	});

	if (entry.status !== 'published') {
		console.error(
			`media: note — "${entrySlug}" is ${entry.status}, so none of this is servable yet.`
		);
	}

	console.error(
		`media: done. ${uploaded} objects uploaded, ${unchanged} source files unchanged${dryRun ? ' (dry run)' : ''}.`
	);
}

await runCli('media', main);
