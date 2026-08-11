<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/**
	 * Derived from the loader's return type rather than imported from
	 * `$lib/server/media/gallery`: nothing under `$lib/server` may appear in
	 * the module graph of a component, type-only import or not.
	 */
	type GalleryAsset = PageProps['data']['sets'][number]['assets'][number];

	const QUALITIES = ['720', '1080'] as const;

	/**
	 * Every image on this page is a Worker request that re-checks the tier, so
	 * the browser must be given enough information to fetch the *smallest*
	 * sufficient one. These match the grid below: roughly one column on a
	 * phone, two on a tablet, and a fixed 20rem in the widest layout.
	 */
	const SIZES = '(min-width: 64rem) 20rem, (min-width: 40rem) 45vw, 92vw';

	const mediaUrl = (asset: GalleryAsset, variant: string) => `/m/${asset.id}/${variant}`;

	/** Only the variants that were actually uploaded, so nothing 404s. */
	function srcset(asset: GalleryAsset, extension: string): string {
		return asset.variants
			.filter((variant) => variant.name.endsWith(`.${extension}`) && variant.width)
			.sort((a, b) => a.width! - b.width!)
			.map((variant) => `${mediaUrl(asset, variant.name)} ${variant.width}w`)
			.join(', ');
	}

	/** The `<img>` a browser with no `<picture>` support falls back to. */
	function fallback(asset: GalleryAsset): string {
		const webp = asset.variants
			.filter((variant) => variant.name.endsWith('.webp'))
			.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));

		return mediaUrl(asset, (webp.at(-1) ?? asset.variants[0]).name);
	}

	const has = (asset: GalleryAsset, name: string) =>
		asset.variants.some((variant) => variant.name === name);

	function duration(seconds: number | null): string {
		if (!seconds) return '';
		const whole = Math.round(seconds);
		return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
	}

	/**
	 * Which rendition the `<video>` is pointed at. 720p by default because
	 * most of these are watched on a phone and the poster plus
	 * `preload="metadata"` means nothing but the moov atom is fetched until
	 * somebody presses play.
	 */
	let quality = $state<Record<string, (typeof QUALITIES)[number]>>({});
	const qualityOf = (asset: GalleryAsset) => quality[asset.id] ?? '720';
</script>

<svelte:head>
	<title>Photos — Caden</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<article class="stack-page">
	<header class="lede">
		<p class="eyebrow">Private · family and above</p>
		<h1>Photos</h1>
		<p class="lede__summary">
			Every image and clip below is fetched through the Worker, which re-checks your tier on each
			request. Nothing here has a public URL.
		</p>
	</header>

	{#each data.sets as set (set.slug)}
		<section class="set">
			<header class="set__header">
				<h2>{set.title}</h2>
				{#if set.occurredOn}
					<p class="set__date">{set.occurredOn}</p>
				{/if}
				{#if set.summary}
					<p class="set__summary">{set.summary}</p>
				{/if}
			</header>

			<ul class="grid" role="list">
				{#each set.assets as asset (asset.id)}
					<li>
						<figure class="tile">
							<div
								class="tile__frame"
								style:aspect-ratio={asset.width && asset.height
									? `${asset.width} / ${asset.height}`
									: '3 / 2'}
								style:background-image={asset.placeholder ? `url("${asset.placeholder}")` : null}
							>
								{#if asset.kind === 'video'}
									<video
										controls
										preload="metadata"
										poster={mediaUrl(asset, 'poster.jpg')}
										width={asset.width}
										height={asset.height}
										src={mediaUrl(asset, `${qualityOf(asset)}.mp4`)}
									>
										<track kind="captions" />
									</video>
								{:else}
									<picture>
										<source type="image/avif" srcset={srcset(asset, 'avif')} sizes={SIZES} />
										<source type="image/webp" srcset={srcset(asset, 'webp')} sizes={SIZES} />
										<img
											src={fallback(asset)}
											alt={asset.caption ?? ''}
											width={asset.width}
											height={asset.height}
											loading="lazy"
											decoding="async"
										/>
									</picture>
								{/if}
							</div>

							{#if asset.caption || asset.kind === 'video'}
								<figcaption>
									{#if asset.caption}<span>{asset.caption}</span>{/if}
									{#if asset.kind === 'video'}
										<span class="tile__meta">
											{duration(asset.durationS)}
											{#if has(asset, '1080.mp4') && has(asset, '720.mp4')}
												<span class="quality" role="group" aria-label="Video quality">
													{#each QUALITIES as option (option)}
														<button
															type="button"
															aria-pressed={qualityOf(asset) === option}
															onclick={() => (quality = { ...quality, [asset.id]: option })}
														>
															{option}p
														</button>
													{/each}
												</span>
											{/if}
										</span>
									{/if}
								</figcaption>
							{/if}
						</figure>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<p class="prose">No photo sets have been published to your tier yet.</p>
	{/each}

	<p class="signature">Signed in as {data.viewer.email} ({data.viewer.tierSlug}).</p>
</article>

<style>
	.lede {
		max-width: var(--measure);
	}

	.lede__summary {
		margin-block-start: var(--space-sm);
		color: var(--color-ink-muted);
		font-size: var(--text-lg);
	}

	.set__header {
		max-width: var(--measure);
		margin-block-end: var(--space-lg);
	}

	.set__date {
		margin-block-start: var(--space-2xs);
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}

	.set__summary {
		margin-block-start: var(--space-xs);
		color: var(--color-ink-muted);
	}

	.grid {
		display: grid;
		gap: var(--space-lg);
		margin: 0;
		grid-template-columns: repeat(auto-fill, minmax(min(18rem, 100%), 1fr));
	}

	.tile {
		margin: 0;
	}

	/* The blurhash sits here as a background, behind the real image, so there
	   is something in the right colours from the first paint and no reflow
	   when the fetch lands. `cover` on a 20px-wide BMP is the blur. */
	.tile__frame {
		overflow: hidden;
		border: 1px solid var(--color-line);
		border-radius: var(--radius-lg);
		background-color: var(--color-surface-sunken);
		background-position: center;
		background-size: cover;
	}

	.tile__frame :is(img, video) {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	figcaption {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-xs);
		margin-block-start: var(--space-xs);
		color: var(--color-ink-muted);
		font-size: var(--text-sm);
	}

	.tile__meta {
		display: inline-flex;
		align-items: center;
		gap: var(--space-xs);
		color: var(--color-ink-faint);
	}

	.quality {
		display: inline-flex;
		overflow: hidden;
		border: 1px solid var(--color-line-strong);
		border-radius: var(--radius-pill);
	}

	.quality button {
		padding: 0 var(--space-xs);
		border: 0;
		background: none;
		color: var(--color-ink-faint);
		font-size: var(--text-xs);
		cursor: pointer;
	}

	.quality button[aria-pressed='true'] {
		background-color: var(--color-accent-wash);
		color: var(--color-accent);
		font-weight: 600;
	}

	.signature {
		color: var(--color-ink-faint);
		font-size: var(--text-sm);
	}
</style>
