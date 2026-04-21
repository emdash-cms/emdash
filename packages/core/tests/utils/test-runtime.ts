import type { Kysely } from "kysely";

import type { Database as DbSchema } from "../../src/database/types.js";
import { EmDashRuntime, type SandboxedPluginEntry } from "../../src/emdash-runtime.js";
import { HookPipeline } from "../../src/plugins/hooks.js";

// The EmDashRuntime constructor is private — direct construction is only possible
// via the cast below. Centralised here so a constructor change breaks one file,
// not every test that needs a minimal runtime.
type RuntimeCtor = new (...args: unknown[]) => EmDashRuntime;

export interface TestRuntimeOptions {
	sandboxedPluginEntries?: SandboxedPluginEntry[];
	manifestCacheKey?: string;
}

export function createTestRuntime(
	db: Kysely<DbSchema>,
	{
		sandboxedPluginEntries = [],
		manifestCacheKey = "test-manifest-cache-key",
	}: TestRuntimeOptions = {},
): EmDashRuntime {
	const hooks = new HookPipeline([]);
	const Ctor = EmDashRuntime as unknown as RuntimeCtor;

	return new Ctor(
		db,
		null,
		[],
		new Map(),
		sandboxedPluginEntries,
		hooks,
		new Set(),
		new Map(),
		{},
		new Map(),
		[],
		null,
		null,
		null,
		[],
		{ db },
		{
			config: {},
			plugins: [],
			createDialect: () => {
				throw new Error("not used in tests");
			},
			createStorage: null,
			sandboxEnabled: false,
			sandboxedPluginEntries,
			createSandboxRunner: null,
			mediaProviderEntries: [],
		},
		{ current: hooks },
		manifestCacheKey,
	);
}
