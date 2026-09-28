import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { publishDueContent } from "../../../src/scheduled-publish.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type HandlerResult<T> =
	| { success: true; data: T }
	| { success: false; error: { code: string; message: string } };

function ok<T>(result: HandlerResult<T>): T {
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
}

describeEachDialect("schedules across unpublish, trash, and restore", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		repo = new ContentRepository(db);
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createDraft(title: string) {
		const created = await runtime.handleContentCreate("post", {
			data: { title },
			slug: title.toLowerCase(),
		});
		return ok(created).item;
	}

	async function createPublished(title: string) {
		const draft = await createDraft(title);
		return ok(await runtime.handleContentPublish("post", draft.id));
	}

	async function trash(id: string) {
		expect((await runtime.handleContentDelete("post", id)).success).toBe(true);
	}

	/** Schedules in the future, then moves the time into the past, as if it had arrived. */
	async function scheduleDue(id: string) {
		const future = new Date(Date.now() + 86_400_000).toISOString();
		ok(await runtime.handleContentSchedule("post", id, future));
		const past = new Date(Date.now() - 60_000).toISOString();
		await repo.update("post", id, { scheduledAt: past });
	}

	async function currentRev(id: string) {
		return ok(await runtime.handleContentGet("post", id))._rev;
	}

	it("unpublishing an entry with scheduled changes cancels the schedule", async () => {
		const { item } = await createPublished("Live");
		await scheduleDue(item.id);

		const unpublished = ok(
			await runtime.handleContentUnpublish("post", item.id, { _rev: await currentRev(item.id) }),
		);

		expect(unpublished.item.status).toBe("draft");
		expect(unpublished.item.scheduledAt).toBeNull();
		expect(await publishDueContent(db)).toEqual([]);
		expect((await repo.findById("post", item.id))?.status).toBe("draft");
	});

	it("unpublishing a scheduled draft cancels its first publication", async () => {
		const draft = await createDraft("Upcoming");
		await scheduleDue(draft.id);

		const unpublished = ok(
			await runtime.handleContentUnpublish("post", draft.id, { _rev: await currentRev(draft.id) }),
		);

		expect(unpublished.item.status).toBe("draft");
		expect(unpublished.item.scheduledAt).toBeNull();
		expect(await publishDueContent(db)).toEqual([]);
		expect((await repo.findById("post", draft.id))?.status).toBe("draft");
	});

	it("unpublishing a draft that still carries a schedule cancels it", async () => {
		const draft = await createDraft("Held");
		await scheduleDue(draft.id);
		ok(
			await runtime.handleContentUpdate("post", draft.id, {
				status: "draft",
				_rev: await currentRev(draft.id),
			}),
		);

		const unpublished = ok(
			await runtime.handleContentUnpublish("post", draft.id, { _rev: await currentRev(draft.id) }),
		);

		expect(unpublished.item.scheduledAt).toBeNull();
		expect(await publishDueContent(db)).toEqual([]);
		expect((await repo.findById("post", draft.id))?.status).toBe("draft");
	});

	it("restores a trashed published entry as a draft that keeps its content", async () => {
		const { item } = await createPublished("Live");
		await trash(item.id);

		const restored = ok(await runtime.handleContentRestore("post", item.id));

		expect(restored.item.status).toBe("draft");
		expect(restored.item.liveRevisionId).toBeNull();
		expect(restored.item.scheduledAt).toBeNull();
		const current = ok(await runtime.handleContentGet("post", item.id));
		expect(current.item.data.title).toBe("Live");

		const republished = ok(
			await runtime.handleContentPublish("post", item.id, { _rev: current._rev }),
		);
		expect(republished.item.status).toBe("published");
		expect(republished.item.data.title).toBe("Live");
	});

	it("restores a trashed entry with pending changes as a draft of those changes", async () => {
		const published = await createPublished("Live");
		const saved = ok(
			await runtime.handleContentUpdate("post", published.item.id, {
				data: { title: "Pending" },
				_rev: published._rev,
			}),
		);
		await trash(published.item.id);

		const restored = ok(await runtime.handleContentRestore("post", published.item.id));

		expect(restored.item.status).toBe("draft");
		expect(restored.item.liveRevisionId).toBeNull();
		expect(restored.item.draftRevisionId).toBe(saved.item.draftRevisionId);
		const current = ok(await runtime.handleContentGet("post", published.item.id));
		expect(current.item.data.title).toBe("Pending");
	});

	it("restoring an entry whose schedule fell due in the trash does not publish it", async () => {
		const draft = await createDraft("Upcoming");
		await scheduleDue(draft.id);
		await trash(draft.id);
		expect(await publishDueContent(db)).toEqual([]);

		const restored = ok(await runtime.handleContentRestore("post", draft.id));

		expect(restored.item.status).toBe("draft");
		expect(restored.item.scheduledAt).toBeNull();
		expect(await publishDueContent(db)).toEqual([]);
		expect((await repo.findById("post", draft.id))?.status).toBe("draft");
	});

	it("shows edits saved after restoring an entry in a collection without revisions", async () => {
		await new SchemaRegistry(db).updateCollection("post", { supports: [] });
		const { item } = await createPublished("Live");
		await trash(item.id);
		ok(await runtime.handleContentRestore("post", item.id));

		ok(
			await runtime.handleContentUpdate("post", item.id, {
				data: { title: "Edited" },
				_rev: await currentRev(item.id),
			}),
		);

		expect(ok(await runtime.handleContentGet("post", item.id)).item.data.title).toBe("Edited");
	});

	it("refuses a revision token read before the entry was trashed", async () => {
		const { item, _rev } = await createPublished("Live");
		await trash(item.id);
		ok(await runtime.handleContentRestore("post", item.id));

		const stale = await runtime.handleContentPublish("post", item.id, { _rev });

		expect(stale).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect((await repo.findById("post", item.id))?.status).toBe("draft");
	});
});
