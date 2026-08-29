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
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";

interface ContentResult {
	item: { id: string; status: string; data: { title?: string } };
	_rev: string;
}

describe("MCP conditional content publication", () => {
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

	async function createDraft(title = "Draft"): Promise<ContentResult> {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "post", data: { title }, slug: title.toLowerCase() },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		return extractJson<ContentResult>(result);
	}

	async function createPublished(): Promise<ContentResult> {
		const created = await createDraft();
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: created.item.id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		return extractJson<ContentResult>(result);
	}

	async function update(id: string, rev: string, title: string): Promise<ContentResult> {
		const result = await harness.client.callTool({
			name: "content_update",
			arguments: { collection: "post", id, data: { title }, _rev: rev },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		return extractJson<ContentResult>(result);
	}

	it("M01 publishes with the current _rev", async () => {
		const created = await createDraft();
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: created.item.id, _rev: created._rev },
		});

		expect(result.isError, extractText(result)).toBeFalsy();
		expect(extractJson<ContentResult>(result).item.status).toBe("published");
	});

	it("M02 rejects a stale _rev after a newer draft save", async () => {
		const published = await createPublished();
		const approved = await update(published.item.id, published._rev, "Approved");
		await update(published.item.id, approved._rev, "Writer change");

		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: published.item.id, _rev: approved._rev },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/CONFLICT/);
	});

	it("M03 rejects content_unpublish with a stale _rev", async () => {
		const published = await createPublished();
		await update(published.item.id, published._rev, "Pending");

		const result = await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "post", id: published.item.id, _rev: published._rev },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/CONFLICT/);
	});

	it("M04 rejects content_discard_draft with a stale _rev", async () => {
		const published = await createPublished();
		await update(published.item.id, published._rev, "Pending");

		const result = await harness.client.callTool({
			name: "content_discard_draft",
			arguments: { collection: "post", id: published.item.id, _rev: published._rev },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/CONFLICT/);
	});

	it("M05 keeps revisionless publish backward compatible", async () => {
		const created = await createDraft();
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: created.item.id },
		});

		expect(result.isError, extractText(result)).toBeFalsy();
	});

	it("M06 rejects a caller without content:write even with a valid _rev", async () => {
		const created = await createDraft();
		const restricted = await connectMcpHarness({
			db,
			userId: ADMIN_ID,
			userRole: Role.ADMIN,
			tokenScopes: ["content:read"],
		});

		try {
			const result = await restricted.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id: created.item.id, _rev: created._rev },
			});
			expect(result.isError).toBe(true);
			expect(extractText(result)).toMatch(/scope|permission/i);
		} finally {
			await restricted.cleanup();
		}
	});

	it("M07 rejects a malformed _rev without publishing", async () => {
		const created = await createDraft();
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: created.item.id, _rev: "not-a-revision" },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toMatch(/CONFLICT/);
		const current = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: created.item.id },
		});
		expect(extractJson<ContentResult>(current).item.status).toBe("draft");
	});

	it("M08 returns a new _rev after publish", async () => {
		const created = await createDraft();
		const result = await harness.client.callTool({
			name: "content_publish",
			arguments: { collection: "post", id: created.item.id, _rev: created._rev },
		});
		const published = extractJson<ContentResult>(result);

		expect(published._rev).toBeTruthy();
		expect(published._rev).not.toBe(created._rev);
	});

	it("M09 allows only one concurrent publish for the same _rev", async () => {
		const created = await createDraft();
		const results = await Promise.all([
			harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id: created.item.id, _rev: created._rev },
			}),
			harness.client.callTool({
				name: "content_publish",
				arguments: { collection: "post", id: created.item.id, _rev: created._rev },
			}),
		]);

		expect(results.filter((result) => !result.isError)).toHaveLength(1);
		expect(
			results.filter((result) => result.isError && /CONFLICT/.test(extractText(result))),
		).toHaveLength(1);
	});
});
