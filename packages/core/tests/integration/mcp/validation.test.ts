/**
 * MCP field-level validation tests.
 *
 * Maps to:
 *   - MCP_BUGS.md #4: required fields not enforced. Creating a content
 *     item without a `required: true` field succeeds with empty values.
 *   - MCP_BUGS.md #5: select / multiSelect option lists not enforced.
 *     Arbitrary string values pass through.
 *   - MCP_BUGS.md #6: reference fields accept non-existent target IDs.
 *
 * Root cause is shared: `handleContentCreate` (and `handleContentUpdate`)
 * never run field-level Zod validation. The schemas exist on each field
 * (`fields/all-fields.test.ts:142-149` proves they reject invalid values
 * in isolation) — they're just not wired into the create/update path.
 *
 * **Expected fix:** the create/update handlers fetch the collection's
 * fields, build a Zod schema (or use the existing per-field schemas),
 * and validate `body.data` before writing. Failures return
 * `{ code: "VALIDATION_ERROR", message: "<field>: <reason>" }`.
 *
 * These tests cover both REST and MCP because they exercise the handler
 * directly through the MCP layer; once the handler validates, both
 * transports benefit.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { connectMcpHarness, extractText, type McpHarness } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

const VALIDATION_ERROR = /validation|required|invalid/i;
const GENERIC_FAILURE = /^Failed to (create|update) content$/;

// ---------------------------------------------------------------------------
// Bug #4: required field validation
// ---------------------------------------------------------------------------

describe("MCP validation — required fields (bug #4)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts" });
		// Required title, optional body
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "body",
			label: "Body",
			type: "text",
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects create without required title", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { body: "no title" } },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_FAILURE);
		expect(text).toMatch(VALIDATION_ERROR);
		expect(text).toMatch(/title/i);
	});

	it("rejects create with empty-string required title", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "" } },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});

	it("rejects create with explicitly-null required title", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: null } },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});

	it("accepts create with required title present (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Has title" } },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects update that clears required title to empty string", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Initial" } },
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = JSON.parse(extractText(created)).item.id as string;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "" } },
		});
		expect(updated.isError).toBe(true);
		expect(extractText(updated)).toMatch(VALIDATION_ERROR);
	});
});

// ---------------------------------------------------------------------------
// Bug #5: select and multiSelect option enforcement
// ---------------------------------------------------------------------------

describe("MCP validation — select and multiSelect options (bug #5)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "priority",
			label: "Priority",
			type: "select",
			validation: { options: ["low", "medium", "high"] },
		});
		await registry.createField("post", {
			slug: "tags",
			label: "Tags",
			type: "multiSelect",
			validation: { options: ["news", "tech", "design"] },
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects select value not in options list", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", priority: "not-an-option" },
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
		expect(extractText(result)).toMatch(/priority|select|option|not-an-option/i);
	});

	it("accepts select value in options list (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", priority: "high" },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects multiSelect array containing an invalid value", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", tags: ["news", "bogus"] },
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
		expect(extractText(result)).toMatch(/tags|multiSelect|option|bogus/i);
	});

	it("accepts multiSelect with all valid values (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", tags: ["news", "tech"] },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects update introducing an invalid select value", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", priority: "low" },
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = JSON.parse(extractText(created)).item.id as string;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { priority: "URGENT" } },
		});
		expect(updated.isError).toBe(true);
		expect(extractText(updated)).toMatch(VALIDATION_ERROR);
	});
});

// ---------------------------------------------------------------------------
// Bug #6: reference field target existence
// ---------------------------------------------------------------------------

describe("MCP validation — reference field targets (bug #6)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "page", label: "Pages" });
		await registry.createField("page", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});

		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "parent_page",
			label: "Parent Page",
			type: "reference",
			validation: { collection: "page" },
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects reference to non-existent target id", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", parent_page: "01NOTAREALPAGE" },
			},
		});
		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).toMatch(VALIDATION_ERROR);
		// Tight match: the error must specifically mention the offending field,
		// echo the bad target id, AND say "not found" (one assertion per
		// concern so a regression where any signal disappears is caught).
		expect(text).toContain("parent_page");
		expect(text).toContain("01NOTAREALPAGE");
		expect(text).toMatch(/\bnot found\b/i);
	});

	it("accepts reference to a real target id (regression guard)", async () => {
		// Create a page first
		const page = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Real page" } },
		});
		expect(page.isError, extractText(page)).toBeFalsy();
		const pageId = JSON.parse(extractText(page)).item.id as string;

		const post = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", parent_page: pageId },
			},
		});
		expect(post.isError, extractText(post)).toBeFalsy();
	});

	it("rejects reference to id that exists in a different collection", async () => {
		// Create a post (which is NOT the page collection the reference is scoped to)
		const repo = new ContentRepository(db);
		const otherPost = await repo.create({
			type: "post",
			data: { title: "Other" },
			slug: "other",
			status: "draft",
			authorId: ADMIN_ID,
		});

		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", parent_page: otherPost.id },
			},
		});
		// Reference points to a post id but field expects a page reference.
		// After fix this should fail.
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});

	it("rejects reference to a soft-deleted (trashed) target", async () => {
		const page = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "Will be trashed" } },
		});
		const pageId = JSON.parse(extractText(page)).item.id as string;
		// Trash via repo
		const repo = new ContentRepository(db);
		await repo.delete("page", pageId);

		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T", parent_page: pageId },
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});
});

// ---------------------------------------------------------------------------
// Combined: error message is structured even when multiple fields fail
// ---------------------------------------------------------------------------

describe("MCP validation — multi-field error messaging", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("post", {
			slug: "priority",
			label: "Priority",
			type: "select",
			validation: { options: ["low", "high"] },
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("when multiple fields fail validation, the error mentions all of them", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				// missing required title AND invalid priority
				collection: "post",
				data: { priority: "URGENT" },
			},
		});
		expect(result.isError).toBe(true);
		const text = extractText(result);
		// Both field names should appear so a caller can fix everything in one round.
		expect(text).toMatch(/title/i);
		expect(text).toMatch(/priority/i);
	});
});

// ---------------------------------------------------------------------------
// F4: validation runs on UPDATE for revision-supporting collections.
//
// Before the fix, the runtime wrote the draft revision *before* the API
// handler ran (and called the handler with `data: undefined`), so update-
// time validation was bypassed for any collection that supports revisions.
// ---------------------------------------------------------------------------

describe("MCP validation — UPDATE on revision-supporting collections (F4)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;
	let postId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const create = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Initial title" } },
		});
		expect(create.isError, extractText(create)).toBeFalsy();
		postId = JSON.parse(extractText(create)).item.id as string;
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects update with empty required field BEFORE creating a draft revision", async () => {
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id: postId, data: { title: "" } },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);

		// And no draft revision was written — listing revisions returns empty.
		const list = await harness.client.callTool({
			name: "revision_list",
			arguments: { collection: "post", id: postId },
		});
		expect(list.isError, extractText(list)).toBeFalsy();
		const { items } = JSON.parse(extractText(list)) as { items: unknown[] };
		expect(items).toEqual([]);
	});
});
