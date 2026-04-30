/**
 * Repro for issue #873.
 *
 * `EmDashRuntime.invalidateManifest()` must defer the persisted-cache D1
 * row delete via `after()` so it gets registered with the host's lifetime
 * extender (`ctx.waitUntil` on Cloudflare Workers). A bare unawaited
 * promise is cancelled when the isolate is torn down post-response, so
 * the persisted `options.emdash:manifest_cache` row stays at the
 * pre-mutation snapshot and every cold-starting isolate downstream
 * serves stale schema (e.g. "Collection 'spaces' not found" after
 * adding the `spaces` collection from the admin).
 *
 * The structural invariant under test: every call to `invalidateManifest()`
 * routes its DB cleanup through `after()`. We don't try to simulate the
 * Workers tear-down here — we just pin the contract that the cleanup is
 * lifetime-extender-aware.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Default stub for the wait-until virtual module — same shape as
// `tests/unit/after.test.ts`. Without a host binding, `after()` falls
// back to fire-and-forget (still observable via the spy below).
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

// Spy on `after()` so we can assert `invalidateManifest()` deferred its
// cleanup through it. `vi.hoisted` keeps the spy reference shared with
// the mock factory (which runs before module imports).
const afterSpy = vi.hoisted(() => vi.fn<(fn: () => void | Promise<void>) => void>());
vi.mock("../../../src/after.js", async () => {
	const actual =
		await vi.importActual<typeof import("../../../src/after.js")>("../../../src/after.js");
	return {
		...actual,
		after: (fn: () => void | Promise<void>) => {
			afterSpy(fn);
			return actual.after(fn);
		},
	};
});

import type { Kysely } from "kysely";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildRuntime(db: Kysely<Database>): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([], pipelineFactoryOptions);
	const pipelineRef = { current: hooks };

	// `runtimeDeps` is only consumed by `rebuildHookPipeline()`, which this
	// test doesn't call. A minimal stub is enough; if a future change starts
	// reading more of it, this test will throw a clear error.
	const runtimeDeps = {
		config,
		plugins: [],
		// eslint-disable-next-line typescript-eslint(no-explicit-any) -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef,
		manifestCacheKey: "test-key",
	});
}

describe("EmDashRuntime.invalidateManifest()", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		afterSpy.mockClear();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("defers the persisted-cache delete via after() so it survives Workers post-response teardown", async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:manifest_cache", { key: "stale", manifest: { junk: true } });

		const runtime = buildRuntime(db);

		runtime.invalidateManifest();

		// The D1 delete must be deferred via after() — that's how it gets
		// registered with `ctx.waitUntil` on Cloudflare Workers. A bare
		// unawaited promise gets cancelled at response-time.
		expect(afterSpy).toHaveBeenCalledTimes(1);

		// Drain pending microtasks so the deferred delete actually runs;
		// after() takes one extra microtask before invoking fn.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// And the persisted cache row is gone.
		const remaining = await options.get("emdash:manifest_cache");
		expect(remaining).toBeNull();
	});
});
