/**
 * MCP content_create — optional `seo` and `publishedAt` coverage.
 *
 * The MCP `content_create` tool's input schema omitted `seo` and `publishedAt`
 * even though the underlying handler already accepted them. Agents had to create
 * then immediately update to set SEO metadata, and the second step was often
 * skipped.
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
	isErrorResult,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_ID = "user_admin";
const AUTHOR_ID = "user_author";
const PAST = "2019-07-04T12:00:00.000Z";

describe("MCP content_create — seo and publishedAt options", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await new SchemaRegistry(db).updateCollection("post", { hasSeo: true });
		harness = await connectMcpHarness({ db, userId: ADMIN_ID, userRole: Role.ADMIN });
	});

	afterEach(async () => {
		if (harness) await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("persists SEO fields passed to content_create", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "SEO post" },
				seo: {
					title: "SEO Title",
					description: "SEO description goes here.",
					noIndex: true,
				},
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const item = extractJson<{
			item: {
				id: string;
				seo?: {
					title: string | null;
					description: string | null;
					noIndex: boolean;
				};
			};
		}>(result).item;

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "post", id: item.id },
		});
		const roundTrip = extractJson<{
			item: {
				seo?: {
					title: string | null;
					description: string | null;
					noIndex: boolean;
				};
			};
		}>(got).item;

		expect(roundTrip.seo?.title).toBe("SEO Title");
		expect(roundTrip.seo?.description).toBe("SEO description goes here.");
		expect(roundTrip.seo?.noIndex).toBe(true);
	});

	it("rejects SEO input on a collection without SEO enabled", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "page",
				data: { title: "Page" },
				seo: { title: "Should fail" },
			},
		});
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("VALIDATION_ERROR");
	});

	it("sets publishedAt on a draft create", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Backdated draft" },
				publishedAt: PAST,
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const item = extractJson<{ item: { status: string; publishedAt: string | null } }>(result).item;
		expect(item.status).toBe("draft");
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});

	it("publishes with an explicit publishedAt when status is published", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Published with backdate" },
				status: "published",
				publishedAt: PAST,
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const item = extractJson<{ item: { status: string; publishedAt: string | null } }>(result).item;
		expect(item.status).toBe("published");
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});

	it("requires content:publish_any to set publishedAt — AUTHOR is denied", async () => {
		await harness.cleanup();
		harness = await connectMcpHarness({ db, userId: AUTHOR_ID, userRole: Role.AUTHOR });

		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Author post" },
				publishedAt: PAST,
			},
		});
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("INSUFFICIENT_PERMISSIONS");
		expect(extractText(result).toLowerCase()).toContain("publish_any");
	});

	it("rejects a malformed publishedAt at the schema layer", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "T" },
				publishedAt: "last tuesday",
			},
		});
		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toContain("must be an ISO 8601 datetime");
	});

	it("applies SEO, publishedAt, and field data atomically in one call", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: "post",
				data: { title: "Atomic" },
				seo: { title: "Atomic SEO" },
				publishedAt: PAST,
			},
		});
		expect(result.isError, extractText(result)).toBeFalsy();

		const item = extractJson<{
			item: {
				id: string;
				status: string;
				publishedAt: string | null;
				seo?: { title: string | null };
			};
		}>(result).item;

		expect(item.status).toBe("draft");
		expect(item.seo?.title).toBe("Atomic SEO");
		expect(new Date(item.publishedAt!).toISOString()).toBe(PAST);
	});
});
