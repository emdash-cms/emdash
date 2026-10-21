import { describe, expect, it } from "vitest";

import type { SearchDocument } from "../src/documents.js";
import { entryIndexStatus } from "../src/entry-status.js";
import type { Exclusion } from "../src/indexer.js";
import type { RetryQueue } from "../src/retry.js";

const record = { source: "posts", id: "entry-1" };
const emptyQueue: RetryQueue = { items: [], dropped: 0 };
const document = {
	key: "posts/entry-1.md",
	body: "",
	metadata: { hash: "new" },
	context: [],
} as unknown as SearchDocument;

function item(status: AiSearchItemInfo["status"], hash = "new"): AiSearchItemInfo {
	return {
		id: "item-1",
		key: "posts/entry-1.md",
		status,
		metadata: {
			source: "posts",
			locale: "en",
			title: "Hello world",
			url: "/posts/hello-world",
			excerpt: "",
			hash,
		},
		last_seen_at: "2026-09-28 19:42:15",
	} as AiSearchItemInfo;
}

function statusOf(
	plan: SearchDocument | Exclusion,
	indexed: AiSearchItemInfo | null,
	queue = emptyQueue,
) {
	return entryIndexStatus(
		{ plan: async () => plan, indexedItem: async () => indexed },
		queue,
		record,
	);
}

describe("entryIndexStatus", () => {
	it("reports an entry as indexed when AI Search holds its current version", async () => {
		expect(await statusOf(document, item("completed"))).toEqual({
			state: "indexed",
			updatedAt: "2026-09-28T19:42:15Z",
		});
	});

	it("reports an older indexed version as outdated", async () => {
		expect((await statusOf(document, item("completed", "old"))).state).toBe("outdated");
	});

	it("reports processing while AI Search works on an upload, whatever its metadata says", async () => {
		expect((await statusOf(document, item("queued", "old"))).state).toBe("processing");
	});

	it("reports a failed item and a missing one", async () => {
		expect((await statusOf(document, item("error"))).state).toBe("failed");
		expect((await statusOf(document, null)).state).toBe("missing");
	});

	it("reports an excluded entry that is still in search as leftover", async () => {
		expect((await statusOf("unpublished", item("completed"))).state).toBe("leftover");
	});

	it("includes a failed upload waiting for a retry", async () => {
		const queue: RetryQueue = {
			items: [{ ...record, error: "boom", attempts: 5, failedAt: 0, nextAt: null }],
			dropped: 0,
		};

		expect((await statusOf(document, null, queue)).retry).toEqual({
			error: "boom",
			automatic: false,
		});
	});
});
