import { Role } from "@emdash-cms/auth";
import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { definePlugin } from "../../src/plugins/define-plugin.js";
import { dispatchPluginEditorExtensionApiRequest } from "../../src/plugins/http-route-dispatch.js";
import { extractRequestMeta } from "../../src/plugins/request-meta.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { createTestRuntime } from "../utils/mcp-runtime.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const IP = "203.0.113.7";
const GEO = { country: "US", region: "CA", city: "Los Angeles" };
const USER_AGENT = "request-meta-test/1.0";
const REFERER = "https://example.test/editor";

type Captured = {
	input: unknown;
	requestMeta: unknown;
	headers: Record<string, string | null>;
};

function request(url: string, withCf: boolean, body = "{}"): Request {
	const init = {
		method: "POST",
		headers: {
			"cf-connecting-ip": IP,
			"x-forwarded-for": IP,
			"user-agent": USER_AGENT,
			referer: REFERER,
			"content-type": "application/json",
			"content-length": "999",
			"content-encoding": "gzip",
		},
		body,
	};
	if (!withCf) return new Request(url, init);
	return new Request(url, { ...init, cf: GEO } as RequestInit & { cf: typeof GEO });
}

function plugin(captured: { current: Captured | null }) {
	return definePlugin({
		id: "request-meta-test",
		version: "1.0.0",
		capabilities: [],
		routes: {
			capture: {
				request: { body: "json" },
				permission: "plugins:manage",
				input: z.unknown(),
				handler: async (ctx) => {
					captured.current = {
						input: ctx.input,
						requestMeta: ctx.requestMeta,
						headers: {
							contentLength: ctx.request.headers.get("content-length"),
							contentEncoding: ctx.request.headers.get("content-encoding"),
							userAgent: ctx.request.headers.get("user-agent"),
							referer: ctx.request.headers.get("referer"),
						},
					};
					return ctx.ui?.surface === "content-editor-action" ? { refresh: true } : { blocks: [] };
				},
			},
		},
		mcp: {
			tools: {
				capture: {
					description: "Capture request metadata",
					route: "capture",
					input: z.object({ value: z.string() }),
				},
			},
		},
		admin: {
			editorPanels: [{ id: "panel", title: "Panel", route: "capture", collections: ["pages"] }],
			editorActions: [
				{
					id: "action",
					label: "Action",
					route: "capture",
					placement: "toolbar",
					collections: ["pages"],
				},
			],
		},
	});
}

let db: Kysely<Database>;
let entryId: string;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

afterAll(async () => {
	await db.destroy();
});

describe("plugin route requestMeta on Cloudflare", () => {
	beforeEach(async () => {
		await resetD1Schema(db);
		await runMigrations(db);
		const schema = new SchemaRegistry(db);
		await schema.createCollection({ slug: "pages", label: "Pages" });
		const runtime = createTestRuntime(db);
		const created = await runtime.handleContentCreate("pages", { slug: "page-1", data: {} });
		expect(created.success).toBe(true);
		entryId = created.success ? created.data.item.id : "";
	});

	for (const kind of ["mcp", "panel", "action"] as const) {
		for (const withCf of [true, false]) {
			it(`${kind} preserves metadata with ${withCf ? "CF" : "no CF"}`, async () => {
				const captured = { current: null as Captured | null };
				const runtime = createTestRuntime(db, { plugins: [plugin(captured)] });
				const original = request("https://example.test/_emdash/api/mcp", withCf);
				const expectedMeta = extractRequestMeta(original);
				expect(expectedMeta).toMatchObject({
					ip: withCf ? IP : null,
					geo: withCf ? GEO : null,
					userAgent: USER_AGENT,
					referer: REFERER,
				});

				if (kind === "mcp") {
					const result = await runtime.handlePluginMcpTool(
						"request-meta-test",
						"capture",
						"capture",
						{ value: "mcp" },
						"actor",
						original,
					);
					expect(result.success).toBe(true);
					expect(captured.current).toMatchObject({
						input: { value: "mcp" },
						requestMeta: expectedMeta,
						headers: {
							contentLength: null,
							contentEncoding: null,
							userAgent: USER_AGENT,
							referer: REFERER,
						},
					});
					return;
				}

				const editorRequest = request(
					`https://example.test/_emdash/api/content/pages/${entryId}/plugin-extensions/request-meta-test/${kind}/${kind}`,
					withCf,
					JSON.stringify(kind === "panel" ? { type: "panel_load" } : {}),
				);
				const response = await dispatchPluginEditorExtensionApiRequest({
					runtime,
					pluginId: "request-meta-test",
					kind,
					extensionId: kind,
					collection: "pages",
					entryId,
					request: editorRequest,
					user: {
						id: "admin",
						email: "admin@example.test",
						name: "Admin",
						role: Role.ADMIN,
						createdAt: "2026-01-01T00:00:00.000Z",
					},
					tokenScopes: ["admin"],
				});
				expect(response.ok).toBe(true);
				expect(await response.json()).toMatchObject({
					success: true,
					data: kind === "panel" ? { blocks: [] } : { refresh: true },
				});
				expect(captured.current).toMatchObject({
					input: kind === "panel" ? { type: "panel_load" } : { type: "editor_action" },
					requestMeta: expectedMeta,
					headers: {
						contentLength: null,
						contentEncoding: null,
						userAgent: USER_AGENT,
						referer: REFERER,
					},
				});
			});
		}
	}
});
