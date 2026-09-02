import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { ContentSaveRejectedError } from "../../../src/plugins/save-rejection.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

function createDeps(sqlite: Database.Database): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({
			id: "editorial-gate:1.0.0",
			invokeHook: vi.fn().mockRejectedValue(new ContentSaveRejectedError("Posts need a summary")),
			invokeRoute: vi.fn(),
			terminate: vi.fn(),
		}),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};
	return {
		config: {
			database: {
				entrypoint: `test-sandboxed-before-save-throw-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: "editorial-gate",
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: ["content:read", "content:write"],
				allowedHosts: [],
				storage: {},
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- test fake matches the SandboxRunner shape sandboxed-plugin-route-meta.test.ts uses
		createSandboxRunner: (() => runner) as any,
	};
}

describe("content:beforeSave thrown from a sandboxed plugin", () => {
	let runtime: EmDashRuntime;

	afterEach(async () => {
		vi.restoreAllMocks();
		await runtime?.stopCron();
	});

	it("saves anyway and logs that a sandboxed plugin cannot cancel a save", async () => {
		runtime = await EmDashRuntime.create(createDeps(new Database(":memory:")));
		const registry = new SchemaRegistry(runtime.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await runtime.handleContentCreate("post", { data: { title: "Hi" } });

		expect(result.success).toBe(true);
		const rows = await new ContentRepository(runtime.db).findMany("post");
		expect(rows.items).toHaveLength(1);
		expect(logged).toHaveBeenCalledWith(
			expect.stringContaining("cannot cancel a save"),
			expect.any(ContentSaveRejectedError),
		);
	});
});
