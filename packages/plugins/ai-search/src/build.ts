import type { PluginContext } from "emdash";

import type { Indexer, SyncResult } from "./indexer.js";
import { updateKv } from "./kv.js";
import { clearSynced, queueRetries } from "./retry.js";

/** Key of the build state in `ctx.kv`, and name of the cron task that advances it. */
const BUILD = "build";

/** Key in `ctx.kv` of the summary of the last build that finished. */
const LAST_BUILD = "last-build";

/** How long a runner may hold the build before another may take over. Longer than any run. */
const LEASE_MS = 60_000;

/** How long to stop uploading after AI Search rate-limits the build. */
const RATE_LIMIT_PAUSE_MS = 10_000;

/**
 * A resumable pass over every record in a set of sources. Each source reads
 * its existing AI Search items into a snapshot, syncs its records page by page
 * against it, then sweeps the items no record claimed. The admin page runs the
 * build while open; the `build` cron task finishes it otherwise. A lease keeps
 * the two from processing the same page at once.
 */
export interface BuildState {
	/** Every source in this build, in order. */
	all: string[];
	/** Sources still to process. The first one is in progress. */
	sources: string[];
	/** Where the first source is. */
	step: BuildStep;
	processed: number;
	/** Records sent to AI Search. */
	uploaded: number;
	/** Records that could not be synced. They are queued for retry. */
	failed: number;
	lease?: { id: string; until: number };
	/** No runner starts before this time. Set when AI Search rate-limits uploads. */
	pausedUntil?: number;
}

export type BuildStep =
	/** Reading this page of the source's AI Search items into the snapshot. */
	| { phase: "snapshot"; page: number }
	/** Syncing the source's records from this cursor. */
	| { phase: "sync"; cursor?: string }
	/** Syncing the snapshot items no record claimed. */
	| { phase: "sweep" };

const FIRST_STEP: BuildStep = { phase: "snapshot", page: 1 };

type BuildContext = Pick<PluginContext, "kv" | "cron">;

type BuildIndexer = Pick<Indexer, "snapshotPage" | "syncPage" | "sweepPage">;

const updateBuild = (
	ctx: BuildContext,
	change: (build: BuildState | null) => BuildState | null | undefined,
) => updateKv<BuildState>(ctx, BUILD, change);

export async function getBuild(ctx: BuildContext): Promise<BuildState | null> {
	return ctx.kv.get<BuildState>(BUILD);
}

/** How long after a build AI Search's stats may still leave out its uploads. */
const STATS_LAG_MS = 10 * 60_000;

interface LastBuild {
	/** Records the build sent to AI Search. */
	uploaded: number;
	finishedAt: number;
}

/** Records the last build sent to AI Search, if it finished recently enough that its stats may not show them yet. */
export async function recentBuildUploads(ctx: Pick<PluginContext, "kv">): Promise<number> {
	const last = await ctx.kv.get<LastBuild>(LAST_BUILD);
	return last && Date.now() - last.finishedAt < STATS_LAG_MS ? last.uploaded : 0;
}

/** Starts a build, or adds sources to the one already running. */
export async function startBuild(ctx: BuildContext, sources: string[]): Promise<void> {
	if (sources.length === 0) return;
	await updateBuild(ctx, (running) =>
		running
			? {
					...running,
					all: [...new Set([...running.all, ...sources])],
					sources: addSources(running, sources),
				}
			: {
					all: sources,
					sources,
					step: FIRST_STEP,
					processed: 0,
					uploaded: 0,
					failed: 0,
				},
	);
	await ctx.cron?.schedule(BUILD, { schedule: "* * * * *" });
}

/**
 * Advances the build page by page until `budgetMs` has passed. Returns the
 * remaining build, or null once it has finished. Does nothing while another
 * runner holds the lease or the build is paused.
 */
export async function runBuild(
	ctx: BuildContext,
	indexer: BuildIndexer,
	budgetMs: number,
): Promise<BuildState | null> {
	const deadline = Date.now() + budgetMs;
	const id = crypto.randomUUID();
	const claimed = await updateBuild(ctx, (build) => {
		const now = Date.now();
		if (!build || (build.lease && build.lease.until > now) || (build.pausedUntil ?? 0) > now) {
			return undefined;
		}
		const { pausedUntil: _pausedUntil, ...rest } = build;
		return { ...rest, lease: { id, until: now + LEASE_MS } };
	});
	if (!claimed) return getBuild(ctx);

	const holds = (build: BuildState | null): build is BuildState => build?.lease?.id === id;
	let build = claimed;
	try {
		while (build.sources[0] && Date.now() < deadline) {
			const source = build.sources[0];
			const pageStartedAt = Date.now();
			const { page, next } = await advance(indexer, source, build.step);
			// A rate-limited page is retried whole once the pause is over, so nothing from it is counted.
			const advanced = await updateBuild(ctx, (current) => {
				if (!holds(current)) return undefined;
				if (page.backOff) return { ...current, pausedUntil: Date.now() + RATE_LIMIT_PAUSE_MS };
				return {
					...current,
					...(next ? { step: next } : { sources: current.sources.slice(1), step: FIRST_STEP }),
					processed: current.processed + page.synced.length,
					uploaded: current.uploaded + page.uploaded,
					failed: current.failed + page.failures.length,
				};
			});
			if (!advanced || page.backOff) break;
			build = advanced;
			await clearSynced(
				ctx,
				page.synced.map((record) => ({ source, id: record })),
				pageStartedAt,
			);
			await queueRetries(
				ctx,
				page.failures.map((failure) => ({ source, ...failure })),
			);
		}
	} finally {
		let finished: BuildState | undefined;
		const released = await updateBuild(ctx, (current) => {
			if (!holds(current)) return undefined;
			if (current.sources.length === 0) {
				finished = current;
				return null;
			}
			const { lease: _lease, ...rest } = current;
			return rest;
		});
		if (released === null) {
			await ctx.kv.set(LAST_BUILD, {
				uploaded: finished?.uploaded ?? 0,
				finishedAt: Date.now(),
			} satisfies LastBuild);
			await ctx.cron?.cancel(BUILD);
		}
	}
	return getBuild(ctx);
}

const NOTHING_SYNCED: SyncResult = { synced: [], uploaded: 0, failures: [], backOff: false };

/** Runs one page of a source's step. `next` is the following step, or undefined once the source is done. */
async function advance(
	indexer: BuildIndexer,
	source: string,
	step: BuildStep,
): Promise<{ page: SyncResult; next?: BuildStep }> {
	switch (step.phase) {
		case "snapshot": {
			const { next, backOff } = await indexer.snapshotPage(source, step.page);
			return {
				page: { ...NOTHING_SYNCED, backOff },
				next: next ? { phase: "snapshot", page: next } : { phase: "sync" },
			};
		}
		case "sync": {
			const { cursor, ...page } = await indexer.syncPage(source, step.cursor);
			return { page, next: cursor ? { phase: "sync", cursor } : { phase: "sweep" } };
		}
		case "sweep": {
			const { done, ...page } = await indexer.sweepPage(source);
			return { page, next: done ? undefined : step };
		}
	}
}

/**
 * Queues sources not already waiting. A source already in progress is queued
 * again, since the part already processed may predate the change.
 */
function addSources(running: BuildState, sources: string[]): string[] {
	const started = running.step.phase !== "snapshot" || running.step.page !== 1;
	const queued = new Set(started ? running.sources.slice(1) : running.sources);
	return [...running.sources, ...sources.filter((source) => !queued.has(source))];
}
