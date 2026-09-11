/** Pins the startup warning for a configured sandbox runner that cannot run plugins. */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";

const REASON = "the worker has no worker_loaders binding named LOADER";

describe("EmDashRuntime — unavailable sandbox runner", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the reason the runner gives in the startup warning", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runner: SandboxRunner = {
			isAvailable: () => false,
			isHealthy: () => false,
			unavailableReason: () => REASON,
			load: () => Promise.reject(new Error("load is not reached")),
			setEmailSend: () => {},
			terminateAll: async () => {},
		};
		const deps: RuntimeDependencies = {
			config: {
				database: {
					entrypoint: `test-sandbox-unavailable-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			plugins: [],
			createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
			createStorage: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [],
			createSandboxRunner: () => runner,
		};

		const runtime = await EmDashRuntime.create(deps);
		try {
			const warnings = warn.mock.calls.map((call) => String(call[0]));
			expect(warnings).toContainEqual(
				expect.stringContaining(`not available on this platform: ${REASON}.`),
			);
		} finally {
			await runtime.stopCron();
		}
	});
});
