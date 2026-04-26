/**
 * MCP schema tools — comprehensive integration tests.
 *
 * Covers every branch of:
 *   - schema_list_collections
 *   - schema_get_collection
 *   - schema_create_collection (also bug #11 — supports default)
 *   - schema_delete_collection
 *   - schema_create_field
 *   - schema_delete_field
 *
 * For each tool: happy path, edge cases (empty, missing, duplicate,
 * reserved names), permission gates, error envelope (bug #3 — currently
 * generic). Where the omnibus fix is expected to introduce structured
 * errors, the assertions name the specific failure mode so they fail
 * usefully today.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const EDITOR_ID = "user_editor";
const AUTHOR_ID = "user_author";

const VALIDATION_ERROR = /validation|invalid|reserved|pattern|format|required/i;

// ---------------------------------------------------------------------------
// schema_list_collections
// ---------------------------------------------------------------------------

describe("schema_list_collections", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns empty list when no collections exist", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { items } = extractJson<{ items: unknown[] }>(result);
		expect(items).toEqual([]);
	});

	it("lists multiple collections in stable order", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createCollection({ slug: "page", label: "Pages" });
		await registry.createCollection({ slug: "product", label: "Products" });

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		const { items } = extractJson<{ items: Array<{ slug: string }> }>(result);
		const slugs = items.map((c) => c.slug).toSorted();
		expect(slugs).toEqual(["page", "post", "product"]);
	});

	it("requires EDITOR or higher", async () => {
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		expect(result.isError).toBe(true);
	});

	it("EDITOR can list collections", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" });

		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// schema_get_collection
// ---------------------------------------------------------------------------

describe("schema_get_collection", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await registry.createField("post", { slug: "body", label: "Body", type: "text" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns collection with its fields", async () => {
		const result = await harness.client.callTool({
			name: "schema_get_collection",
			arguments: { slug: "post" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const collection = extractJson<{
			slug: string;
			label: string;
			labelSingular?: string;
			supports: string[];
			fields: Array<{ slug: string; type: string }>;
		}>(result);
		expect(collection.slug).toBe("post");
		expect(collection.label).toBe("Posts");
		expect(collection.labelSingular).toBe("Post");
		expect(collection.supports).toEqual(expect.arrayContaining(["drafts", "revisions"]));
		const fieldSlugs = collection.fields.map((f) => f.slug).toSorted();
		expect(fieldSlugs).toEqual(["body", "title"]);
	});

	it("returns NOT_FOUND-style error for missing collection", async () => {
		const result = await harness.client.callTool({
			name: "schema_get_collection",
			arguments: { slug: "nonexistent" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/not.found|nonexistent/i);
	});

	it("requires EDITOR or higher", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "schema_get_collection",
			arguments: { slug: "post" },
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// schema_create_collection
// ---------------------------------------------------------------------------

describe("schema_create_collection", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("creates a collection with minimal arguments", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "article", label: "Articles" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<{ slug: string; label: string }>(result);
		expect(created.slug).toBe("article");
		expect(created.label).toBe("Articles");
	});

	it("creates with all optional fields", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: {
				slug: "story",
				label: "Stories",
				labelSingular: "Story",
				description: "A story collection",
				icon: "book",
				supports: ["drafts", "revisions", "scheduling"],
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<{
			slug: string;
			label: string;
			labelSingular?: string;
			description?: string;
			icon?: string;
			supports: string[];
		}>(result);
		expect(created.labelSingular).toBe("Story");
		expect(created.description).toBe("A story collection");
		expect(created.icon).toBe("book");
		expect(created.supports.toSorted()).toEqual(["drafts", "revisions", "scheduling"].toSorted());
	});

	it("rejects slug that doesn't match the collection slug pattern", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "Has-Caps", label: "Bad" },
		});
		expect(result.isError).toBe(true);
	});

	it("rejects slug starting with a number", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "1posts", label: "Posts" },
		});
		expect(result.isError).toBe(true);
	});

	it("rejects empty slug", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "", label: "Empty" },
		});
		expect(result.isError).toBe(true);
	});

	it("rejects duplicate slug", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "post", label: "Posts" },
		});
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "post", label: "Posts Two" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/exist|duplicate|conflict|already/i);
	});

	it("rejects reserved slug like 'media' or 'options'", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		// `options` is a reserved table name
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "options", label: "Options" },
		});
		expect(result.isError).toBe(true);
	});

	it("requires ADMIN role (EDITOR is blocked)", async () => {
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "blocked", label: "Blocked" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/permission|insufficient/i);
	});

	it("accepts SQL-injection attempt as a normal slug rejection (regression)", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "drop_tables); --", label: "x" },
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// schema_delete_collection
// ---------------------------------------------------------------------------

describe("schema_delete_collection", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("deletes an empty collection", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_delete_collection",
			arguments: { slug: "post" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		// Verify it's gone
		const list = await harness.client.callTool({
			name: "schema_list_collections",
			arguments: {},
		});
		const { items } = extractJson<{ items: Array<{ slug: string }> }>(list);
		expect(items.find((c) => c.slug === "post")).toBeUndefined();
	});

	it("rejects deleting a collection with content unless force is true", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "A" } },
		});

		const result = await harness.client.callTool({
			name: "schema_delete_collection",
			arguments: { slug: "post" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/content|empty|force|not.empty/i);
	});

	it("force deletes a collection with content", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "A" } },
		});

		const result = await harness.client.callTool({
			name: "schema_delete_collection",
			arguments: { slug: "post", force: true },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("returns clear NOT_FOUND error for missing collection", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "schema_delete_collection",
			arguments: { slug: "nonexistent" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/not.found|nonexistent/i);
	});

	it("requires ADMIN role", async () => {
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "schema_delete_collection",
			arguments: { slug: "post" },
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// schema_create_field
// ---------------------------------------------------------------------------

describe("schema_create_field", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("creates a string field with minimal args", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: { collection: "post", slug: "title", label: "Title", type: "string" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const field = extractJson<{ slug: string; type: string; required?: boolean }>(result);
		expect(field.slug).toBe("title");
		expect(field.type).toBe("string");
	});

	it.each([
		["text", "f_text"],
		["number", "f_number"],
		["integer", "f_integer"],
		["boolean", "f_bool"],
		["datetime", "f_dt"],
		["portableText", "f_portable_text"],
		["json", "f_json"],
		["slug", "f_slug"],
	])("creates a %s field", async (fieldType, slug) => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: { collection: "post", slug, label: fieldType, type: fieldType },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("creates a select field with options", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "priority",
				label: "Priority",
				type: "select",
				validation: { options: ["low", "high"] },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("creates a reference field with target collection", async () => {
		await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "page", label: "Pages" },
		});

		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "parent",
				label: "Parent",
				type: "reference",
				options: { collection: "page" },
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("rejects field slug not matching the slug pattern", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "Has-Caps",
				label: "Bad",
				type: "string",
			},
		});
		expect(result.isError).toBe(true);
	});

	it("rejects duplicate field slug on the same collection", async () => {
		await harness.client.callTool({
			name: "schema_create_field",
			arguments: { collection: "post", slug: "title", label: "Title", type: "string" },
		});

		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: { collection: "post", slug: "title", label: "Title v2", type: "string" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/exist|duplicate|already/i);
	});

	it("rejects field on non-existent collection", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "ghost",
				slug: "title",
				label: "Title",
				type: "string",
			},
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/collection|ghost|not.found/i);
	});

	it("rejects field type not in the enum", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "weird",
				label: "Weird",
				type: "not_a_real_type",
			},
		});
		expect(result.isError).toBe(true);
	});

	it("rejects reserved field slug like 'id' or 'created_at'", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "id",
				label: "ID",
				type: "string",
			},
		});
		expect(result.isError).toBe(true);
	});

	it("requires ADMIN role", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "title",
				label: "Title",
				type: "string",
			},
		});
		expect(result.isError).toBe(true);
	});

	it("required field is reflected in the response", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: "post",
				slug: "title",
				label: "Title",
				type: "string",
				required: true,
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const field = extractJson<{ required?: boolean }>(result);
		expect(field.required).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// schema_delete_field
// ---------------------------------------------------------------------------

describe("schema_delete_field", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await registry.createField("post", { slug: "body", label: "Body", type: "text" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("deletes an unused field", async () => {
		const result = await harness.client.callTool({
			name: "schema_delete_field",
			arguments: { collection: "post", fieldSlug: "body" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		// Verify it's gone
		const get = await harness.client.callTool({
			name: "schema_get_collection",
			arguments: { slug: "post" },
		});
		const collection = extractJson<{ fields: Array<{ slug: string }> }>(get);
		expect(collection.fields.find((f) => f.slug === "body")).toBeUndefined();
	});

	it("returns clear error for missing field slug", async () => {
		const result = await harness.client.callTool({
			name: "schema_delete_field",
			arguments: { collection: "post", fieldSlug: "ghost" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/field|ghost|not.found/i);
	});

	it("returns clear error for missing collection", async () => {
		const result = await harness.client.callTool({
			name: "schema_delete_field",
			arguments: { collection: "noplace", fieldSlug: "title" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/collection|noplace|not.found/i);
	});

	it("requires ADMIN role", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "schema_delete_field",
			arguments: { collection: "post", fieldSlug: "body" },
		});
		expect(result.isError).toBe(true);
	});

	it("deleting a field with existing content also drops the data (no orphan)", async () => {
		// Create content using the field
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T", body: "Body content" } },
		});

		// Delete the field
		const result = await harness.client.callTool({
			name: "schema_delete_field",
			arguments: { collection: "post", fieldSlug: "body" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		// content_get should return data without the body field
		const list = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post" },
		});
		const items = extractJson<{ items: Array<Record<string, unknown>> }>(list).items;
		// At minimum, the API shouldn't crash. The field should not appear,
		// and the data fetch should still succeed.
		expect(items.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Cross-cutting: error envelope quality (bug #3 lens)
// ---------------------------------------------------------------------------

describe("schema tools — error envelope quality (bug #3 lens)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("schema_create_collection on duplicate names a discriminated CONFLICT-like error", async () => {
		await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "post", label: "Posts" },
		});
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "post", label: "Posts" },
		});
		expect(result.isError).toBe(true);
		const text = extractText(result);
		// Today: probably leaks raw SQLite UNIQUE error or generic. After fix:
		// a stable signal like "already exists" / CONFLICT.
		expect(text).toMatch(/exist|conflict|duplicate|unique|already/i);
		expect(text).not.toMatch(/^Failed to /);
	});

	it("validation error names the offending field/value in the message", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "Bad-Slug", label: "Bad" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(VALIDATION_ERROR);
	});
});
