import { describe, expect, it } from "vitest";

import { loadActivity } from "../src/activity.js";
import { Indexer } from "../src/indexer.js";
import { queueRetries, type RetryQueue } from "../src/retry.js";
import { FakeItems } from "./fake-ai-search.js";
import { config, entry, fakeEmDash, memoryKv } from "./fakes.js";

function setup(entries = [entry()]) {
	const items = new FakeItems();
	const indexer = new Indexer({ ...fakeEmDash({ entries }), items }, config());
	return { items, indexer, ctx: { kv: memoryKv() } };
}

async function failProcessing(
	items: FakeItems,
	indexer: Indexer,
	id: string,
	error: string | undefined,
	status: "error" | "skipped" = "error",
) {
	await indexer.syncRecord("posts", id);
	const item = items.items.get(`posts/${id}.md`);
	if (!item) throw new Error(`posts/${id} was not uploaded`);
	item.status = status;
	item.error = error;
}

function failures(count: number, error: string) {
	return Array.from({ length: count }, (_, i) => ({ source: "posts", id: `${error}-${i}`, error }));
}

describe("loadActivity", () => {
	it("lists recent items and groups processing and upload failures with record titles", async () => {
		const posts = [entry(), entry({ id: "entry-2", slug: "second", data: { title: "Second" } })];
		const { items, indexer, ctx } = setup(posts);
		await failProcessing(items, indexer, "entry-1", undefined);
		await queueRetries(ctx, [{ source: "posts", id: "entry-2", error: "internal_error" }]);

		const activity = await loadActivity(ctx, items, indexer);

		expect(activity.recent).toEqual([
			{
				source: "posts",
				id: "entry-1",
				title: "Hello world",
				locale: "en",
				status: "error",
				updatedAt: "2026-01-01T12:00:00Z",
			},
		]);
		expect(activity.attention).toEqual([
			{
				stage: "upload",
				reason: "internal_error",
				count: 1,
				retrying: true,
				records: [{ source: "posts", id: "entry-2", title: "Second" }],
			},
			{
				stage: "processing",
				reason: "",
				count: 1,
				retrying: false,
				records: [{ source: "posts", id: "entry-1", title: "Hello world" }],
			},
		]);
		expect(activity.unlisted).toBe(0);
	});

	it("lists skipped items with the records AI Search could not process", async () => {
		const posts = [entry(), entry({ id: "entry-2", slug: "second" })];
		const { items, indexer, ctx } = setup(posts);
		await failProcessing(items, indexer, "entry-1", "file_content_empty");
		await failProcessing(items, indexer, "entry-2", "file_content_empty", "skipped");

		const { attention, unlisted } = await loadActivity(ctx, items, indexer);

		expect(attention.map(({ stage, reason, count }) => [stage, reason, count])).toEqual([
			["processing", "file_content_empty", 2],
		]);
		expect(unlisted).toBe(0);
	});

	it("puts each reason in one group, largest first, with a few of its newest records", async () => {
		const { items, indexer, ctx } = setup();
		await queueRetries(ctx, failures(3, "timeout"));
		await queueRetries(ctx, failures(8, "rate_limited"));

		const { attention, unlisted } = await loadActivity(ctx, items, indexer);

		expect(attention.map(({ reason, count }) => [reason, count])).toEqual([
			["rate_limited", 8],
			["timeout", 3],
		]);
		expect(attention[0]?.records.map((record) => record.id)).toEqual([
			"rate_limited-7",
			"rate_limited-6",
			"rate_limited-5",
			"rate_limited-4",
			"rate_limited-3",
		]);
		expect(unlisted).toBe(0);
	});

	it("reports a group as retrying until every record in it has used up its attempts", async () => {
		const { items, indexer, ctx } = setup();
		await ctx.kv.set("retry", {
			dropped: 0,
			items: [
				{ source: "posts", id: "a", error: "stopped", attempts: 5, failedAt: 0, nextAt: null },
				{ source: "posts", id: "b", error: "mixed", attempts: 5, failedAt: 0, nextAt: null },
				{ source: "posts", id: "c", error: "mixed", attempts: 1, failedAt: 0, nextAt: 1 },
			],
		} satisfies RetryQueue);

		const { attention } = await loadActivity(ctx, items, indexer);

		expect(Object.fromEntries(attention.map((group) => [group.reason, group.retrying]))).toEqual({
			mixed: true,
			stopped: false,
		});
	});

	it("counts failures outside the shown groups so the totals add up", async () => {
		const { items, indexer, ctx } = setup();
		for (let reason = 0; reason < 12; reason++) {
			await queueRetries(ctx, failures(reason + 1, `reason-${reason}`));
		}
		const queue = await ctx.kv.get<RetryQueue>("retry");
		await ctx.kv.set("retry", { ...queue, dropped: 40 });

		const { attention, unlisted } = await loadActivity(ctx, items, indexer);

		const total = Array.from({ length: 12 }, (_, i) => i + 1).reduce((a, b) => a + b, 0) + 40;
		expect(attention).toHaveLength(10);
		expect(attention.at(-1)?.reason).toBe("reason-2");
		expect(attention.reduce((sum, group) => sum + group.count, 0) + unlisted).toBe(total);
		expect(unlisted).toBe(1 + 2 + 40);
	});
});
