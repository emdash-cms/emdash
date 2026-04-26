/**
 * MCP media tools — comprehensive integration tests.
 *
 * Covers:
 *   - media_list (incl. mimeType filter, pagination)
 *   - media_get
 *   - media_update (incl. ownership)
 *   - media_delete (incl. ownership)
 *
 * Plus regression for bug #14 (no media_upload tool gap) and bug #1
 * variants for media (the MCP code already handles null authorId
 * correctly for media — `media_update`/`media_delete` use `... || ""`,
 * unlike content extraction).
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
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
const OTHER_AUTHOR_ID = "user_other_author";
const SUBSCRIBER_ID = "user_subscriber";

async function seedMedia(
	db: Kysely<Database>,
	overrides: Partial<{
		filename: string;
		mimeType: string;
		size: number;
		authorId: string | null;
	}> = {},
): Promise<string> {
	const repo = new MediaRepository(db);
	const item = await repo.create({
		filename: overrides.filename ?? `file-${Math.random().toString(36).slice(2, 8)}.png`,
		mimeType: overrides.mimeType ?? "image/png",
		size: overrides.size ?? 1024,
		storageKey: `media/${Math.random().toString(36).slice(2, 10)}`,
		...(overrides.authorId !== null ? { authorId: overrides.authorId ?? ADMIN_ID } : {}),
	});
	return item.id;
}

// ---------------------------------------------------------------------------
// media_list
// ---------------------------------------------------------------------------

describe("media_list", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns empty list when no media exists", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_list",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const { items } = extractJson<{ items: unknown[] }>(result);
		expect(items).toEqual([]);
	});

	it("lists all uploaded media", async () => {
		await seedMedia(db);
		await seedMedia(db);
		await seedMedia(db);

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_list",
			arguments: {},
		});
		const { items } = extractJson<{ items: unknown[] }>(result);
		expect(items).toHaveLength(3);
	});

	it("filters by mimeType prefix", async () => {
		await seedMedia(db, { mimeType: "image/png" });
		await seedMedia(db, { mimeType: "image/jpeg" });
		await seedMedia(db, { mimeType: "application/pdf" });

		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_list",
			arguments: { mimeType: "image/" },
		});
		const { items } = extractJson<{ items: Array<{ mimeType: string }> }>(result);
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.mimeType.startsWith("image/")).toBe(true);
		}
	});

	it("paginates with cursor", async () => {
		for (let i = 0; i < 5; i++) await seedMedia(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const page1 = await harness.client.callTool({
			name: "media_list",
			arguments: { limit: 2 },
		});
		const p1 = extractJson<{ items: Array<{ id: string }>; nextCursor?: string }>(page1);
		expect(p1.items).toHaveLength(2);
		expect(p1.nextCursor).toBeTruthy();

		const page2 = await harness.client.callTool({
			name: "media_list",
			arguments: { limit: 2, cursor: p1.nextCursor },
		});
		const p2 = extractJson<{ items: Array<{ id: string }> }>(page2);
		expect(p2.items).toHaveLength(2);

		const p1Ids = p1.items.map((i) => i.id);
		for (const item of p2.items) expect(p1Ids).not.toContain(item.id);
	});

	it("any logged-in user can list media", async () => {
		await seedMedia(db);
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "media_list",
			arguments: {},
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// media_get
// ---------------------------------------------------------------------------

describe("media_get", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("returns full media metadata", async () => {
		const id = await seedMedia(db, {
			filename: "logo.png",
			mimeType: "image/png",
			size: 2048,
		});
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const result = await harness.client.callTool({
			name: "media_get",
			arguments: { id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{
			item: { id: string; filename: string; mimeType: string; size: number };
		}>(result);
		expect(data.item.id).toBe(id);
		expect(data.item.filename).toBe("logo.png");
		expect(data.item.mimeType).toBe("image/png");
		expect(data.item.size).toBe(2048);
	});

	it("returns NOT_FOUND for missing id", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_get",
			arguments: { id: "01NOTAMEDIAID" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/not.found|01NOTAMEDIAID/i);
	});

	it("any logged-in user can get media", async () => {
		const id = await seedMedia(db);
		harness = await connectMcpHarness({ db, userId: SUBSCRIBER_ID, userRole: Role.SUBSCRIBER });
		const result = await harness.client.callTool({
			name: "media_get",
			arguments: { id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});
});

// ---------------------------------------------------------------------------
// media_update
// ---------------------------------------------------------------------------

describe("media_update", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("updates alt text and caption", async () => {
		const id = await seedMedia(db, { authorId: ADMIN_ID });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, alt: "Logo image", caption: "Brand logo" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{ item: { alt: string; caption: string } }>(result);
		expect(data.item.alt).toBe("Logo image");
		expect(data.item.caption).toBe("Brand logo");
	});

	it("updates dimensions", async () => {
		const id = await seedMedia(db);
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, width: 1920, height: 1080 },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const data = extractJson<{ item: { width: number; height: number } }>(result);
		expect(data.item.width).toBe(1920);
		expect(data.item.height).toBe(1080);
	});

	it("AUTHOR can update their own media", async () => {
		const id = await seedMedia(db, { authorId: AUTHOR_ID });
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, alt: "Mine" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("AUTHOR cannot update another user's media", async () => {
		const id = await seedMedia(db, { authorId: OTHER_AUTHOR_ID });
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, alt: "Theirs" },
		});
		expect(result.isError).toBe(true);
	});

	it("EDITOR can update any user's media", async () => {
		const id = await seedMedia(db, { authorId: OTHER_AUTHOR_ID });
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, alt: "Editor override" },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("ADMIN can update media with null authorId (regression: this works for media but not content — bug #1 inconsistency)", async () => {
		const id = await seedMedia(db, { authorId: null });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, alt: "No author" },
		});
		// Already works correctly for media — confirms the fix path for
		// content (use `... || ""` instead of throwing).
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("AUTHOR cannot update media with null authorId (no ownership claim)", async () => {
		const id = await seedMedia(db, { authorId: null });
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id, alt: "Should fail" },
		});
		expect(result.isError).toBe(true);
	});

	it("returns NOT_FOUND-style error for missing id", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_update",
			arguments: { id: "01NEVEREXISTED", alt: "x" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/not.found|01NEVEREXISTED/i);
	});
});

// ---------------------------------------------------------------------------
// media_delete
// ---------------------------------------------------------------------------

describe("media_delete", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("deletes a media item", async () => {
		const id = await seedMedia(db, { authorId: ADMIN_ID });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		const result = await harness.client.callTool({
			name: "media_delete",
			arguments: { id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		// Verify it's gone
		const got = await harness.client.callTool({
			name: "media_get",
			arguments: { id },
		});
		expect(got.isError).toBe(true);
	});

	it("AUTHOR cannot delete another user's media", async () => {
		const id = await seedMedia(db, { authorId: OTHER_AUTHOR_ID });
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });
		const result = await harness.client.callTool({
			name: "media_delete",
			arguments: { id },
		});
		expect(result.isError).toBe(true);
	});

	it("EDITOR can delete any user's media", async () => {
		const id = await seedMedia(db, { authorId: OTHER_AUTHOR_ID });
		harness = await connectMcpHarness({ db, userId: EDITOR_ID, userRole: Role.EDITOR });
		const result = await harness.client.callTool({
			name: "media_delete",
			arguments: { id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("returns NOT_FOUND for missing id", async () => {
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
		const result = await harness.client.callTool({
			name: "media_delete",
			arguments: { id: "01NOPE" },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/not.found|01NOPE/i);
	});

	it("delete is idempotent — second delete on same id returns NOT_FOUND, not crash", async () => {
		const id = await seedMedia(db, { authorId: ADMIN_ID });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });

		await harness.client.callTool({ name: "media_delete", arguments: { id } });
		const result = await harness.client.callTool({
			name: "media_delete",
			arguments: { id },
		});
		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/not.found/i);
	});
});

// ---------------------------------------------------------------------------
// Bug #14 — gap: no media_upload / media_create tool
// ---------------------------------------------------------------------------

describe("media tooling gaps (bug #14)", () => {
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

	it("MCP exposes media_upload (or media_create) once the gap is filled", async () => {
		const tools = await harness.client.listTools();
		const names = new Set(tools.tools.map((t) => t.name));
		// Today: missing — agents can read/update/delete but cannot create.
		// After fix: at least one of these names is present.
		const hasUpload = names.has("media_upload") || names.has("media_create");
		expect(hasUpload).toBe(true);
	});
});
