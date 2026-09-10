import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import DatabaseDriver from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBackingServiceHandler } from "../../../../workerd/src/sandbox/backing-service.js";
import { WorkerdSandboxRunner } from "../../../../workerd/src/sandbox/runner.js";
import { POST as disablePlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/disable.js";
import { POST as enablePlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/enable.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { teardownTestDatabase } from "../../utils/test-db.js";

describe("sandboxed plugin authorization across admin status changes", () => {
	let runtime: EmDashRuntime;
	let runner: WorkerdSandboxRunner;
	let server: Server;
	let port: number;

	function token(pluginId = "policy-plugin"): string {
		const plugin = runner["plugins"].get(`${pluginId}:1.0.0`);
		if (!plugin) throw new Error(`Plugin ${pluginId} is not loaded`);
		return plugin.token;
	}

	function context(pluginId = "policy-plugin"): APIContext {
		return {
			params: { id: pluginId },
			locals: { emdash: runtime, user: { id: "admin-1", role: Role.ADMIN } },
			request: new Request(`http://example.test/_emdash/api/admin/plugins/${pluginId}`),
		} as unknown as APIContext;
	}

	async function bridgeStatus(authToken: string): Promise<number> {
		const response = await fetch(`http://127.0.0.1:${port}/kv/get`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${authToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ key: "health" }),
		});
		await response.text();
		return response.status;
	}

	beforeAll(async () => {
		const sqlite = new DatabaseDriver(":memory:");
		const db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: sqlite }),
		});
		await runMigrations(db);
		await db
			.insertInto("_plugin_state")
			.values({ plugin_id: "dormant-plugin", version: "1.0.0", status: "inactive" })
			.execute();
		await db
			.insertInto("options")
			.values({ name: "emdash:setup_complete", value: "true" })
			.execute();

		runtime = await EmDashRuntime.create({
			config: {
				database: {
					entrypoint: `test-sandboxed-plugin-authorization-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: ["policy-plugin", "dormant-plugin"].map((id) => ({
				id,
				version: "1.0.0",
				options: {},
				code: "export default {};",
				capabilities: [],
				allowedHosts: [],
				storage: {},
			})),
			createSandboxRunner: (options) => {
				runner = new WorkerdSandboxRunner(options);
				vi.spyOn(runner, "isAvailable").mockReturnValue(true);
				vi.spyOn(runner, "ensureRunning").mockResolvedValue();
				return runner;
			},
		});

		const backingService = createBackingServiceHandler(runner);
		runner["backingService"] = backingService;
		server = createServer(backingService.handler);
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("Backing service did not bind to a TCP port");
		}
		port = address.port;
	});

	afterAll(async () => {
		if (server?.listening) {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
		await runner?.terminateAll();
		await runtime?.stopCron();
		if (runtime) await teardownTestDatabase(runtime.db);
		vi.restoreAllMocks();
	});

	it("rejects backing-service access for a plugin disabled before cold boot", async () => {
		expect(await bridgeStatus(token("dormant-plugin"))).toBe(401);
		expect(await bridgeStatus(token())).toBe(200);
	});

	it("revokes credentials on admin disable and keeps them revoked after re-enable", async () => {
		const originalToken = token();
		expect(await bridgeStatus(originalToken)).toBe(200);

		expect((await disablePlugin(context())).status).toBe(200);
		expect.soft(await bridgeStatus(originalToken)).toBe(401);

		expect((await enablePlugin(context())).status).toBe(200);
		const reenabledToken = token();
		expect.soft(reenabledToken).not.toBe(originalToken);
		expect.soft(await bridgeStatus(originalToken)).toBe(401);
		expect(await bridgeStatus(reenabledToken)).toBe(200);

		expect((await enablePlugin(context())).status).toBe(200);
		expect(token()).toBe(reenabledToken);
	});

	it("revokes credentials even when the deactivate lifecycle hook rejects", async () => {
		const originalToken = token();
		const failure = new Error("Plugin cleanup failed");
		vi.spyOn(runtime.hooks, "runPluginDeactivate").mockRejectedValueOnce(failure);

		await expect(disablePlugin(context())).rejects.toThrow("Plugin cleanup failed");
		expect(await bridgeStatus(originalToken)).toBe(401);
	});
});
