/**
 * MCP byline tools + content_create byline attachment.
 *
 * Covers the byline CRUD tools (byline_list/get/create/update/delete/
 * translations) and the new `bylines` argument on content_create, which
 * forwards to the same setContentBylines path content_update already used.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	isErrorResult,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const AUTHOR_ID = "user_author";

interface Byline {
	id: string;
	slug: string;
	displayName: string;
	isGuest: boolean;
	websiteUrl: string | null;
}

describe("MCP byline tools", () => {
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

	async function createByline(slug: string, displayName: string): Promise<Byline> {
		const result = await harness.client.callTool({
			name: "byline_create",
			arguments: { slug, displayName, isGuest: true },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		return extractJson<Byline>(result);
	}

	it("creates, gets, lists, updates and deletes a byline", async () => {
		const created = await createByline("jane-doe", "Jane Doe");
		expect(created.slug).toBe("jane-doe");
		expect(created.displayName).toBe("Jane Doe");

		const got = await harness.client.callTool({
			name: "byline_get",
			arguments: { id: created.id },
		});
		expect(extractJson<Byline>(got).displayName).toBe("Jane Doe");

		const listed = await harness.client.callTool({
			name: "byline_list",
			arguments: { search: "Jane" },
		});
		const items = extractJson<{ items: Byline[] }>(listed).items;
		expect(items.some((b) => b.id === created.id)).toBe(true);

		const updated = await harness.client.callTool({
			name: "byline_update",
			arguments: { id: created.id, displayName: "Jane Q. Doe" },
		});
		expect(extractJson<Byline>(updated).displayName).toBe("Jane Q. Doe");

		const deleted = await harness.client.callTool({
			name: "byline_delete",
			arguments: { id: created.id },
		});
		expect(extractJson<{ deleted: string }>(deleted).deleted).toBe(created.id);

		const gone = await harness.client.callTool({
			name: "byline_get",
			arguments: { id: created.id },
		});
		expect(isErrorResult(gone)).toBe(true);
		expect(extractText(gone)).toContain("NOT_FOUND");
	});

	it("rejects a non-http websiteUrl (httpUrl validation preserved)", async () => {
		const result = await harness.client.callTool({
			name: "byline_create",
			arguments: { slug: "evil", displayName: "Evil", websiteUrl: "javascript:alert(1)" },
		});
		expect(isErrorResult(result)).toBe(true);
	});

	it("byline_delete on a missing id returns NOT_FOUND", async () => {
		const result = await harness.client.callTool({
			name: "byline_delete",
			arguments: { id: "does-not-exist" },
		});
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("NOT_FOUND");
	});

	it("denies byline_create to an AUTHOR (below EDITOR)", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

		const result = await harness.client.callTool({
			name: "byline_create",
			arguments: { slug: "no-go", displayName: "No Go", isGuest: true },
		});
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("INSUFFICIENT_PERMISSIONS");
	});

	it("byline_translations returns the byline's own translation group", async () => {
		const jane = await createByline("jane-tr", "Jane Tr");
		const result = await harness.client.callTool({
			name: "byline_translations",
			arguments: { id: jane.id },
		});
		expect(result.isError, extractText(result)).toBeFalsy();
		const items = extractJson<{ items: Byline[] }>(result).items;
		expect(items.some((b) => b.id === jane.id)).toBe(true);
	});

	it("content_create attaches bylines on the publish path", async () => {
		const jane = await createByline("jane-pub", "Jane Pub");
		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Published with byline" },
				status: "published",
				bylines: [{ bylineId: jane.id }],
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{ item: { status: string; primaryBylineId: string | null } }>(
			got,
		).item;
		expect(item.status).toBe("published");
		expect(item.primaryBylineId).toBe(jane.id);
	});

	it("content_create attaches bylines and sets the primary", async () => {
		const jane = await createByline("jane-author", "Jane Author");
		const john = await createByline("john-editor", "John Editor");

		const created = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Co-authored" },
				bylines: [
					{ bylineId: jane.id, roleLabel: "Author" },
					{ bylineId: john.id, roleLabel: "Editor" },
				],
			},
		});
		expect(created.isError, extractText(created)).toBeFalsy();
		const id = extractJson<{ item: { id: string } }>(created).item.id;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id },
		});
		const item = extractJson<{
			item: {
				primaryBylineId: string | null;
				bylines?: Array<{ byline: { id: string }; roleLabel: string | null }>;
			};
		}>(got).item;

		expect(item.primaryBylineId).toBe(jane.id);
		expect(item.bylines).toHaveLength(2);
		expect(item.bylines?.[0]?.byline.id).toBe(jane.id);
		expect(item.bylines?.[0]?.roleLabel).toBe("Author");
		expect(item.bylines?.[1]?.byline.id).toBe(john.id);
	});
});
