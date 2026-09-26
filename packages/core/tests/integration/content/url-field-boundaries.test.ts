import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../../../src/astro/routes/api/content/[collection]/index.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	connectMcpHarness,
	createTestRuntime,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type RouteContext = Parameters<typeof POST>[0];

describe("URL field protocol boundaries", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "links", label: "Links" });
		await registry.createField("links", { slug: "website", label: "Website", type: "url" });
		harness = await connectMcpHarness({ db, userId: "admin-1", userRole: Role.ADMIN });
	});

	afterEach(async () => {
		await harness.cleanup();
		await teardownTestDatabase(db);
	});

	it("rejects a browser-normalized off-site path through the REST route", async () => {
		const runtime = createTestRuntime(db);
		const response = await POST({
			params: { collection: "links" },
			request: new Request("http://localhost/_emdash/api/content/links", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({ data: { website: "/\\evil.example/path" } }),
			}),
			locals: {
				emdash: runtime,
				user: { id: "admin-1", role: Role.ADMIN },
			},
		} as RouteContext);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
	});

	it("rejects a control-prefixed off-site path through the MCP tool", async () => {
		const result = await harness.client.callTool({
			name: "content_create",
			arguments: { collection: "links", data: { website: "\u0000//evil.example/path" } },
		});

		expect(result.isError).toBe(true);
		expect(extractText(result)).toContain("[VALIDATION_ERROR]");
	});
});
