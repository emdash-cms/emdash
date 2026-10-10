import type { PluginContext } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Indexer } from "../src/indexer.js";
import { getRetryQueue, queueRetries, retryRecord, runRetries } from "../src/retry.js";
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

function setup() {
	const post = entry();
	const items = new FakeItems();
	const indexer = new Indexer({ ...fakeEmDash({ entries: [post] }), items }, config());
	const { cron, scheduled } = fakeCron();
	return { ctx: { kv: memoryKv(), cron }, scheduled, items, indexer, post };
}

describe("retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits longer after each failure and stops retrying automatically after five", async () => {
		vi.useFakeTimers();
		const { ctx, scheduled, items, indexer, post } = setup();
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
		const { ctx, items, indexer, post } = setup();
		await queueRetries(ctx, [{ source: "posts", id: post.id, error: "internal_error" }]);
		items.rateLimitAfter = 0;
		vi.advanceTimersByTime(MINUTE);

		await runRetries(ctx, indexer, 10_000);

		expect((await getRetryQueue(ctx)).items).toMatchObject([{ id: post.id, attempts: 1 }]);
	});

	it("retries on request, even after automatic attempts ran out", async () => {
		const { ctx, indexer, post } = setup();
		const failure = { source: "posts", id: post.id, error: "internal_error" };
		for (let attempt = 0; attempt < 5; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- attempts must be counted in order
			await queueRetries(ctx, [failure]);
		}

		const outcome = await retryRecord(ctx, indexer, failure);

		expect(outcome).toBe("synced");
		expect((await getRetryQueue(ctx)).items).toEqual([]);
	});

	it("keeps the newest failures and counts the ones it drops", async () => {
		const { ctx } = setup();
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
