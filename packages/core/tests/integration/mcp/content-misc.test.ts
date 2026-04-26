/**
 * MCP content tools — coverage for the remaining tools and edges.
 *
 * Covers:
 *   - content_duplicate
 *   - content_permanent_delete
 *   - content_translations + locale handling on create/get
 *   - _rev optimistic concurrency (happy + race)
 *   - Soft-delete visibility (content_get / content_list filtering)
 *   - Edit-while-trashed
 *   - Idempotency (publish twice, unpublish-on-draft, schedule + publish)
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

// ---------------------------------------------------------------------------
// content_duplicate
// ---------------------------------------------------------------------------

describe("content_duplicate", () => {
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

	it("creates a copy with new id and slug", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Original" }, slug: "original" },
		});
		const original = extractJson<{ item: { id: string; slug: string } }>(created).item;

		const dup = await harness.client.callTool({
			name: "content_duplicate",
			arguments: { collection: "post", id: original.id },
		});
		expect(dup.isError, extractText(dup)).toBeFalsy();
		const copy = extractJson<{ item: { id: string; slug: string; status: string } }>(dup).item;

		expect(copy.id).not.toBe(original.id);
		expect(copy.slug).not.toBe(original.slug);
		// Created as draft per tool description
		expect(copy.status).toBe("draft");
	});

	it("rejects duplicating a missing item", async () => {
		const result = await harness.client.callTool({
			name: "content_duplicate",
			arguments: { collection: "post", id: "01NEVER" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
	});

	it("rejects duplicating in non-existent collection", async () => {
		const result = await harness.client.callTool({
			name: "content_duplicate",
			arguments: { collection: "ghost", id: "01NEVER" },
		});
		expect(result.isError).toBe(true);
	});

	it("requires CONTRIBUTOR or higher", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({
			db,
			userId: "user_subscriber",
			userRole: Role.SUBSCRIBER,
		});
		const result = await harness.client.callTool({
			name: "content_duplicate",
			arguments: { collection: "post", id: "01ANY" },
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// content_permanent_delete
// ---------------------------------------------------------------------------

describe("content_permanent_delete", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	async function seedTrashedItem(): Promise<string> {
		const repo = new ContentRepository(db);
		const item = await repo.create({
			type: "post",
			data: { title: "T" },
			slug: `t-${Math.random().toString(36).slice(2, 6)}`,
			status: "draft",
			authorId: ADMIN_ID,
		});
		await repo.delete("post", item.id);
		return item.id;
	}

	it("permanently deletes a trashed item (ADMIN)", async () => {
		const id = await seedTrashedItem();
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const result = await harness.client.callTool({
			name: "content_permanent_delete",
			arguments: { collection: "post", id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		// Verify it's gone — not even in trash
		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		expect(got.isError).toBe(true);
	});

	it("EDITOR cannot permanent-delete (ADMIN-only)", async () => {
		const id = await seedTrashedItem();
		harness = await connectMcpHarness({ db, userId: "user_editor", userRole: Role.EDITOR });

		const result = await harness.client.callTool({
			name: "content_permanent_delete",
			arguments: { collection: "post", id },
		});
		expect(result.isError).toBe(true);
	});

	it("returns NOT_FOUND for missing id", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "content_permanent_delete",
			arguments: { collection: "post", id: "01NEVEREXISTED" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
		expect(extractText(result)).toContain("01NEVEREXISTED");
	});
});

// ---------------------------------------------------------------------------
// content_translations + locale handling
// ---------------------------------------------------------------------------

describe("content_translations + locale", () => {
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

	it("creates a translation linked via translationOf", async () => {
		const en = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Hello" }, locale: "en" },
		});
		const enId = extractJson<{ item: { id: string } }>(en).item.id;

		const fr = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: enId,
			},
		});
		expect(fr.isError, extractText(fr)).toBeFalsy();

		const trans = await harness.client.callTool({
			name: "content_translations",
			arguments: { collection: "post", id: enId },
		});
		expect(trans.isError, extractText(trans)).toBeFalsy();
		const data = extractJson<{
			translations: Array<{ id: string; locale: string }>;
		}>(trans);
		const locales = data.translations.map((t) => t.locale).toSorted();
		expect(locales).toEqual(["en", "fr"]);
	});

	it("returns single-locale translations array for content with no other translations", async () => {
		const en = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Standalone" }, locale: "en" },
		});
		const id = extractJson<{ item: { id: string } }>(en).item.id;

		const result = await harness.client.callTool({
			name: "content_translations",
			arguments: { collection: "post", id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{ translations: unknown[] }>(result);
		expect(data.translations.length).toBeGreaterThanOrEqual(1);
	});

	it("content_get with locale param resolves slug per-locale", async () => {
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "EN" }, slug: "shared", locale: "en" },
		});
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "FR" }, slug: "shared", locale: "fr" },
		});

		const en = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: "shared", locale: "en" },
		});
		expect(en.isError, extractText(en)).toBeFalsy();
		const fr = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: "shared", locale: "fr" },
		});
		expect(fr.isError, extractText(fr)).toBeFalsy();

		const enItem = extractJson<{
			item: { locale: string; data?: { title?: unknown }; title?: unknown };
		}>(en).item;
		const frItem = extractJson<{
			item: { locale: string; data?: { title?: unknown }; title?: unknown };
		}>(fr).item;
		const enTitle = enItem.data?.title ?? enItem.title;
		const frTitle = frItem.data?.title ?? frItem.title;
		expect(enTitle).toBe("EN");
		expect(frTitle).toBe("FR");
	});

	it("rejects translationOf pointing to a non-existent item", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Orphan" },
				locale: "fr",
				translationOf: "01NEVEREXISTED",
			},
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// _rev optimistic concurrency
// ---------------------------------------------------------------------------

describe("_rev optimistic concurrency", () => {
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

	it("content_get returns a _rev token", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const data = extractJson<{ item: { id: string }; _rev?: string }>(got);
		expect(data._rev).toBeTruthy();
	});

	it("content_update with current _rev succeeds", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Original" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const rev = extractJson<{ _rev: string }>(got)._rev;

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "Updated" }, _rev: rev },
		});
		expect(updated.isError, extractText(updated)).toBeFalsy();
	});

	it("content_update with stale _rev returns CONFLICT-style error", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Original" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const oldRev = extractJson<{ _rev: string }>(got)._rev;

		// First update: succeeds and bumps the rev
		await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "Update 1" }, _rev: oldRev },
		});

		// Second update with stale rev: should conflict
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "Update 2" }, _rev: oldRev },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/conflict|stale|outdated|modified|rev/i);
	});

	it("content_update without _rev still succeeds (opt-in concurrency)", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "U" } },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// Soft-delete visibility
// ---------------------------------------------------------------------------

describe("soft-delete visibility", () => {
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

	it("content_get on a trashed item returns NOT_FOUND (not the item)", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id },
		});

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		expect(got.isError).toBe(true);
		expect(extractText(got)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
	});

	it("content_list does NOT include trashed items by default", async () => {
		const a = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Live" } },
		});
		const b = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Trashed" } },
		});
		const trashedId = extractJson<{ item: { id: string } }>(b).item.id;

		await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id: trashedId },
		});

		const list = await harness.client.callTool({
			name: "content_list",
			arguments: { collection: "post" },
		});
		const ids = extractJson<{ items: Array<{ id: string }> }>(list).items.map((i) => i.id);
		expect(ids).not.toContain(trashedId);
		expect(ids).toContain(extractJson<{ item: { id: string } }>(a).item.id);
	});

	it("content_list_trashed returns only trashed items", async () => {
		await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Live" } },
		});
		const b = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Trashed" } },
		});
		await harness.client.callTool({
			name: "content_delete",
			arguments: {
				collection: "post",
				id: extractJson<{ item: { id: string } }>(b).item.id,
			},
		});

		const trashed = await harness.client.callTool({
			name: "content_list_trashed",
			arguments: { collection: "post" },
		});
		const items = extractJson<{ items: Array<{ id: string }> }>(trashed).items;
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe(extractJson<{ item: { id: string } }>(b).item.id);
	});
});

describe("edit-while-trashed", () => {
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

	it("content_update on a trashed item is rejected (item not visible)", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id },
		});

		const updated = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title: "Edit while dead" } },
		});
		expect(updated.isError).toBe(true);
		expect(extractText(updated)).toMatch(/\bNOT_FOUND\b|\bnot found\b|trash/i);
	});

	it("content_publish on a trashed item is rejected", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id },
		});

		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		expect(result.isError).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
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

	it("publish twice is idempotent: second call succeeds, status stays published, publishedAt is preserved", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const first = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		expect(first.isError, extractText(first)).toBeFalsy();
		const firstItem = extractJson<{
			item: { status: string; publishedAt: string | null };
		}>(first).item;
		expect(firstItem.status).toBe("published");
		expect(firstItem.publishedAt).toBeTruthy();

		// Wait briefly so a regression that reassigns publishedAt would produce
		// a distinguishable timestamp.
		await new Promise((r) => setTimeout(r, 5));

		const second = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		// Contract: publish is idempotent. Second call succeeds, status
		// remains published, and publishedAt is preserved (the repository
		// uses COALESCE so the original timestamp survives a re-publish).
		expect(second.isError, extractText(second)).toBeFalsy();
		const secondItem = extractJson<{
			item: { status: string; publishedAt: string | null };
		}>(second).item;
		expect(secondItem.status).toBe("published");
		expect(secondItem.publishedAt).toBe(firstItem.publishedAt);
	});

	it("unpublish on a draft (already unpublished) is idempotent: status stays draft", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// Item is born as draft. Contract: unpublish is idempotent — succeeds
		// and the item stays draft.
		const result = await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "post", id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const item = extractJson<{ item: { status: string; publishedAt: string | null } }>(result).item;
		expect(item.status).toBe("draft");
		expect(item.publishedAt).toBeNull();
	});

	it("schedule then publish: schedule is preserved or cleared cleanly", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const future = new Date(Date.now() + 3600_000).toISOString();
		await harness.client.callTool({
			name: "content_schedule",
			arguments: { collection: "post", id, scheduledAt: future },
		});

		const publish = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		expect(publish.isError, extractText(publish)).toBeFalsy();

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{
			item: { status: string; scheduledAt: string | null };
		}>(got).item;
		expect(item.status).toBe("published");
		// Once published, the future schedule is moot — should be cleared.
		expect(item.scheduledAt).toBeNull();
	});

	it("delete twice is safe — second call returns NOT_FOUND, not a crash", async () => {
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "T" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id },
		});
		const second = await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id },
		});
		expect(second.isError).toBe(true);
		expect(extractText(second)).toMatch(/\bNOT_FOUND\b|\bnot found\b/i);
	});
});

// ---------------------------------------------------------------------------
// content_unschedule gap (no MCP tool for this, only on runtime)
// ---------------------------------------------------------------------------

describe("content_unschedule gap", () => {
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

	it("MCP exposes content_unschedule", async () => {
		const tools = await harness.client.listTools();
		const names = tools.tools.map((t) => t.name);
		expect(names).toContain("content_unschedule");
	});

	it("schedule + unschedule clears scheduledAt and re-publish still works (F12)", async () => {
		// Create a draft item.
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title: "Scheduled post" } },
		});
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		// Schedule for the near future.
		const future = new Date(Date.now() + 60_000).toISOString();
		const schedule = await harness.client.callTool({
			name: "content_schedule",
			arguments: { collection: "post", id, scheduledAt: future },
		});
		expect(schedule.isError, extractText(schedule)).toBeFalsy();

		// Sanity: scheduledAt is set.
		const afterSchedule = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const scheduled = extractJson<{ item: { scheduledAt: string | null; status: string } }>(
			afterSchedule,
		).item;
		expect(scheduled.scheduledAt).toBeTruthy();

		// Unschedule.
		const unschedule = await harness.client.callTool({
			name: "content_unschedule",
			arguments: { collection: "post", id },
		});
		expect(unschedule.isError, extractText(unschedule)).toBeFalsy();

		// scheduledAt is now null.
		const afterUnschedule = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const cleared = extractJson<{ item: { scheduledAt: string | null } }>(afterUnschedule).item;
		expect(cleared.scheduledAt).toBeNull();

		// Re-publish still works after unschedule.
		const republish = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id },
		});
		expect(republish.isError, extractText(republish)).toBeFalsy();
		const final = extractJson<{ item: { status: string } }>(republish).item;
		expect(final.status).toBe("published");
	});
});
