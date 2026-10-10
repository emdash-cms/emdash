import { afterEach, describe, expect, it, vi } from "vitest";

import { getBuild, recentBuildUploads, runBuild, startBuild } from "../src/build.js";
import type { PageResult } from "../src/indexer.js";
import { getRetryQueue, queueRetries } from "../src/retry.js";
import { memoryKv } from "./fakes.js";

/** A source with a single snapshot page and nothing to sweep. */
const snapshotPage = async () => ({ backOff: false });
const sweepPage = async () => ({
	synced: [],
	uploaded: 0,
	failures: [],
	backOff: false,
	done: true,
});

/** Serves one snapshot page and two pages of two records per source, recording the calls it receives. */
function pagedIndexer(pageResult: Partial<PageResult> = {}) {
	const calls: string[] = [];
	return {
		calls,
		snapshotPage: async (source: string, page: number) => {
			calls.push(`${source}:snapshot-${page}`);
			return { backOff: false };
		},
		sweepPage,
		syncPage: async (source: string, cursor: string | undefined): Promise<PageResult> => {
			calls.push(`${source}:${cursor ?? "start"}`);
			return {
				synced: ["a", "b"],
				uploaded: 2,
				failures: [],
				backOff: false,
				cursor: cursor ? undefined : "page-2",
				...pageResult,
			};
		},
	};
}

describe("build", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stops at the budget and resumes where it left off", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);

		const slow = pagedIndexer();
		const slowPages = {
			snapshotPage,
			sweepPage,
			syncPage: async (source: string, cursor: string | undefined) => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return slow.syncPage(source, cursor);
			},
		};

		const paused = await runBuild(ctx, slowPages, 10);
		const resumed = pagedIndexer();
		await runBuild(ctx, resumed, 10_000);

		expect(slow.calls).toEqual(["posts:start"]);
		expect(paused).toMatchObject({
			sources: ["posts"],
			step: { phase: "sync", cursor: "page-2" },
			processed: 2,
		});
		expect(paused?.lease).toBeUndefined();
		expect(resumed.calls).toEqual(["posts:page-2"]);
	});

	it("does not run while another runner holds the build", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		const other = pagedIndexer();
		let release = () => {};
		const blocked = new Promise<void>((resolve) => (release = resolve));
		const busy = {
			snapshotPage,
			sweepPage,
			syncPage: async (source: string, cursor: string | undefined) => {
				await blocked;
				return other.syncPage(source, cursor);
			},
		};
		const first = runBuild(ctx, busy, 10_000);
		await new Promise((resolve) => setTimeout(resolve, 0));

		const second = pagedIndexer();
		const seen = await runBuild(ctx, second, 10_000);
		release();
		await first;

		expect(second.calls).toEqual([]);
		expect(seen?.lease).toBeDefined();
	});

	it("takes over a build whose runner stopped without releasing it", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		const build = await getBuild(ctx);
		await ctx.kv.set("build", { ...build, lease: { id: "gone", until: Date.now() - 1 } });

		const indexer = pagedIndexer();
		await runBuild(ctx, indexer, 10_000);

		expect(indexer.calls).toEqual(["posts:snapshot-1", "posts:start", "posts:page-2"]);
	});

	it("counts failed records, queues them for retry, and finishes the build anyway", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		const seen: Array<{ processed?: number; failed?: number }> = [];
		const indexer = {
			snapshotPage,
			sweepPage,
			syncPage: async (_source: string, cursor: string | undefined): Promise<PageResult> => {
				const build = await getBuild(ctx);
				seen.push({ processed: build?.processed, failed: build?.failed });
				return {
					synced: ["ok"],
					uploaded: 1,
					failures: [{ id: `failed-${cursor ?? "start"}`, error: "internal_error" }],
					backOff: false,
					cursor: cursor ? undefined : "page-2",
				};
			},
		};

		const remaining = await runBuild(ctx, indexer, 10_000);

		expect(seen).toEqual([
			{ processed: 0, failed: 0 },
			{ processed: 1, failed: 1 },
		]);
		expect(remaining).toBeNull();
		expect((await getRetryQueue(ctx)).items.map((item) => `${item.source}/${item.id}`)).toEqual([
			"posts/failed-start",
			"posts/failed-page-2",
		]);
	});

	it("clears queued failures for the records it syncs, including those no longer retried", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const ctx = { kv: memoryKv() };
		const failure = { source: "posts", error: "internal_error" };
		for (let attempt = 0; attempt < 5; attempt++) {
			await queueRetries(ctx, [{ ...failure, id: "a" }]);
		}
		await queueRetries(ctx, [
			{ ...failure, id: "unvisited" },
			{ source: "pages", id: "a", error: "internal_error" },
		]);
		await startBuild(ctx, ["posts"]);
		vi.advanceTimersByTime(1000);

		await runBuild(ctx, pagedIndexer(), 10_000);

		expect((await getRetryQueue(ctx)).items.map((item) => `${item.source}/${item.id}`)).toEqual([
			"posts/unvisited",
			"pages/a",
		]);
	});

	it("keeps a failure queued while the build was syncing the same record", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		const indexer = {
			snapshotPage,
			sweepPage,
			syncPage: async (): Promise<PageResult> => {
				await queueRetries(ctx, [{ source: "posts", id: "a", error: "internal_error" }]);
				return { synced: ["a"], uploaded: 1, failures: [], backOff: false };
			},
		};

		await runBuild(ctx, indexer, 10_000);

		expect((await getRetryQueue(ctx)).items.map((item) => item.id)).toEqual(["a"]);
	});

	it("remembers how many records the finished build uploaded, for a while", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts", "pages"]);

		await runBuild(ctx, pagedIndexer({ uploaded: 1 }), 10_000);
		const justAfter = await recentBuildUploads(ctx);
		vi.advanceTimersByTime(60 * 60_000);

		expect(await getBuild(ctx)).toBeNull();
		expect(justAfter).toBe(4);
		expect(await recentBuildUploads(ctx)).toBe(0);
	});

	it("adds sources to a running build, queueing the one in progress again", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		const indexer = {
			calls: 0,
			snapshotPage,
			sweepPage,
			syncPage: async (): Promise<PageResult> => {
				if (indexer.calls++ === 0) {
					await startBuild(ctx, ["posts", "pages"]);
					return {
						synced: ["a", "b"],
						uploaded: 2,
						failures: [],
						backOff: false,
						cursor: "page-2",
					};
				}
				return { synced: ["a", "b"], uploaded: 2, failures: [], backOff: false };
			},
		};

		await runBuild(ctx, indexer, 10_000);

		expect(indexer.calls).toBe(4);
		expect(await getBuild(ctx)).toBeNull();
	});

	it("pauses on a rate limit and retries the same page once the pause is over", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);

		const paused = await runBuild(ctx, pagedIndexer({ backOff: true }), 10_000);
		const duringPause = pagedIndexer();
		await runBuild(ctx, duringPause, 10_000);
		await ctx.kv.set("build", { ...(await getBuild(ctx)), pausedUntil: Date.now() - 1 });
		const afterPause = pagedIndexer();
		await runBuild(ctx, afterPause, 10_000);

		expect(paused).toMatchObject({ sources: ["posts"], processed: 0 });
		expect(paused?.step).toEqual({ phase: "sync" });
		expect(paused?.pausedUntil).toBeGreaterThan(Date.now());
		expect(duringPause.calls).toEqual([]);
		expect(afterPause.calls).toEqual(["posts:start", "posts:page-2"]);
		expect(await getBuild(ctx)).toBeNull();
	});

	it("reads every snapshot page before syncing, and pauses on a rate limit while reading", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		const calls: string[] = [];
		let limited = true;
		const indexer = {
			snapshotPage: async (_source: string, page: number) => {
				if (page === 2 && limited) {
					limited = false;
					return { backOff: true };
				}
				calls.push(`snapshot-${page}`);
				return { next: page < 3 ? page + 1 : undefined, backOff: false };
			},
			sweepPage,
			syncPage: async (): Promise<PageResult> => {
				calls.push("sync");
				return { synced: ["a"], uploaded: 1, failures: [], backOff: false };
			},
		};

		const paused = await runBuild(ctx, indexer, 10_000);
		await ctx.kv.set("build", { ...paused, pausedUntil: Date.now() - 1 });
		await runBuild(ctx, indexer, 10_000);

		expect(paused).toMatchObject({ step: { phase: "snapshot", page: 2 } });
		expect(paused?.pausedUntil).toBeGreaterThan(Date.now());
		expect(calls).toEqual(["snapshot-1", "snapshot-2", "snapshot-3", "sync"]);
		expect(await getBuild(ctx)).toBeNull();
	});

	it("sweeps a source's unclaimed items before moving on", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts", "pages"]);
		const calls: string[] = [];
		let sweeps = 0;
		const indexer = {
			snapshotPage,
			syncPage: async (source: string): Promise<PageResult> => {
				calls.push(`${source}:sync`);
				return { synced: ["a"], uploaded: 1, failures: [], backOff: false };
			},
			sweepPage: async (source: string) => {
				calls.push(`${source}:sweep`);
				return {
					synced: ["a"],
					uploaded: 0,
					failures: [],
					backOff: false,
					done: source === "pages" || ++sweeps > 1,
				};
			},
		};

		await runBuild(ctx, indexer, 10_000);

		expect(calls).toEqual([
			"posts:sync",
			"posts:sweep",
			"posts:sweep",
			"pages:sync",
			"pages:sweep",
		]);
	});

	it("does not queue a source again when it has not started yet", async () => {
		const ctx = { kv: memoryKv() };
		await startBuild(ctx, ["posts"]);
		await startBuild(ctx, ["posts", "pages"]);

		expect((await getBuild(ctx))?.sources).toEqual(["posts", "pages"]);
	});
});
