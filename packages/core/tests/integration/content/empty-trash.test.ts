import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { POST as emptyTrash } from "../../../src/astro/routes/api/content/[collection]/trash/empty.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import {
	connectMcpHarness,
	createTestRuntime,
	extractJson,
	extractText,
	handlersFromRuntime,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const admin = { id: "user_admin", role: Role.ADMIN as RoleLevel };
const editor = { id: "user_editor", role: Role.EDITOR as RoleLevel };

interface EmptyTrashBody {
	success: boolean;
	data?: { deleted: number; remaining: number };
	error?: { code: string };
}

describeEachDialect("Empty trash", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;
	let handlers: EmDashHandlers;
	let harness: McpHarness | undefined;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
		handlers = handlersFromRuntime(createTestRuntime(ctx.db));
	});

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
		await teardownForDialect(ctx);
	});

	async function seed(count: number, { locale = "en", trashed = true } = {}): Promise<string[]> {
		const ids: string[] = [];
		for (let i = 0; i < count; i++) {
			const item = await repo.create({
				type: "post",
				slug: `${locale}-${trashed ? "trashed" : "live"}-${i}`,
				locale,
				data: { title: `Post ${i}` },
			});
			if (trashed) await repo.delete("post", item.id);
			ids.push(item.id);
		}
		return ids;
	}

	async function callRoute(
		user: { id: string; role: RoleLevel },
		locale?: string,
	): Promise<{ status: number; body: EmptyTrashBody; invalidate: ReturnType<typeof vi.fn> }> {
		const url = new URL("http://localhost/_emdash/api/content/post/trash/empty");
		if (locale) url.searchParams.set("locale", locale);
		const invalidate = vi.fn();
		const response = await emptyTrash({
			params: { collection: "post" },
			url,
			request: new Request(url, { method: "POST" }),
			locals: { emdash: handlers, user },
			cache: { enabled: true, invalidate },
		} as unknown as Parameters<typeof emptyTrash>[0]);
		return {
			status: response.status,
			body: (await response.json()) as EmptyTrashBody,
			invalidate,
		};
	}

	it("deletes one batch per call until the trash is empty, leaving live entries", async () => {
		const total = 40;
		await seed(total);
		const live = await seed(2, { trashed: false });

		const first = await callRoute(admin);
		expect(first.status).toBe(200);
		const { deleted, remaining } = first.body.data!;
		expect(deleted).toBeGreaterThan(0);
		expect(remaining).toBeGreaterThan(0);
		expect(deleted + remaining).toBe(total);
		expect(await repo.countTrashed("post")).toBe(remaining);

		let left = remaining;
		let calls = 1;
		while (left > 0 && calls < total) {
			const next = await callRoute(admin);
			expect(next.status).toBe(200);
			left = next.body.data!.remaining;
			calls++;
		}
		expect(left).toBe(0);
		expect(await repo.countTrashed("post")).toBe(0);
		for (const id of live) {
			expect(await repo.findById("post", id)).not.toBeNull();
		}
	});

	it("deletes only the requested locale's trash and counts only that locale", async () => {
		await seed(2, { locale: "en" });
		const fr = await seed(3, { locale: "fr" });

		const result = await callRoute(admin, "fr");

		expect(result.body.data).toEqual({ deleted: 3, remaining: 0 });
		const [[{ tags }]] = result.invalidate.mock.calls as [[{ tags: string[] }]];
		expect(tags.toSorted()).toEqual(["post", ...fr].toSorted());
		expect(await repo.countTrashed("post", { locale: "fr" })).toBe(0);
		expect(await repo.countTrashed("post", { locale: "en" })).toBe(2);
	});

	it("refuses an editor without deleting anything, and lets an admin through", async () => {
		await seed(2);

		const denied = await callRoute(editor);
		expect(denied.status).toBe(403);
		expect(await repo.countTrashed("post")).toBe(2);

		const allowed = await callRoute(admin);
		expect(allowed.status).toBe(200);
		expect(allowed.body.data).toEqual({ deleted: 2, remaining: 0 });
	});

	it("skips entries another request deleted first instead of failing", async () => {
		await seed(40);
		const runtime = createTestRuntime(ctx.db);
		const permanentDelete = runtime.handleContentPermanentDelete.bind(runtime);
		vi.spyOn(runtime, "handleContentPermanentDelete").mockImplementation(async (collection, id) => {
			await permanentDelete(collection, id);
			return permanentDelete(collection, id);
		});

		const result = await runtime.handleContentEmptyTrash("post");

		expect(result).toMatchObject({ success: true, data: { deletedIds: [] } });
		expect(result.success && result.data.remaining).toBeGreaterThan(0);
	});

	it("removes a deleted entry's revisions", async () => {
		const [id] = await seed(1);
		const revisions = new RevisionRepository(ctx.db);
		await revisions.create({ collection: "post", entryId: id!, data: { title: "v1" } });

		await callRoute(admin);

		expect(await revisions.findByEntry("post", id!)).toHaveLength(0);
	});

	it("empties the trash over MCP for an admin and refuses an editor", async () => {
		await seed(2);

		harness = await connectMcpHarness({ db: ctx.db, userId: editor.id, userRole: editor.role });
		const refused = await harness.client.callTool({
			name: "content_empty_trash",
			arguments: { collection: "post" },
		});
		expect(refused.isError).toBe(true);
		expect(await repo.countTrashed("post")).toBe(2);
		await harness.cleanup();

		harness = await connectMcpHarness({ db: ctx.db, userId: admin.id, userRole: admin.role });
		const result = await harness.client.callTool({
			name: "content_empty_trash",
			arguments: { collection: "post" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		expect(extractJson(result)).toEqual({ deleted: 2, remaining: 0 });
		expect(await repo.countTrashed("post")).toBe(0);
	});
});
