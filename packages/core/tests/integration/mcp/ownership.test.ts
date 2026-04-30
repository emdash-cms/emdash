/**
 * MCP ownership / authorization integration tests.
 *
 * The MCP server's `extractContentAuthorId()` returns "" (empty string)
 * for content with null authorId — mirroring the REST handler. Then
 * `canActOnOwn(user, "", own, any)` defers to the "any" permission so
 * EDITOR+ can edit seed-imported content while CONTRIBUTOR/AUTHOR are
 * denied with a clean permission error.
 *
 * These tests cover every permutation of role × ownership × null-author.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { connectMcpHarness, extractText, type McpHarness } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const EDITOR_ID = "user_editor";
const AUTHOR_ID = "user_author";
const CONTRIBUTOR_ID = "user_contributor";

const NULL_AUTHOR_ERROR = /no.*authorId|content has no authorId/i;

describe("MCP ownership — null authorId (bug #1)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	async function seedItemWithAuthor(authorId: string | null): Promise<string> {
		const repo = new ContentRepository(db);
		const item = await repo.create({
			type: "post",
			data: { title: "Seeded Post" },
			slug: `seeded-${Math.random().toString(36).slice(2, 8)}`,
			status: "published",
			...(authorId !== null ? { authorId } : {}),
		});
		return item.id;
	}

	async function connect(role: keyof typeof userIdByRole): Promise<void> {
		harness = await connectMcpHarness({
			db,
			userId: userIdByRole[role],
			userRole: roleByName[role],
		});
	}

	const userIdByRole = {
		admin: ADMIN_ID,
		editor: EDITOR_ID,
		author: AUTHOR_ID,
		contributor: CONTRIBUTOR_ID,
	} as const;

	const roleByName = {
		admin: Role.ADMIN,
		editor: Role.EDITOR,
		author: Role.AUTHOR,
		contributor: Role.CONTRIBUTOR,
	} as const;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	// ----- content_update -----

	describe("content_update", () => {
		it("ADMIN can update content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("admin");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Updated by admin" } },
			});

			// Currently fails with NULL_AUTHOR_ERROR. After fix: succeeds.
			expect(result.isError, extractText(result)).toBeFalsy();
		});

		it("EDITOR can update content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("editor");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Updated by editor" } },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});

		it("AUTHOR cannot update content with null authorId (no ownership claim)", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("author");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Should fail" } },
			});

			// AUTHOR has only content:edit_own — without an authorId match,
			// they have no "own" claim and lack content:edit_any.
			expect(result.isError).toBe(true);
			// Negative: NOT the null-author internal error.
			expect(extractText(result)).not.toMatch(NULL_AUTHOR_ERROR);
			// Positive: clean permission error with the structured code.
			const meta = (result as { _meta?: { code?: string } })._meta;
			expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
		});

		it("CONTRIBUTOR cannot update content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("contributor");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Should fail" } },
			});

			expect(result.isError).toBe(true);
			expect(extractText(result)).not.toMatch(NULL_AUTHOR_ERROR);
			const meta = (result as { _meta?: { code?: string } })._meta;
			expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
		});
	});

	// ----- content_delete -----

	describe("content_delete (trash)", () => {
		it("ADMIN can trash content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("admin");

			const result = await harness.client.callTool({
				name: "content_delete",
				arguments: { collection: "post", id },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});

		it("AUTHOR cannot trash content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("author");

			const result = await harness.client.callTool({
				name: "content_delete",
				arguments: { collection: "post", id },
			});

			expect(result.isError).toBe(true);
			expect(extractText(result)).not.toMatch(NULL_AUTHOR_ERROR);
			const meta = (result as { _meta?: { code?: string } })._meta;
			expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
		});
	});

	// ----- content_publish / content_unpublish -----

	describe("publish / unpublish", () => {
		it("ADMIN can publish content with null authorId", async () => {
			// Create as draft so publish is meaningful
			const repo = new ContentRepository(db);
			const item = await repo.create({
				type: "post",
				data: { title: "Draft" },
				slug: "draft-null-author",
				status: "draft",
			});
			await connect("admin");

			const result = await harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id: item.id },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});

		it("ADMIN can unpublish content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			await connect("admin");

			const result = await harness.client.callTool({
				name: "content_unpublish",
				arguments: { collection: "post", id },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});
	});

	// ----- content_schedule -----

	describe("content_schedule", () => {
		it("ADMIN can schedule content with null authorId", async () => {
			const repo = new ContentRepository(db);
			const item = await repo.create({
				type: "post",
				data: { title: "Sched draft" },
				slug: "sched-null-author",
				status: "draft",
			});
			await connect("admin");

			const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
			const result = await harness.client.callTool({
				name: "content_schedule",
				arguments: { collection: "post", id: item.id, scheduledAt: future },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});
	});

	// ----- content_restore (from trash) -----

	describe("content_restore", () => {
		it("ADMIN can restore trashed content with null authorId", async () => {
			const id = await seedItemWithAuthor(null);
			// Trash via repo to bypass MCP (which we're testing)
			const repo = new ContentRepository(db);
			await repo.delete("post", id);

			await connect("admin");

			const result = await harness.client.callTool({
				name: "content_restore",
				arguments: { collection: "post", id },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});
	});

	// ----- Sanity checks: ownership behavior unchanged for non-null cases -----

	describe("regression guard — ownership still enforced when authorId is set", () => {
		it("AUTHOR can update their own content (authorId matches)", async () => {
			const id = await seedItemWithAuthor(AUTHOR_ID);
			await connect("author");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Updated own" } },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});

		it("AUTHOR cannot update someone else's content (authorId set to other user)", async () => {
			const id = await seedItemWithAuthor("user_someone_else");
			await connect("author");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Updated other" } },
			});

			expect(result.isError).toBe(true);
		});

		it("EDITOR can update anyone's content (any-permission)", async () => {
			const id = await seedItemWithAuthor("user_someone_else");
			await connect("editor");

			const result = await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Editor override" } },
			});

			expect(result.isError, extractText(result)).toBeFalsy();
		});
	});
});

describe("MCP ownership — error shape consistency", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("denied-by-permissions error does NOT mention 'authorId' (internal detail)", async () => {
		const repo = new ContentRepository(db);
		const item = await repo.create({
			type: "post",
			data: { title: "Test" },
			slug: "perm-test",
			status: "published",
		});

		harness = await connectMcpHarness({
			db,
			userId: AUTHOR_ID,
			userRole: Role.AUTHOR,
		});

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id: item.id, data: { title: "Nope" } },
		});

		expect(result.isError).toBe(true);
		// Negative: "authorId" is an internal column name and must not leak
		// to the user-facing message.
		expect(extractText(result)).not.toMatch(/authorId/);
		// Positive: the response carries a permissions code so callers can
		// distinguish "you can't do this" from any other failure mode.
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
	});
});
