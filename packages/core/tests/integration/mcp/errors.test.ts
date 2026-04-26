/**
 * MCP error envelope fidelity tests.
 *
 * Maps to MCP_BUGS.md #3: specific failure modes (unknown collection,
 * duplicate slug, unknown field, bad orderBy, etc.) all return a single
 * generic string ("Failed to create content", "Failed to list content").
 * Agents waste turns guessing at the cause.
 *
 * Two layers contribute to the bug:
 *   1. `handleContentCreate` / `handleContentList` (api/handlers/content.ts)
 *      catch every error and replace it with a fixed message + opaque code,
 *      so even repository-level signals like UNIQUE constraint violations
 *      reach the MCP layer as `CONTENT_CREATE_ERROR: Failed to create...`.
 *   2. `unwrap()` in mcp/server.ts only forwards `error.message` — the
 *      `error.code` (`VALIDATION_ERROR`, `NOT_FOUND`, etc.) is dropped.
 *      Even when handlers DO return structured errors, MCP loses them.
 *
 * **Expected fix:**
 *   - Handlers detect known failure shapes (unique violation, FK miss,
 *     unknown collection, etc.) and return discriminated codes:
 *     `SLUG_CONFLICT`, `COLLECTION_NOT_FOUND`, `UNKNOWN_FIELD`,
 *     `INVALID_ORDER_BY`, `VALIDATION_ERROR`.
 *   - `unwrap()` emits structured errors that include the code (either as
 *     a tag in the message, e.g. `[SLUG_CONFLICT] Slug already exists`,
 *     or in `_meta` once the SDK supports it).
 *
 * Tests below assert two properties for every failure case:
 *   (a) the response is `isError: true` (already true today)
 *   (b) the message names the specific failure mode, not the generic
 *       "Failed to ..." string
 *
 * (b) currently fails for every covered case.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { connectMcpHarness, extractText, type McpHarness } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

// Generic placeholders that should NOT survive after the fix.
const GENERIC_CREATE = /^Failed to create content$/;
const GENERIC_LIST = /^Failed to list content$/;
const GENERIC_UPDATE = /^Failed to update content$/;
const UNKNOWN_ERROR = /^Unknown error$/;

describe("MCP error envelope — content_create (bug #3)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("unknown collection slug returns a discriminated NOT_FOUND-style error", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "nonexistent", data: { title: "Hi" } },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		// Message should name the specific failure (collection not found).
		expect(text).not.toMatch(GENERIC_CREATE);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		// Tight match: explicitly the COLLECTION_NOT_FOUND code (or message),
		// rather than any text that happens to contain "collection".
		expect(text).toMatch(/COLLECTION_NOT_FOUND|Collection ['"]?nonexistent['"]? not found/i);
	});

	it("duplicate slug returns a SLUG_CONFLICT-style error", async () => {
		// Seed an item with a known slug
		const repo = new ContentRepository(db);
		await repo.create({
			type: "post",
			data: { title: "First" },
			slug: "duplicate-me",
			status: "draft",
			authorId: "seed",
		});

		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Second" },
				slug: "duplicate-me",
			},
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_CREATE);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		// Either explicit "slug" wording or a UNIQUE/conflict signal.
		expect(text).toMatch(/slug|unique|conflict|duplicate|exists/i);
	});

	it("unknown field in data returns an UNKNOWN_FIELD-style error", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				// `nonexistent_field` was never created on the post collection
				data: { title: "Hello", nonexistent_field: "boom" },
			},
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_CREATE);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		expect(text).toMatch(/field|unknown|nonexistent_field|column/i);
	});
});

describe("MCP error envelope — content_list (bug #3)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("unknown collection returns a COLLECTION_NOT_FOUND-style error, not a generic one", async () => {
		const result = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "nonexistent" },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_LIST);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		expect(text).toMatch(/COLLECTION_NOT_FOUND|Collection ['"]?nonexistent['"]? not found/i);
	});

	it("invalid orderBy column returns an INVALID_ORDER_BY-style error", async () => {
		const result = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post", orderBy: "definitely_not_a_column" },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_LIST);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		expect(text).toMatch(/orderBy|order|column|definitely_not_a_column|invalid/i);
	});
});

describe("MCP error envelope — content_get (bug #3)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("missing item returns a clear NOT_FOUND error including the id (already works — regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: "01NONEXISTENT" },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
		expect(text).toContain("01NONEXISTENT");
	});
});

describe("MCP error envelope — content_update (bug #3)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("update on missing id returns a NOT_FOUND-style error", async () => {
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id: "01NEVEREXISTED", data: { title: "x" } },
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_UPDATE);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		expect(text).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
		expect(text).toContain("01NEVEREXISTED");
	});

	it("stale _rev returns a CONFLICT-style error (not a generic one)", async () => {
		const repo = new ContentRepository(db);
		const item = await repo.create({
			type: "post",
			data: { title: "Original" },
			slug: "rev-test",
			status: "draft",
			authorId: "user_admin",
		});

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id: item.id,
				data: { title: "x" },
				_rev: "obviously-stale-rev",
			},
		});

		expect(result.isError).toBe(true);
		const text = extractText(result);
		expect(text).not.toMatch(GENERIC_UPDATE);
		expect(text).not.toMatch(UNKNOWN_ERROR);
		expect(text).toMatch(/conflict|rev|stale|outdated|modified/i);
	});
});

describe("MCP error envelope — error code preservation through unwrap()", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	/**
	 * The MCP SDK forwards `_meta` on tool results when present — once
	 * `unwrap()` propagates it, callers can read structured codes
	 * programmatically. Until then, codes must at least appear in the
	 * message text so callers can match on a stable token.
	 */
	it("a NOT_FOUND error from a handler surfaces 'NOT_FOUND' or equivalent", async () => {
		const result = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: "01MISSING" },
		});
		expect(result.isError).toBe(true);
		// Either the structured _meta carries the code, or the message
		// includes a stable token. Today: only `Content item not found:` —
		// no machine-readable code.
		const text = extractText(result);
		const meta = (result as { _meta?: { code?: string } })._meta;
		const codeFromMeta = meta?.code;
		expect(codeFromMeta === "NOT_FOUND" || /\bNOT_FOUND\b/.test(text)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// F7: error envelope correctly carries codes for SchemaError, McpError,
// and SDK-thrown auth errors.
// ---------------------------------------------------------------------------

describe("MCP error envelope — F7 (codes propagated for SchemaError + auth)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("INSUFFICIENT_SCOPE for a token without the required scope", async () => {
		db = await setupTestDatabaseWithCollections();
		// Only grant content:read; content_create needs content:write.
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
			tokenScopes: ["content:read"],
		});
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "x" } },
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_SCOPE");
		expect(extractText(result)).toMatch(/INSUFFICIENT_SCOPE/);
	});

	it("INSUFFICIENT_PERMISSIONS for a role that's too low", async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_subscriber",
			userRole: Role.SUBSCRIBER,
		});
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "x" } },
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		expect(meta?.code).toBe("INSUFFICIENT_PERMISSIONS");
	});

	it("SchemaError code (RESERVED_SLUG) propagates through schema_create_collection", async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
		// '_emdash_collections' is the prefix used for system tables — that
		// kind of slug is reserved. Pick a guaranteed reserved slug
		// (the '_emdash' prefix or e.g. 'media' — see RESERVED_COLLECTION_SLUGS).
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "media", label: "Reserved" },
		});
		expect(result.isError).toBe(true);
		const meta = (result as { _meta?: { code?: string } })._meta;
		// SchemaError carries `code` directly; respondHandlerError should
		// forward it. Whichever specific reserved-slug code applies is fine
		// — just assert it's a stable string that isn't the generic fallback.
		expect(meta?.code).toBeDefined();
		expect(meta?.code).not.toBe("INTERNAL_ERROR");
		expect(meta?.code).not.toBe("");
	});
});
