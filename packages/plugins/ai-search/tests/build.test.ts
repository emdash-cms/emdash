import type { PluginContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBuild, recentBuildUploads, runBuild, startBuild } from "../src/build.js";
import { Indexer, type PageResult } from "../src/indexer.js";
import { getRetryQueue, queueRetries } from "../src/retry.js";
import { FakeItems } from "./fake-ai-search.js";
import { config, entry, fakeEmDash, memoryKv } from "./fakes.js";

const CONFIG = config();

/** A plugin context whose saved settings are `CONFIG`. */
async function buildContext() {
	const kv = memoryKv();
	await kv.set("config", CONFIG);
	return { kv };
}

/** A source with a single snapshot page and nothing to sweep. */
const snapshotPage = async () => ({ backOff: false });
const sweepPage = async () => ({
	synced: [],
	uploaded: 0,
	failures: [],
	backOff: false,
	done: true,
});
const forget = async () => {};

/** Serves one snapshot page and two pages of two records per source, recording the calls it receives. */
function pagedIndexer(pageResult: Partial<PageResult> = {}) {
	const calls: string[] = [];
	return {
		calls,
		config: CONFIG,
		snapshotPage: async (source: string, page: number) => {
			calls.push(`${source}:snapshot-${page}`);
			return { backOff: false };
		},
		sweepPage,
		forget,
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
		vi.useFakeTimers({ toFake: ["Date"] });
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);

		const slow = pagedIndexer();
		const slowPages = {
			config: CONFIG,
			snapshotPage,
			sweepPage,
			forget,
			syncPage: async (source: string, cursor: string | undefined) => {
				vi.advanceTimersByTime(20);
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

	it("stops when the settings change, so the next run builds with the new ones", async () => {
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const changed = config({ labels: { posts: "Articles" } });
		const stale = pagedIndexer();
		const syncPage = stale.syncPage;
		stale.syncPage = async (source, cursor) => {
			await ctx.kv.set("config", changed);
			return syncPage(source, cursor);
		};

		const paused = await runBuild(ctx, stale, 10_000);
		const fresh = { ...pagedIndexer(), config: changed };
		await runBuild(ctx, fresh, 10_000);

		expect(stale.calls).toEqual(["posts:snapshot-1", "posts:start"]);
		expect(paused).toMatchObject({ step: { phase: "sync", cursor: "page-2" } });
		expect(paused?.lease).toBeUndefined();
		expect(fresh.calls).toEqual(["posts:page-2"]);
		expect(await getBuild(ctx)).toBeNull();
	});

	it("does not run while another runner holds the build", async () => {
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const other = pagedIndexer();
		let release = () => {};
		const blocked = new Promise<void>((resolve) => (release = resolve));
		const busy = {
			config: CONFIG,
			snapshotPage,
			sweepPage,
			forget,
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
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const build = await getBuild(ctx);
		await ctx.kv.set("build", { ...build, lease: { id: "gone", until: Date.now() - 1 } });

		const indexer = pagedIndexer();
		await runBuild(ctx, indexer, 10_000);

		expect(indexer.calls).toEqual(["posts:snapshot-1", "posts:start", "posts:page-2"]);
	});

	it("counts failed records, queues them for retry, and finishes the build anyway", async () => {
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const seen: Array<{ processed?: number; failed?: number }> = [];
		const indexer = {
			config: CONFIG,
			snapshotPage,
			sweepPage,
			forget,
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

	it("runs a page again when its failures could not be queued", async () => {
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const compareAndSet = ctx.kv.compareAndSet;
		let queueUnavailable = true;
		ctx.kv.compareAndSet = async (key, expected, value) => {
			if (key === "retry" && queueUnavailable) {
				queueUnavailable = false;
				throw new Error("kv unavailable");
			}
			return compareAndSet(key, expected, value);
		};
		const failures = [{ id: "c", error: "internal_error" }];

		const failing = pagedIndexer({ failures });
		await expect(runBuild(ctx, failing, 10_000)).rejects.toThrow("kv unavailable");
		const resumed = pagedIndexer({ failures });
		await runBuild(ctx, resumed, 10_000);

		expect(failing.calls).toEqual(["posts:snapshot-1", "posts:start"]);
		expect(resumed.calls).toEqual(["posts:start", "posts:page-2"]);
		expect((await getRetryQueue(ctx)).items.map((item) => item.id)).toEqual(["c"]);
	});

	it("removes an unpublished entry when the sweep resumes after its failure could not be queued", async () => {
		const ctx = await buildContext();
		const post = entry();
		const items = new FakeItems();
		const indexer = new Indexer({ ...fakeEmDash({ entries: [post] }), items }, CONFIG);
		await startBuild(ctx, ["posts"]);
		await runBuild(ctx, indexer, 10_000);
		post.status = "draft";
		const remove = items.delete.bind(items);
		items.delete = async () => {
			throw new Error("AiSearchError: internal_error");
		};
		const compareAndSet = ctx.kv.compareAndSet;
		ctx.kv.compareAndSet = async (key, expected, value) => {
			if (key === "retry") throw new Error("kv unavailable");
			return compareAndSet(key, expected, value);
		};

		await startBuild(ctx, ["posts"]);
		await expect(runBuild(ctx, indexer, 10_000)).rejects.toThrow("kv unavailable");
		items.delete = remove;
		ctx.kv.compareAndSet = compareAndSet;
		await runBuild(ctx, indexer, 10_000);

		expect(await getBuild(ctx)).toBeNull();
		expect(items.items.size).toBe(0);
	});

	it("clears queued failures for the records it syncs, including those no longer retried", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const ctx = await buildContext();
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
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const indexer = {
			config: CONFIG,
			snapshotPage,
			sweepPage,
			forget,
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
		const ctx = await buildContext();
		await startBuild(ctx, ["posts", "pages"]);

		await runBuild(ctx, pagedIndexer({ uploaded: 1 }), 10_000);
		const justAfter = await recentBuildUploads(ctx);
		vi.advanceTimersByTime(60 * 60_000);

		expect(await getBuild(ctx)).toBeNull();
		expect(justAfter).toBe(4);
		expect(await recentBuildUploads(ctx)).toBe(0);
	});

	it("adds sources to a running build, queueing the one in progress again", async () => {
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const indexer = {
			config: CONFIG,
			calls: 0,
			snapshotPage,
			sweepPage,
			forget,
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
		const ctx = await buildContext();
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
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		const calls: string[] = [];
		let limited = true;
		const indexer = {
			config: CONFIG,
			snapshotPage: async (_source: string, page: number) => {
				if (page === 2 && limited) {
					limited = false;
					return { backOff: true };
				}
				calls.push(`snapshot-${page}`);
				return { next: page < 3 ? page + 1 : undefined, backOff: false };
			},
			sweepPage,
			forget,
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
		const ctx = await buildContext();
		await startBuild(ctx, ["posts", "pages"]);
		const calls: string[] = [];
		let sweeps = 0;
		const indexer = {
			config: CONFIG,
			snapshotPage,
			forget,
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

	it("keeps the cron task of a build started while the previous one was finishing", async () => {
		const scheduled = new Set<string>();
		let startDuringCancel = true;
		const ctx = {
			...(await buildContext()),
			cron: {
				schedule: async (name: string) => void scheduled.add(name),
				cancel: async (name: string) => {
					if (startDuringCancel) {
						startDuringCancel = false;
						await startBuild(ctx, ["pages"]);
					}
					scheduled.delete(name);
				},
				list: async () => [],
			} satisfies NonNullable<PluginContext["cron"]>,
		};
		await startBuild(ctx, ["posts"]);

		await runBuild(ctx, pagedIndexer(), 10_000);

		expect((await getBuild(ctx))?.sources).toEqual(["pages"]);
		expect(scheduled.has("build")).toBe(true);
	});

	it("does not queue a source again when it has not started yet", async () => {
		const ctx = await buildContext();
		await startBuild(ctx, ["posts"]);
		await startBuild(ctx, ["posts", "pages"]);

		expect((await getBuild(ctx))?.sources).toEqual(["posts", "pages"]);
	});
});
