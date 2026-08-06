/**
 * Manifest sandbox-availability probing.
 *
 * Regression: `getManifest()` reports `sandboxAvailable` by asking the sandbox
 * runner whether it's available. `SandboxRunner.isAvailable()` is cheap on
 * Cloudflare but on Node's workerd runner it spawns `workerd --version`
 * synchronously. The manifest is built per admin request, so probing on every
 * call would stall the Node event loop on a hot path. Availability is
 * process-stable, so the runtime must probe at most once and memoize.
 *
 * This test drives the real cold-boot path with a fake runner whose
 * `isAvailable()` is spied, then asserts repeated `getManifest()` calls do not
 * re-probe.
 */

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";

function createDeps(
	createSandboxRunner: RuntimeDependencies["createSandboxRunner"],
): RuntimeDependencies {
	return {
		config: {
			database: {
				// Unique entrypoint so the module-level dbCache never serves a
				// stale instance across tests.
				entrypoint: `test-manifest-sandbox-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [],
		createSandboxRunner,
	};
}

describe("EmDashRuntime.getManifest — sandbox availability", () => {
	it("probes the runner at most once across repeated manifest builds", async () => {
		const isAvailable = vi.fn(() => true);
		const fakeRunner: SandboxRunner = {
			isAvailable,
			isHealthy: () => true,
			load: () => Promise.reject(new Error("not used in this test")),
			setEmailSend: () => {},
			terminateAll: () => Promise.resolve(),
		};

		const runtime = await EmDashRuntime.create(createDeps(() => fakeRunner));
		try {
			const probesAfterCreate = isAvailable.mock.calls.length;

			const m1 = await runtime.getManifest();
			const m2 = await runtime.getManifest();
			const m3 = await runtime.getManifest();

			expect(m1.sandboxAvailable).toBe(true);
			expect(m2.sandboxAvailable).toBe(true);
			expect(m3.sandboxAvailable).toBe(true);

			// Three fresh manifest builds must add at most one probe (the first,
			// then memoized). Before the fix this grew by three.
			expect(isAvailable.mock.calls.length - probesAfterCreate).toBeLessThanOrEqual(1);
		} finally {
			await runtime.stopCron();
		}
	});
});
