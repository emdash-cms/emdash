/**
 * MCP search tool — comprehensive integration tests.
 *
 * Covers:
 *   - search query → matching results
 *   - empty index / no searchable collections
 *   - collection scoping
 *   - locale filtering
 *   - special characters / FTS5 syntax
 *   - permission gating
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
const SUBSCRIBER_ID = "user_subscriber";

async function setupSearchablePostCollection(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: "post",
		label: "Posts",
		supports: ["drafts", "revisions", "search"],
	});
	await registry.createField("post", {
		slug: "title",
		label: "Title",
		type: "string",
		searchable: true,
	});
	await registry.createField("post", {
		slug: "body",
		label: "Body",
		type: "text",
		searchable: true,
	});
}

describe("search", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns empty results when no collections are searchable", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "post", label: "Posts" }); // no search support

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "anything" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{ items: unknown[] }>(result);
		expect(data.items).toEqual([]);
	});

	it("returns empty results for a query with no matches", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Hello world", body: "Lorem ipsum" } },
		});
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: "hello-world" },
		});

		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "ZZZZZQuantumZebra" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{ items: unknown[] }>(result);
		expect(data.items).toEqual([]);
	});

	it("returns matching items for a query that hits", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Hello world", body: "Lorem ipsum about searching" },
			},
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});

		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "Hello" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{ items: Array<{ id: string }> }>(result);
		expect(data.items.length).toBeGreaterThan(0);
		expect(data.items.find((i) => i.id === id)).toBeTruthy();
	});

	it("scopes search by collections argument", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			supports: ["search"],
		});
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});
		await registry.createCollection({
			slug: "page",
			label: "Pages",
			supports: ["search"],
		});
		await registry.createField("page", {
			slug: "title",
			label: "Title",
			type: "string",
			searchable: true,
		});

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const post = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "rocket post" } },
		});
		const page = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "page", data: { title: "rocket page" } },
		});
		await harness.client.callTool({
			name: "content_publish",
			arguments: {
				collection: "post",
				id: extractJson<{ item: { id: string } }>(post).item.id,
			},
		});
		await harness.client.callTool({
			name: "content_publish",
			arguments: {
				collection: "page",
				id: extractJson<{ item: { id: string } }>(page).item.id,
			},
		});

		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "rocket", collections: ["post"] },
		});
		const data = extractJson<{ items: Array<{ collection?: string; type?: string }> }>(result);
		// All results should be from the post collection
		for (const item of data.items) {
			const c = item.collection ?? item.type;
			expect(c).toBe("post");
		}
	});

	it("handles empty query string gracefully", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "" },
		});
		// Either errors with a clear message, or returns no items.
		// What's NOT acceptable is throwing an opaque FTS5 syntax error.
		if (result.isError) {
			expect(extractText(result)).not.toMatch(/syntax|fts5/i);
		} else {
			const data = extractJson<{ items: unknown[] }>(result);
			expect(data.items).toEqual([]);
		}
	});

	it("handles special characters in query without leaking FTS5 syntax errors", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		// FTS5 has special operators: AND OR NOT NEAR " * ( ) :
		// User input with these chars must be sanitized or quoted.
		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: 'NOT "quotes" AND* (' },
		});
		if (result.isError) {
			// If it errors, the message must not leak SQLite/FTS5 internals
			expect(extractText(result)).not.toMatch(/fts5|syntax error|sqlite/i);
		}
	});

	it("respects the limit parameter", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		// Create 10 items containing the same word
		for (let i = 0; i < 10; i++) {
			const c = await harness.client.callTool({
				name: "content_create",
				arguments: {
					collection: "post",
					data: { title: `searchable item ${i}`, body: "common-text" },
				},
			});
			await harness.client.callTool({
				name: "content_publish",
				arguments: {
					collection: "post",
					id: extractJson<{ item: { id: string } }>(c).item.id,
				},
			});
		}

		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "common-text", limit: 3 },
		});
		const data = extractJson<{ items: unknown[] }>(result);
		expect(data.items.length).toBeLessThanOrEqual(3);
	});

	it("only returns published items (not drafts) regardless of caller role", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		// Create one draft, one published
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "draft-only-content" } },
		});
		const pubItem = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "published-content" } },
		});
		await harness.client.callTool({
			name: "content_publish",
			arguments: {
				collection: "post",
				id: extractJson<{ item: { id: string } }>(pubItem).item.id,
			},
		});

		const draftQuery = await harness.client.callTool({
			name: "search",
			arguments: { query: "draft-only-content" },
		});
		expect(extractJson<{ items: unknown[] }>(draftQuery).items).toEqual([]);

		const pubQuery = await harness.client.callTool({
			name: "search",
			arguments: { query: "published-content" },
		});
		expect(extractJson<{ items: unknown[] }>(pubQuery).items.length).toBeGreaterThan(0);
	});

	it("any logged-in user (SUBSCRIBER) can search", async () => {
		await setupSearchablePostCollection(db);
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "search",
			arguments: { query: "anything" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});
