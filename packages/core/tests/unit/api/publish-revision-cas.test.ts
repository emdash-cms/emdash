import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as postPublish } from "../../../src/astro/routes/api/content/[collection]/[id]/publish.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("conditional content publication", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createPublished(title = "Live") {
		const created = await runtime.handleContentCreate("post", {
			data: { title },
			slug: title.toLowerCase(),
		});
		expect(created.success).toBe(true);
		const published = await runtime.handleContentPublish("post", created.data!.item.id);
		expect(published.success).toBe(true);
		return published.data!;
	}

	it("publishes only the expected revision and returns the next _rev", async () => {
		const created = await createPublished();
		const saved = await runtime.handleContentUpdate("post", created.item.id, {
			data: { title: "Approved" },
			_rev: created._rev,
		});
		expect(saved.success).toBe(true);

		const published = await runtime.handleContentPublish("post", created.item.id, {
			_rev: saved.data!._rev,
		});

		expect(published.success).toBe(true);
		expect(published.data!.item.data.title).toBe("Approved");
		expect(published.data!._rev).toBeTruthy();
		expect(published.data!._rev).not.toBe(saved.data!._rev);

		const nextSave = await runtime.handleContentUpdate("post", created.item.id, {
			data: { title: "Next" },
			_rev: published.data!._rev,
		});
		expect(nextSave.success).toBe(true);
	});

	it("rejects an approved revision after a newer draft save without mutating live or draft", async () => {
		const created = await createPublished();
		const approved = await runtime.handleContentUpdate("post", created.item.id, {
			data: { title: "Approved A" },
			_rev: created._rev,
		});
		const newer = await runtime.handleContentUpdate("post", created.item.id, {
			data: { title: "Writer B" },
			_rev: approved.data!._rev,
			skipRevision: true,
		});
		expect(newer.data!.item.draftRevisionId).not.toBe(approved.data!.item.draftRevisionId);
		const before = await runtime.handleContentGet("post", created.item.id);

		const stale = await runtime.handleContentPublish("post", created.item.id, {
			_rev: approved.data!._rev,
		});
		const after = await runtime.handleContentGet("post", created.item.id);

		expect(stale).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(after.data!.item.liveRevisionId).toBe(before.data!.item.liveRevisionId);
		expect(after.data!.item.draftRevisionId).toBe(before.data!.item.draftRevisionId);
		expect(after.data!._rev).toBe(newer.data!._rev);
	});

	it("allows only one of two concurrent publishes for the same _rev", async () => {
		const created = await createPublished();
		const saved = await runtime.handleContentUpdate("post", created.item.id, {
			data: { title: "Approved" },
			_rev: created._rev,
		});

		const results = await Promise.all([
			runtime.handleContentPublish("post", created.item.id, { _rev: saved.data!._rev }),
			runtime.handleContentPublish("post", created.item.id, { _rev: saved.data!._rev }),
		]);

		expect(results.filter((result) => result.success)).toHaveLength(1);
		expect(
			results.filter((result) => !result.success && result.error.code === "CONFLICT"),
		).toHaveLength(1);
		const published = await runtime.handleContentGet("post", created.item.id);
		expect(published.data!.item.data.title).toBe("Approved");
		expect(published.data!.item.draftRevisionId).toBeNull();
	});

	it("supports conditional publish for a collection without revisions", async () => {
		const registry = new SchemaRegistry(db);
		await registry.updateCollection("post", { supports: [] });
		const created = await createPublished();

		const published = await runtime.handleContentPublish("post", created.item.id, {
			_rev: created._rev,
		});

		expect(published.success).toBe(true);
		expect(published.data!._rev).not.toBe(created._rev);
	});

	it("applies the same revision condition to unpublish and discard-draft", async () => {
		const created = await createPublished();
		const saved = await runtime.handleContentUpdate("post", created.item.id, {
			data: { title: "Pending" },
			_rev: created._rev,
		});

		const staleUnpublish = await runtime.handleContentUnpublish("post", created.item.id, {
			_rev: created._rev,
		});
		const staleDiscard = await runtime.handleContentDiscardDraft("post", created.item.id, {
			_rev: created._rev,
		});
		expect(staleUnpublish).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(staleDiscard).toMatchObject({ success: false, error: { code: "CONFLICT" } });

		const discarded = await runtime.handleContentDiscardDraft("post", created.item.id, {
			_rev: saved.data!._rev,
		});
		expect(discarded.success).toBe(true);
		expect(discarded.data!._rev).not.toBe(saved.data!._rev);
	});

	it("keeps revisionless publish calls backward compatible", async () => {
		const created = await createPublished();
		const published = await runtime.handleContentPublish("post", created.item.id);

		expect(published.success).toBe(true);
		expect(published.data!._rev).toBeTruthy();
	});

	it("rejects malformed revision conditions as conflicts", async () => {
		const created = await createPublished();
		const published = await runtime.handleContentPublish("post", created.item.id, {
			_rev: "not-a-revision",
		});

		expect(published).toMatchObject({ success: false, error: { code: "CONFLICT" } });
	});
});

describe("conditional publish route authorization", () => {
	it("passes the revision condition through and returns the next revision", async () => {
		const handleContentPublish = vi.fn().mockResolvedValue({
			success: true,
			data: { item: { id: "entry", authorId: "owner" }, _rev: "next-rev" },
		});
		const request = new Request("http://localhost/_emdash/api/content/post/entry/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ _rev: "approved-rev" }),
		});
		const response = await postPublish({
			params: { collection: "post", id: "entry" },
			request,
			url: new URL(request.url),
			locals: {
				user: { id: "owner", role: Role.EDITOR },
				emdash: {
					handleContentGet: vi.fn().mockResolvedValue({
						success: true,
						data: { item: { id: "entry", authorId: "owner" }, _rev: "approved-rev" },
					}),
					handleContentPublish,
				},
			},
			cache: { enabled: false, invalidate: vi.fn() },
		} as unknown as APIContext);

		expect(response.status).toBe(200);
		expect(handleContentPublish).toHaveBeenCalledWith("post", "entry", {
			publishedAt: undefined,
			_rev: "approved-rev",
		});
		expect(await response.json()).toMatchObject({ data: { _rev: "next-rev" } });
	});

	it("does not let an unprivileged caller publish even with the current _rev", async () => {
		const handleContentPublish = vi.fn();
		const request = new Request("http://localhost/_emdash/api/content/post/entry/publish", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ _rev: "current-rev" }),
		});
		const response = await postPublish({
			params: { collection: "post", id: "entry" },
			request,
			url: new URL(request.url),
			locals: {
				user: { id: "subscriber", role: Role.SUBSCRIBER },
				emdash: {
					handleContentGet: vi.fn().mockResolvedValue({
						success: true,
						data: { item: { id: "entry", authorId: "subscriber" }, _rev: "current-rev" },
					}),
					handleContentPublish,
				},
			},
			cache: { enabled: false, invalidate: vi.fn() },
		} as unknown as APIContext);

		expect(response.status).toBe(403);
		expect(handleContentPublish).not.toHaveBeenCalled();
	});
});
