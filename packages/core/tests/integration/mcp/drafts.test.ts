/**
 * MCP draft / revision data round-trip tests.
 *
 * Maps to MCP_BUGS.md #2: `content_get` and `content_update` on a
 * collection that supports revisions return the **published** column data
 * even when a newer draft revision exists. Agents see "no change after
 * update" and conclude the API is broken when in fact the update succeeded
 * but isn't surfaced.
 *
 * Mechanism: `ContentRepository.findByIdOrSlug()` reads from the content
 * table columns. Updates to a revision-supporting collection write the new
 * data into a draft revision (`_emdash_revisions` table) and only update
 * `draft_revision_id` + `updated_at` on the content row — the data columns
 * stay at the live published values until publish promotes the draft.
 *
 * **Expected fix:** `content_get` and `content_update` should resolve the
 * effective data — when a draft revision exists, return the draft's data.
 * Existing `content_compare` tool already exposes both sides; the issue
 * is that the default read path doesn't surface draft state at all.
 *
 * Acceptable resolutions:
 *   1. `data` reflects the **draft** when a draft exists (publish-on-write
 *      style). Add a `_state: "draft" | "published"` indicator.
 *   2. Response includes both `data` (published) and `draftData` (when
 *      present). Callers explicitly choose.
 *
 * Either is fine; tests below assert the user-visible round-trip property:
 * "if I update X to Y, then read back, I see Y." That property fails today
 * for revision-supporting collections.
 *
 * Bug #9 (slug update) and #17 (revision_restore semantics) live in this
 * same area — the response shape is what makes them hard to verify.
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

interface ItemEnvelope {
	item: {
		id: string;
		slug: string | null;
		status: string;
		liveRevisionId: string | null;
		draftRevisionId: string | null;
		version: number;
		publishedAt: string | null;
		updatedAt: string;
		// Field columns flattened onto item — title is what we care about
		title?: unknown;
		// Some response variants nest the typed values under `data`
		data?: { title?: unknown };
	};
	_rev?: string;
}

/** Read whatever the response thinks the current title is, regardless of shape. */
function readTitle(item: ItemEnvelope["item"]): unknown {
	if (item.data && typeof item.data === "object" && "title" in item.data) {
		return item.data.title;
	}
	return item.title;
}

describe("MCP drafts — content_get and content_update round-trip (bug #2)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);

		// Collection that supports revisions — this is the surface area
		// where the bug surfaces. Without "revisions" in supports, updates
		// write directly to content columns and the round-trip is trivially
		// correct.
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await registry.createField("post", { slug: "body", label: "Body", type: "text" });

		// Collection without revision support — for contrast/regression
		await registry.createCollection({
			slug: "page",
			label: "Pages",
			labelSingular: "Page",
			supports: [],
		});
		await registry.createField("page", { slug: "title", label: "Title", type: "string" });

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	// ----- Core round-trip: update should be visible on get -----

	describe("revision-supporting collection", () => {
		it("content_update response data reflects the new title", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "Original" } },
			});
			const createdItem = extractJson<ItemEnvelope>(created);

			const updated = await harness.client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: createdItem.item.id,
					data: { title: "Updated" },
				},
			});
			expect(updated.isError, extractText(updated)).toBeFalsy();
			const updatedItem = extractJson<ItemEnvelope>(updated);

			// Bug #2: today this returns "Original". After fix: "Updated".
			expect(readTitle(updatedItem.item)).toBe("Updated");
		});

		it("content_get returns the latest draft data after update", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "Original" } },
			});
			const createdItem = extractJson<ItemEnvelope>(created);

			await harness.client.callTool({
				name: "content_update",
				arguments: {
					collection: "post",
					id: createdItem.item.id,
					data: { title: "Updated via draft" },
				},
			});

			const got = await harness.client.callTool({
				name: "content_get",
				arguments: { collection: "post", id: createdItem.item.id },
			});
			const gotItem = extractJson<ItemEnvelope>(got);

			expect(readTitle(gotItem.item)).toBe("Updated via draft");
		});

		it("multiple sequential updates all reflect on read", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "v1" } },
			});
			const id = extractJson<ItemEnvelope>(created).item.id;

			for (const title of ["v2", "v3", "v4"]) {
				await harness.client.callTool({
					name: "content_update",
					arguments: { collection: "post", id, data: { title } },
				});
			}

			const got = await harness.client.callTool({
				name: "content_get",
				arguments: { collection: "post", id },
			});
			expect(readTitle(extractJson<ItemEnvelope>(got).item)).toBe("v4");
		});

		it("publishing a draft makes its data the new live data on read", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "Original" } },
			});
			const id = extractJson<ItemEnvelope>(created).item.id;

			// Publish initial as live
			await harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id },
			});

			// Update creates a draft revision
			await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Draft change" } },
			});

			// Publish promotes draft to live
			await harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id },
			});

			const got = await harness.client.callTool({
				name: "content_get",
				arguments: { collection: "post", id },
			});
			expect(readTitle(extractJson<ItemEnvelope>(got).item)).toBe("Draft change");
		});

		it("partial updates merge with current draft (only title changes, body preserved)", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "T1", body: "B1" } },
			});
			const id = extractJson<ItemEnvelope>(created).item.id;

			await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "T2" } },
			});

			const got = await harness.client.callTool({
				name: "content_get",
				arguments: { collection: "post", id },
			});
			const item = extractJson<ItemEnvelope>(got).item;

			expect(readTitle(item)).toBe("T2");
			// Read body the same way
			const body =
				item.data && typeof item.data === "object" && "body" in item.data
					? // eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- shape narrowed by 'in' check
						(item.data as { body?: unknown }).body
					: (item as Record<string, unknown>).body;
			expect(body).toBe("B1");
		});
	});

	// ----- content_compare must still expose both sides -----

	describe("content_compare", () => {
		it("returns both live and draft data when a draft exists", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "Original" } },
			});
			const id = extractJson<ItemEnvelope>(created).item.id;

			// Publish, then update to create a draft on top of live
			await harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id },
			});
			await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Drafted" } },
			});

			const compare = await harness.client.callTool({
				name: "content_compare",
				arguments: { collection: "post", id },
			});
			expect(compare.isError, extractText(compare)).toBeFalsy();

			const result = extractJson<{
				live: { title?: unknown; data?: { title?: unknown } } | null;
				draft: { title?: unknown; data?: { title?: unknown } } | null;
				hasChanges?: boolean;
			}>(compare);

			expect(result.live).not.toBeNull();
			expect(result.draft).not.toBeNull();
			const liveTitle = result.live?.data?.title ?? result.live?.title;
			const draftTitle = result.draft?.data?.title ?? result.draft?.title;
			expect(liveTitle).toBe("Original");
			expect(draftTitle).toBe("Drafted");
		});
	});

	// ----- content_discard_draft -----

	describe("content_discard_draft", () => {
		it("after discard, content_get returns published live data", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "post", data: { title: "Live title" } },
			});
			const id = extractJson<ItemEnvelope>(created).item.id;

			await harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id },
			});
			await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "post", id, data: { title: "Draft title" } },
			});
			await harness.client.callTool({
				name: "content_discard_draft",
				arguments: { collection: "post", id },
			});

			const got = await harness.client.callTool({
				name: "content_get",
				arguments: { collection: "post", id },
			});
			expect(readTitle(extractJson<ItemEnvelope>(got).item)).toBe("Live title");
		});
	});

	// ----- regression guard: non-revision collection still works -----

	describe("non-revision-supporting collection (regression guard)", () => {
		it("content_update on collection without revisions support reflects on read", async () => {
			const created = await harness.client.callTool({
				name: "content_create",
				arguments: { collection: "page", data: { title: "Page A" } },
			});
			const id = extractJson<ItemEnvelope>(created).item.id;

			await harness.client.callTool({
				name: "content_update",
				arguments: { collection: "page", id, data: { title: "Page A Updated" } },
			});

			const got = await harness.client.callTool({
				name: "content_get",
				arguments: { collection: "page", id },
			});
			expect(readTitle(extractJson<ItemEnvelope>(got).item)).toBe("Page A Updated");
		});
	});
});

describe("MCP drafts — slug updates (bug #9)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("content_update with a new slug actually changes the slug visible on read", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Original" }, slug: "original-slug" },
		});
		const id = extractJson<ItemEnvelope>(created).item.id;

		await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, slug: "new-slug" },
		});

		// After publish, slug change should be visible.
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		expect(extractJson<ItemEnvelope>(got).item.slug).toBe("new-slug");
	});

	it("content_get by new slug works after slug update + publish", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" }, slug: "old" },
		});
		const id = extractJson<ItemEnvelope>(created).item.id;

		await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, slug: "new" },
		});
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});

		const gotByNew = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: "new" },
		});
		expect(gotByNew.isError, extractText(gotByNew)).toBeFalsy();
		expect(extractJson<ItemEnvelope>(gotByNew).item.id).toBe(id);
	});
});

describe("MCP drafts — revision_restore semantics (bug #17)", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("revision_restore replaces the current draft and the data is visible on read", async () => {
		// v1
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "v1" } },
		});
		const id = extractJson<ItemEnvelope>(created).item.id;

		// Publish v1, then update to v2 (creates draft revision)
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "v2" } },
		});
		// Publish v2
		await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});

		// List revisions and find the v1 revision
		const revs = await harness.client.callTool({
			name: "revision_list",
			arguments: { collection: "post", id },
		});
		const revData = extractJson<{
			items: Array<{ id: string; data?: { title?: unknown }; title?: unknown }>;
		}>(revs);
		const v1Rev = revData.items.find(
			(r) => (r.data?.title ?? r.title) === "v1" || (r.data?.title ?? r.title) === "v1",
		);
		expect(v1Rev).toBeTruthy();

		// Restore v1 — should make v1 the current draft
		const restored = await harness.client.callTool({
			name: "revision_restore",
			arguments: { collection: "post", id, revisionId: v1Rev!.id },
		});
		expect(restored.isError, extractText(restored)).toBeFalsy();

		// content_get should now reflect v1 in the visible data
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		expect(readTitle(extractJson<ItemEnvelope>(got).item)).toBe("v1");
	});
});
