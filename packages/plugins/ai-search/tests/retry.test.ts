import type { PluginContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Indexer } from "../src/indexer.js";
import { finishSync, getRetryQueue, queueRetries, retryRecord, runRetries } from "../src/retry.js";
import { FakeItems } from "./fake-ai-search.js";
import { config, entry, fakeEmDash, memoryKv } from "./fakes.js";

const MINUTE = 60_000;

/** Cron access that tracks which tasks are scheduled. */
function fakeCron() {
	const scheduled = new Set<string>();
	const cron: NonNullable<PluginContext["cron"]> = {
		schedule: async (name) => void scheduled.add(name),
		cancel: async (name) => void scheduled.delete(name),
		list: async () => [],
	};
	return { cron, scheduled };
}

/** A post whose failures can be queued, with the indexer's settings saved. */
async function setup() {
	const post = entry();
	const items = new FakeItems();
	const indexer = new Indexer({ ...fakeEmDash({ entries: [post] }), items }, config());
	const { cron, scheduled } = fakeCron();
	const kv = memoryKv();
	await kv.set("config", indexer.config);
	return { ctx: { kv, cron }, scheduled, items, indexer, post };
}

describe("retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits longer after each failure and stops retrying automatically after five", async () => {
		vi.useFakeTimers();
		const { ctx, scheduled, items, indexer, post } = await setup();
		items.failKeys.add("posts/entry-1.md");
		await queueRetries(ctx, [{ source: "posts", id: post.id, error: "internal_error" }]);

		const delays: number[] = [];
		for (let attempt = 0; attempt < 4; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- each attempt depends on the last
			const [queued] = (await getRetryQueue(ctx)).items;
			delays.push((queued?.nextAt ?? 0) - Date.now());
			vi.setSystemTime(queued?.nextAt ?? 0);
			// oxlint-disable-next-line no-await-in-loop -- each attempt depends on the last
			await runRetries(ctx, indexer, 10_000);
		}
		const [exhausted] = (await getRetryQueue(ctx)).items;

		expect(delays).toEqual([MINUTE, 2 * MINUTE, 4 * MINUTE, 8 * MINUTE]);
		expect(exhausted).toMatchObject({
			attempts: 5,
			nextAt: null,
			error: "AiSearchError: internal_error",
		});
		expect(scheduled.has("retry")).toBe(false);
	});

	it("leaves a rate-limited record queued without counting the attempt", async () => {
		vi.useFakeTimers();
		const { ctx, items, indexer, post } = await setup();
		await queueRetries(ctx, [{ source: "posts", id: post.id, error: "internal_error" }]);
		items.rateLimitAfter = 0;
		vi.advanceTimersByTime(MINUTE);

		await runRetries(ctx, indexer, 10_000);

		expect((await getRetryQueue(ctx)).items).toMatchObject([{ id: post.id, attempts: 1 }]);
	});

	it("keeps the cron task when a failure is queued while the queue is emptying", async () => {
		vi.useFakeTimers();
		const { ctx, scheduled, indexer, post } = await setup();
		await queueRetries(ctx, [{ source: "posts", id: post.id, error: "internal_error" }]);
		vi.advanceTimersByTime(MINUTE);
		const cancel = ctx.cron.cancel;
		let queueDuringCancel = true;
		ctx.cron.cancel = async (name) => {
			if (queueDuringCancel) {
				queueDuringCancel = false;
				await queueRetries(ctx, [{ source: "posts", id: "other", error: "internal_error" }]);
			}
			await cancel(name);
		};

		await runRetries(ctx, indexer, 10_000);

		expect((await getRetryQueue(ctx)).items.map((item) => item.id)).toEqual(["other"]);
		expect(scheduled.has("retry")).toBe(true);
	});

	it("retries on request, even after automatic attempts ran out", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { ctx, indexer, post } = await setup();
		const failure = { source: "posts", id: post.id, error: "internal_error" };
		for (let attempt = 0; attempt < 5; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts must be counted in order
			await queueRetries(ctx, [failure]);
		}
		vi.advanceTimersByTime(MINUTE);

		const outcome = await retryRecord(ctx, indexer, failure);

		expect(outcome).toBe("synced");
		expect((await getRetryQueue(ctx)).items).toEqual([]);
	});

	it("keeps a record queued when the settings change while it is retried, and syncs it with the new ones", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { ctx, items, indexer, post } = await setup();
		const failure = { source: "posts", id: post.id, error: "internal_error" };
		for (let attempt = 0; attempt < 5; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts must be counted in order
			await queueRetries(ctx, [failure]);
		}
		vi.advanceTimersByTime(MINUTE);
		const changed = config({ sources: { posts: { ...config().sources.posts!, weight: 5 } } });
		const upload = items.upload.bind(items);
		items.upload = async (...args) => {
			await ctx.kv.set("config", changed);
			return upload(...args);
		};

		const outcome = await retryRecord(ctx, indexer, failure);
		items.upload = upload;
		const fresh = new Indexer({ ...fakeEmDash({ entries: [post] }), items }, changed);
		vi.advanceTimersByTime(MINUTE);
		await runRetries(ctx, fresh, 10_000);

		expect(outcome).toBe("busy");
		expect(items.items.get("posts/entry-1.md")?.metadata).toMatchObject({ priority: "5" });
		expect((await getRetryQueue(ctx)).items).toEqual([]);
	});

	it("keeps a failure recorded while an older sync of the same record was running", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { ctx, indexer, post } = await setup();
		const record = { source: "posts", id: post.id };
		const startedAt = Date.now();
		vi.advanceTimersByTime(1000);
		await queueRetries(ctx, [{ ...record, error: "internal_error" }]);

		await finishSync(ctx, indexer, record, startedAt);

		expect((await getRetryQueue(ctx)).items).toMatchObject([record]);
	});

	it("keeps the newest failures and counts the ones it drops", async () => {
		const { ctx } = await setup();
		const failures = Array.from({ length: 502 }, (_, i) => ({
			source: "posts",
			id: `entry-${i}`,
			error: "internal_error",
		}));

		await queueRetries(ctx, failures);
		const queue = await getRetryQueue(ctx);

		expect(queue.items).toHaveLength(500);
		expect(queue.items[0]?.id).toBe("entry-2");
		expect(queue.dropped).toBe(2);
	});
});
