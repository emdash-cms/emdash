/**
 * MCP write tools invalidate the route cache.
 *
 * The REST routes call `cache.invalidate()` after a successful write so a
 * cached page is replaced on the next request. The MCP route passes Astro's
 * `cache` to the tools, and each write tool invalidates the same tags as the
 * REST route for the same operation.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { menuTag, siteSettingsTag, taxonomyTag } from "../../../src/cache/chrome-tags.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	currentRev,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

function createCache(enabled = true) {
	const invalidate = vi.fn(async (_options: { tags?: string[] }) => {});
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the tools only read `enabled` and call `invalidate`
	const cache = { enabled, invalidate } as unknown as APIContext["cache"];
	return { cache, invalidate };
}

function invalidatedTags(invalidate: ReturnType<typeof vi.fn>): string[][] {
	return invalidate.mock.calls.map(([options]) => (options as { tags: string[] }).tags);
}

describe("MCP write tools invalidate the route cache", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;
	let invalidate: ReturnType<typeof createCache>["invalidate"];

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		const created = createCache();
		invalidate = created.invalidate;
		harness = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			cache: created.cache,
		});
	});

	afterEach(async () => {
		await harness.cleanup();
		await teardownTestDatabase(db);
	});

	async function createPost(title = "Hello"): Promise<string> {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title } },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		return extractJson<{ item: { id: string } }>(result).item.id;
	}

	async function publishPost(id: string): Promise<void> {
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, _rev: await currentRev(harness.client, "post", id) },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	}

	it("content_create invalidates the collection", async () => {
		await createPost();
		expect(invalidatedTags(invalidate)).toEqual([["post"]]);
	});

	it("content_publish invalidates the collection and the entry", async () => {
		const id = await createPost();
		invalidate.mockClear();
		await publishPost(id);
		expect(invalidatedTags(invalidate)).toEqual([["post", id]]);
	});

	it("content_unpublish and content_delete invalidate the collection and the entry", async () => {
		const id = await createPost();
		await publishPost(id);
		invalidate.mockClear();

		const unpublished = await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "post", id, _rev: await currentRev(harness.client, "post", id) },
		});
		expect(unpublished.isError, extractText(unpublished)).toBeFalsy();
		const deleted = await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id },
		});
		expect(deleted.isError, extractText(deleted)).toBeFalsy();

		expect(invalidatedTags(invalidate)).toEqual([
			["post", id],
			["post", id],
		]);
	});

	it("content_update that only stages a draft leaves the cache alone", async () => {
		const id = await createPost();
		await publishPost(id);
		invalidate.mockClear();

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				data: { title: "Draft title" },
				_rev: await currentRev(harness.client, "post", id),
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("content_update with status published invalidates the collection and the entry", async () => {
		const id = await createPost();
		await publishPost(id);
		invalidate.mockClear();

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id,
				data: { title: "Live title" },
				status: "published",
				_rev: await currentRev(harness.client, "post", id),
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		expect(invalidatedTags(invalidate)).toEqual([["post", id]]);
	});

	it("a failed write does not invalidate", async () => {
		const id = await createPost();
		invalidate.mockClear();

		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id, _rev: "c3RhbGUtcmV2" },
		});
		expect(result.isError).toBe(true);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("content_update with a status still invalidates when its second step fails after changing live content", async () => {
		// Without revisions, the update step writes the live row directly.
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "note", label: "Notes", supports: ["drafts"] });
		await registry.createField("note", { slug: "title", label: "Title", type: "string" });
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "note", data: { title: "Before" } },
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = extractJson<{ item: { id: string } }>(created).item.id;
		invalidate.mockClear();

		harness.handlers.handleContentPublish = async () => ({
			success: false,
			error: { code: "PUBLISH_FAILED", message: "publish failed" },
		});
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "note",
				id,
				data: { title: "After" },
				status: "published",
				_rev: await currentRev(harness.client, "note", id),
			},
		});

		expect(result.isError).toBe(true);
		expect(invalidatedTags(invalidate)).toEqual([["note", id]]);
	});

	it("taxonomy, menu and settings tools invalidate their chrome tags", async () => {
		const taxonomy = await harness.client.callTool({
			name: "taxonomy_create",
			arguments: { name: "topics", label: "Topics", collections: ["post"] },
		});
		expect(taxonomy.isError, extractText(taxonomy)).toBeFalsy();
		const term = await harness.client.callTool({
			name: "taxonomy_create_term",
			arguments: { taxonomy: "topics", slug: "tech", label: "Tech" },
		});
		expect(term.isError, extractText(term)).toBeFalsy();
		const menu = await harness.client.callTool({
			name: "menu_create",
			arguments: { name: "main", label: "Main" },
		});
		expect(menu.isError, extractText(menu)).toBeFalsy();
		const settings = await harness.client.callTool({
			name: "settings_update",
			arguments: { title: "Site" },
		});
		expect(settings.isError, extractText(settings)).toBeFalsy();

		expect(invalidatedTags(invalidate)).toEqual([
			[taxonomyTag("topics")],
			[taxonomyTag("topics")],
			[menuTag("main")],
			[siteSettingsTag()],
		]);
	});
});

describe("MCP write tools with the route cache disabled", () => {
	it("do not call invalidate", async () => {
		const db = await setupTestDatabaseWithCollections();
		const { cache, invalidate } = createCache(false);
		const harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN, cache });
		try {
			const result = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "Hello" } },
			});
			expect(result.isError, extractText(result)).toBeFalsy();
			expect(invalidate).not.toHaveBeenCalled();
		} finally {
			await harness.cleanup();
			await teardownTestDatabase(db);
		}
	});
});
