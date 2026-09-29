/** The editor toolbar, whose render reads the preview secret, renders only for HTML responses. */
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import onRequest from "../../../src/astro/middleware/request-context.js";
import { _clearSecretsCacheForTesting } from "../../../src/config/secrets.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";

const EDITOR = { id: "u1", role: 30 };

let db: Kysely<DatabaseSchema>;
let queries: string[] = [];

function editorContext(pathname: string, editCookie = false) {
	const url = new URL(`https://example.com${pathname}`);
	return {
		request: new Request(url),
		url,
		cookies: {
			get: vi.fn((name: string) =>
				name === "emdash-edit-mode" && editCookie ? { value: "true" } : undefined,
			),
			set: vi.fn(),
		},
		locals: { user: EDITOR, emdash: { db } },
		cache: { set: vi.fn() },
	} as unknown as Parameters<typeof onRequest>[0];
}

describe("editor toolbar by response content type", () => {
	beforeEach(async () => {
		_clearSecretsCacheForTesting();
		db = new Kysely<DatabaseSchema>({
			dialect: new SqliteDialect({ database: new Database(":memory:") }),
			log(event) {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});
		await runMigrations(db);
		queries = [];
	});

	afterEach(async () => {
		_clearSecretsCacheForTesting();
		await db.destroy();
	});

	it.each([
		["/_image?href=%2Fphoto.jpg&w=640", "image/webp"],
		["/rss.xml", "application/rss+xml; charset=utf-8"],
		["/api/data.json", "application/json"],
	])("runs no database query for %s", async (pathname, contentType) => {
		for (const editCookie of [false, true]) {
			const response = await onRequest(
				editorContext(pathname, editCookie),
				async () => new Response("payload", { headers: { "content-type": contentType } }),
			);
			expect(await response.text()).toBe("payload");
			expect(response.headers.get("Cache-Control")).toBeNull();
		}
		expect(queries).toEqual([]);
	});

	it("injects a signed toolbar into an editor's HTML page", async () => {
		const response = await onRequest(
			editorContext("/blog"),
			async () =>
				new Response("<html><body>hello</body></html>", {
					headers: { "content-type": "text/html" },
				}),
		);

		const html = await response.text();
		expect(html).toContain('id="emdash-toolbar"');
		expect(html).toMatch(/var visualActionToken = "[^"]+";/);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});
});
