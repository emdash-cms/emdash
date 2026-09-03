/**
 * MCP content lifecycle tests.
 *
 * Covers two contracts that callers rely on:
 *
 * - `content_unpublish` preserves `published_at` as the editorial publication
 *   date. Publication state comes from the status and revision pointers, and
 *   re-publishing without an override keeps the same timestamp.
 * - `schema_create_collection` applies its documented default of
 *   `['drafts', 'revisions']` for `supports` when the caller omits it.
 *   Explicit `[]` is preserved as an opt-out.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import {
	setupTestDatabaseWithCollections,
	teardownTestDatabase,
	setupTestDatabase,
} from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

describe("MCP content_unpublish — publishedAt preservation", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("unpublish preserves publishedAt", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Will publish" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// Publish — populates publishedAt
		const published = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		const publishedAt = extractJson<{ item: { publishedAt: string } }>(published).item.publishedAt;
		expect(publishedAt).toBeTruthy();

		const unpublished = await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "post", id },
		});
		const unpubItem = extractJson<{
			item: { publishedAt: string | null; status: string };
		}>(unpublished);

		expect(unpubItem.item.status).toBe("draft");
		expect(unpubItem.item.publishedAt).toBe(publishedAt);
	});

	it("content_get after unpublish returns the retained publishedAt and draft status", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;
		const published = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		const publishedAt = extractJson<{ item: { publishedAt: string } }>(published).item.publishedAt;
		await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "post", id },
		});

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const gotItem = extractJson<{
			item: { publishedAt: string | null; status: string };
		}>(got);
		expect(gotItem.item.status).toBe("draft");
		expect(gotItem.item.publishedAt).toBe(publishedAt);
	});

	it("re-publish after unpublish keeps the original publishedAt timestamp", async () => {
		const publishedAt = "2020-01-01T00:00:00.000Z";
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const firstPub = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, publishedAt },
		});
		const firstTs = extractJson<{ item: { publishedAt: string } }>(firstPub).item.publishedAt;
		expect(firstTs).toBe(publishedAt);

		await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "post", id },
		});

		const secondPub = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		const secondTs = extractJson<{ item: { publishedAt: string } }>(secondPub).item.publishedAt;
		expect(secondTs).toBe(publishedAt);
	});
});

describe("MCP schema_create_collection — supports default", () => {
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

	it("creating a collection without `supports` uses documented default ['drafts', 'revisions']", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "article", label: "Articles" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<{ supports: string[] }>(result);

		expect(created.supports).toEqual(expect.arrayContaining(["drafts", "revisions"]));
	});

	it("explicit empty supports array is preserved (regression guard — opt-out)", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "minimal", label: "Minimal", supports: [] },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<{ supports: string[] }>(result);
		expect(created.supports).toEqual([]);
	});

	it("explicit supports list is preserved exactly (regression guard)", async () => {
		const result = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: {
				slug: "blog",
				label: "Blog",
				supports: ["drafts", "revisions", "scheduling"],
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const created = extractJson<{ supports: string[] }>(result);
		expect(created.supports.toSorted()).toEqual(["drafts", "revisions", "scheduling"].toSorted());
	});

	it("default-supports collection accepts publish/unpublish/revision flows immediately", async () => {
		await harness.client.callTool({
			name: "schema_create_collection",
			arguments: { slug: "story", label: "Stories" },
		});
		await harness.client.callTool({
			name: "schema_create_field",
			arguments: { collection: "story", slug: "title", label: "Title", type: "string" },
		});

		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "story", data: { title: "T" } },
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "story", id, data: { title: "Updated" } },
		});

		const revs = await harness.client.callTool({
			name: "revision_list",
			arguments: { collection: "story", id },
		});
		expect(revs.isError, extractText(revs)).toBeFalsy();
		const items = extractJson<{ items: unknown[] }>(revs).items;
		expect(items.length).toBeGreaterThan(0);
	});
});
