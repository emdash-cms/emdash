import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/admin/hooks/exclusive/index.js";
import { DEFAULT_COMMENT_MODERATOR_PLUGIN_ID } from "../../../src/comments/moderator.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";

interface ExclusiveHookItem {
	hookName: string;
	providers: Array<{ pluginId: string }>;
	selectedPluginId: string | null;
}

describe("GET /_emdash/api/admin/hooks/exclusive", () => {
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		const sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create({
			config: {
				database: {
					entrypoint: `test-exclusive-hooks-route-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			plugins: [],
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});
	});

	afterEach(async () => {
		await runtime?.shutdown();
	});

	it("reports the built-in comment moderator as selected when it is the only one", async () => {
		const response = await GET({
			locals: {
				emdash: { db: runtime.db, hooks: runtime.hooks },
				user: { id: "admin-1", role: Role.ADMIN },
			},
		} as unknown as Parameters<typeof GET>[0]);

		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { items: ExclusiveHookItem[] } };
		expect(data.items).toContainEqual({
			hookName: "comment:moderate",
			providers: [{ pluginId: DEFAULT_COMMENT_MODERATOR_PLUGIN_ID }],
			selectedPluginId: DEFAULT_COMMENT_MODERATOR_PLUGIN_ID,
		});
	});
});
