import { warmCalendar } from './warm';

/**
 * The Worker's `scheduled` handler (plan §4's Cron Trigger).
 *
 * SvelteKit's Cloudflare adapter generates a worker that exports `fetch` and
 * nothing else, so `scripts/wrap-worker-scheduled.mjs` wraps the generated
 * bundle at the end of `pnpm build` and re-exports this alongside it. The
 * whole handler lives here, in typechecked and tested source, so the generated
 * wrapper stays small enough to read at a glance.
 *
 * Nothing here is on a visitor's path — a cold request reads live. The worst a
 * broken cron can do is make the first visit after 300 s slower.
 */
export async function scheduled(
	controller: ScheduledController,
	env: Env,
	ctx: ExecutionContext
): Promise<void> {
	const warming = warmCalendar({ env, cron: controller.cron });
	// Awaited *and* registered: `waitUntil` is what keeps the invocation alive
	// if this ever grows a path that resolves before its work is finished.
	ctx.waitUntil(warming);
	await warming;
}
