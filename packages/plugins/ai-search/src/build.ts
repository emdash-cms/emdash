import type { PluginContext } from "emdash";

import { isSavedConfig } from "./config.js";
import type { Indexer, SyncResult } from "./indexer.js";
import { updateKv } from "./kv.js";
import type { AiSearchProvider } from "./ports/ai-search.js";
import { clearSynced, queueRetries } from "./retry.js";

/** Key of the build state in `ctx.kv`, and name of the cron task that advances it. */
const BUILD = "build";

/** Key in `ctx.kv` of the summary of the last build that finished. */
const LAST_BUILD = "last-build";

/** How long a runner may hold the build before another may take over. Longer than any run. */
const LEASE_MS = 60_000;

/** How long to stop uploading after AI Search rate-limits the build. */
const RATE_LIMIT_PAUSE_MS = 10_000;

/** How long to stop after a rate limit when Cloudflare also rejects the token, until someone replaces it. */
const REJECTED_TOKEN_PAUSE_MS = 5 * 60_000;

/**
 * Cloudflare API requests a build may make per window through the REST API:
 * half of each token's 1,200 per 5 minutes, leaving the rest to search and the admin.
 */
const REST_REQUESTS_PER_WINDOW = 600;
const REST_WINDOW_MS = 5 * 60_000;

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
	/** Cloudflare API requests made since `since`, counted for a build through the REST API. */
	requests?: { since: number; count: number };
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

type BuildIndexer = Pick<Indexer, "config" | "snapshotPage" | "syncPage" | "sweepPage" | "forget">;

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
	await scheduleBuild(ctx);
}

const scheduleBuild = (ctx: BuildContext) => ctx.cron?.schedule(BUILD, { schedule: "* * * * *" });

/**
 * Advances the build page by page until `budgetMs` has passed. Returns the
 * remaining build, or null once it has finished. Does nothing while another
 * runner holds the lease or the build is paused, and stops once the settings
 * the indexer was made with are no longer the saved ones. Through the REST
 * API, pauses once the build has made its share of the token's requests.
 */
export async function runBuild(
	ctx: BuildContext,
	indexer: BuildIndexer,
	budgetMs: number,
	provider?: Pick<AiSearchProvider, "kind" | "tokenRejected" | "requests" | "limitRequests">,
): Promise<BuildState | null> {
	const paced = provider?.kind === "rest";
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
	let accountedRequests = provider?.requests ?? 0;
	try {
		while (build.sources[0] && Date.now() < deadline) {
			if (!(await isSavedConfig(ctx, indexer.config))) break;
			const window = requestWindow(build.requests);
			if (paced && window.count >= REST_REQUESTS_PER_WINDOW) {
				await updateBuild(ctx, (current) =>
					holds(current) ? { ...current, pausedUntil: window.since + REST_WINDOW_MS } : undefined,
				);
				break;
			}
			if (paced) provider.limitRequests?.(REST_REQUESTS_PER_WINDOW - window.count);
			const source = build.sources[0];
			const pageStartedAt = Date.now();
			const { page, next } = await advance(indexer, source, build.step);
			// A rate-limited page is retried whole once the pause is over, so nothing from it is counted.
			if (!page.backOff) {
				await clearSynced(
					ctx,
					page.synced.map((record) => ({ source, id: record })),
					pageStartedAt,
				);
				await queueRetries(
					ctx,
					page.failures.map((failure) => ({ source, ...failure })),
				);
				await indexer.forget(
					source,
					page.failures.map((failure) => failure.id),
				);
			}
			const exhausted = () =>
				paced &&
				window.count + (provider.requests ?? 0) - accountedRequests >= REST_REQUESTS_PER_WINDOW;
			const pause =
				page.backOff && !exhausted() && (await provider?.tokenRejected?.())
					? REJECTED_TOKEN_PAUSE_MS
					: RATE_LIMIT_PAUSE_MS;
			const pausedUntil = exhausted() ? window.since + REST_WINDOW_MS : Date.now() + pause;
			const spent = (provider?.requests ?? 0) - accountedRequests;
			const advanced = await updateBuild(ctx, (current) => {
				if (!holds(current)) return undefined;
				const { since, count } = requestWindow(current.requests);
				const requests = paced ? { since, count: count + spent } : undefined;
				if (page.backOff) return { ...current, requests, pausedUntil };
				return {
					...current,
					requests,
					...(next ? { step: next } : { sources: current.sources.slice(1), step: FIRST_STEP }),
					processed: current.processed + page.synced.length,
					uploaded: current.uploaded + page.uploaded,
					failed: current.failed + page.failures.length,
				};
			});
			accountedRequests = provider?.requests ?? 0;
			if (!advanced || page.backOff) break;
			build = advanced;
		}
	} finally {
		if (paced) provider.limitRequests?.(Infinity);
		let finished: BuildState | undefined;
		const released = await updateBuild(ctx, (current) => {
			if (!holds(current)) return undefined;
			if (current.sources.length === 0) {
				finished = current;
				return null;
			}
			const { lease: _lease, ...rest } = current;
			const spent = (provider?.requests ?? 0) - accountedRequests;
			const { since, count } = requestWindow(current.requests);
			return paced && spent > 0 ? { ...rest, requests: { since, count: count + spent } } : rest;
		});
		if (released === null) {
			await ctx.kv.set(LAST_BUILD, {
				uploaded: finished?.uploaded ?? 0,
				finishedAt: Date.now(),
			} satisfies LastBuild);
			await ctx.cron?.cancel(BUILD);
			// A build started since the release scheduled the task this just cancelled.
			if (await getBuild(ctx)) await scheduleBuild(ctx);
		}
	}
	return getBuild(ctx);
}

/** The current window of REST requests, starting a new one once the last has passed. */
function requestWindow(requests: BuildState["requests"]): { since: number; count: number } {
	const now = Date.now();
	return requests && now - requests.since < REST_WINDOW_MS ? requests : { since: now, count: 0 };
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
