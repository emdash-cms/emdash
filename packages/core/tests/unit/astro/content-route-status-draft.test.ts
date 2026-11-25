/**
 * `status: "draft"` on PUT unpublishes a published or scheduled entry, so a
 * `content:beforeUnpublish` policy can refuse it, `content:afterUnpublish`
 * runs, and the live revision and any pending schedule are cleared.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as updateContent } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ContentPolicyEvent } from "../../../src/plugins/types.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const author = { id: "user_author", role: Role.AUTHOR as RoleLevel };
const editor = { id: "user_editor", role: Role.EDITOR as RoleLevel };
const contributor = { id: "user_contributor", role: Role.CONTRIBUTOR as RoleLevel };

describe("PUT /content/:collection/:id with status: draft", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;
	let handlers: EmDashHandlers;
	const beforeUnpublish = vi.fn(async (event: ContentPolicyEvent) =>
		(event.actor?.role ?? 0) >= Role.EDITOR
			? undefined
			: { cancel: true as const, reason: "Only editors can unpublish." },
	);
	const afterUnpublish = vi.fn(async () => {});

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values([
				{
					id: author.id,
					email: "author@example.com",
					name: "Author",
					role: author.role,
					email_verified: 1,
				},
				{
					id: editor.id,
					email: "editor@example.com",
					name: "Editor",
					role: editor.role,
					email_verified: 1,
				},
				{
					id: contributor.id,
					email: "contributor@example.com",
					name: "Contributor",
					role: contributor.role,
					email_verified: 1,
				},
			])
			.execute();
		beforeUnpublish.mockClear();
		afterUnpublish.mockClear();
		runtime = createTestRuntime(db, {
			plugins: [
				definePlugin({
					id: "takedown-policy",
					version: "1.0.0",
					capabilities: ["content:read", "hooks.content-policy:register"],
					hooks: {
						"content:beforeUnpublish": beforeUnpublish,
						"content:afterUnpublish": afterUnpublish,
					},
				}),
			],
		});
		handlers = handlersFromRuntime(runtime);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function seed(status: "draft" | "published", authorId = author.id): Promise<string> {
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Statement" },
			slug: "statement",
			authorId,
		});
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.item.id;
		if (status === "published") {
			const published = await runtime.handleContentPublish("post", id);
			if (!published.success) throw new Error(published.error.message);
		}
		return id;
	}

	async function put(
		id: string,
		user: typeof author,
		body: Record<string, unknown> = {},
		invalidate = vi.fn(),
	): Promise<Response> {
		return updateContent({
			params: { collection: "post", id },
			request: new Request(`http://localhost/_emdash/api/content/post/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...body, status: "draft" }),
			}),
			locals: { emdash: handlers, user },
			cache: { enabled: true, invalidate },
		} as unknown as Parameters<typeof updateContent>[0]);
	}

	const stored = (id: string) => new ContentRepository(db).findById("post", id);

	async function currentRev(id: string): Promise<string> {
		const current = await runtime.handleContentGet("post", id);
		if (!current.success || !current.data._rev) throw new Error("Failed to read _rev");
		return current.data._rev;
	}

	it("is refused when the unpublish policy refuses the caller", async () => {
		const id = await seed("published");
		const invalidate = vi.fn();

		const response = await put(
			id,
			author,
			{ data: { title: "Revised" }, _rev: await currentRev(id) },
			invalidate,
		);

		expect(response.status, await response.clone().text()).toBe(422);
		expect(await response.json()).toMatchObject({
			error: { code: "UNPUBLISH_REJECTED", details: { _rev: await currentRev(id) } },
		});
		const current = await runtime.handleContentGet("post", id);
		expect(current.success && current.data.item.data).toMatchObject({ title: "Revised" });
		expect(beforeUnpublish).toHaveBeenCalledTimes(1);
		expect(beforeUnpublish.mock.calls[0]?.[0]).toMatchObject({
			origin: { source: "api" },
			actor: { id: author.id, role: author.role },
		});
		expect(await stored(id)).toMatchObject({ status: "published" });
		expect(afterUnpublish).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("unpublishes the entry the way the unpublish route does", async () => {
		const id = await seed("published");
		const staged = await runtime.handleContentUpdate("post", id, { data: { title: "Revised" } });
		if (!staged.success) throw new Error(staged.error.message);
		const scheduled = await runtime.handleContentSchedule("post", id, "2099-01-01T00:00:00.000Z");
		if (!scheduled.success) throw new Error(scheduled.error.message);
		expect(await stored(id)).toMatchObject({
			status: "published",
			scheduledAt: "2099-01-01T00:00:00.000Z",
		});
		const invalidate = vi.fn();

		const response = await put(id, editor, {}, invalidate);

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({ data: { item: { id, status: "draft" } } });
		expect(await stored(id)).toMatchObject({
			status: "draft",
			liveRevisionId: null,
			scheduledAt: null,
		});
		await vi.waitFor(() => expect(afterUnpublish).toHaveBeenCalledTimes(1));
		expect(invalidate).toHaveBeenCalledWith({ tags: ["post", id] });
	});

	it("clears the live revision and schedule of a draft that still has them", async () => {
		const id = await seed("published");
		const scheduled = await runtime.handleContentSchedule("post", id, "2099-01-01T00:00:00.000Z");
		if (!scheduled.success) throw new Error(scheduled.error.message);
		await sql`UPDATE ec_post SET status = 'draft' WHERE id = ${id}`.execute(db);
		const before = await stored(id);
		expect(before).toMatchObject({ status: "draft", scheduledAt: "2099-01-01T00:00:00.000Z" });
		expect(before?.liveRevisionId).toEqual(expect.any(String));

		const response = await put(id, editor);

		expect(response.status, await response.clone().text()).toBe(200);
		expect(beforeUnpublish).toHaveBeenCalledTimes(1);
		expect(await stored(id)).toMatchObject({
			status: "draft",
			liveRevisionId: null,
			scheduledAt: null,
		});
		await vi.waitFor(() => expect(afterUnpublish).toHaveBeenCalledTimes(1));
	});

	it("saves the rest of the body before unpublishing under the caller's _rev", async () => {
		const id = await seed("published");

		const response = await put(id, editor, {
			data: { title: "Revised" },
			_rev: await currentRev(id),
		});

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { item: { status: "draft", data: { title: "Revised" } }, _rev: await currentRev(id) },
		});
		expect(await stored(id)).toMatchObject({ status: "draft", liveRevisionId: null });
	});

	it("unpublishes only the state its own save wrote", async () => {
		const id = await seed("published");
		const save = handlers.handleContentUpdate;
		handlers = {
			...handlers,
			handleContentUpdate: async (...args) => {
				const result = await save(...args);
				const concurrent = await runtime.handleContentUpdate("post", id, {
					data: { title: "Concurrent" },
				});
				if (!concurrent.success) throw new Error(concurrent.error.message);
				// A reread after the concurrent write reports that write's `_rev`.
				return result.success
					? { ...result, data: { ...result.data, _rev: await currentRev(id) } }
					: result;
			},
		};

		const response = await put(id, editor, {
			data: { title: "Revised" },
			_rev: await currentRev(id),
		});

		expect(response.status, await response.clone().text()).toBe(409);
		expect(await stored(id)).toMatchObject({ status: "published" });
		expect(beforeUnpublish).not.toHaveBeenCalled();
	});

	it("refuses a stale _rev and leaves the entry published", async () => {
		const id = await seed("published");
		const staleRev = await currentRev(id);
		const staged = await runtime.handleContentUpdate("post", id, { data: { title: "Revised" } });
		if (!staged.success) throw new Error(staged.error.message);

		const response = await put(id, editor, { _rev: staleRev });

		expect(response.status, await response.clone().text()).toBe(409);
		expect(await stored(id)).toMatchObject({ status: "published" });
		expect(beforeUnpublish).not.toHaveBeenCalled();
	});

	it("saves the rest of the body to an entry that is already a draft", async () => {
		const id = await seed("draft", contributor.id);

		const response = await put(id, contributor, { data: { title: "Edited" } });

		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({
			data: { item: { status: "draft", data: { title: "Edited" } } },
		});
		expect(beforeUnpublish).not.toHaveBeenCalled();
		expect(afterUnpublish).not.toHaveBeenCalled();
	});
});
