/**
 * Cold-start load of marketplace- and registry-installed plugins.
 *
 * Each plugin's bundle reads are independent, so the runtime issues them
 * concurrently instead of one plugin after another. Sandbox loads must still
 * run one at a time, in plugin-state order: runner `load()` calls are not
 * safe to overlap (the Miniflare dev runner rebuilds its instance on each
 * load), and that order is the order the plugins join the hook pipeline. The
 * runtime never needs `admin.js`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { storeBundleInR2 } from "../../../src/api/handlers/marketplace.js";
import type { SandboxRunner, SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import type { PluginState } from "../../../src/plugins/state.js";
import type { PluginManifest } from "../../../src/plugins/types.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";

type EmDashRuntimeModule = typeof import("../../../src/emdash-runtime.js");

function manifest(id: string): PluginManifest {
	return {
		id,
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
	};
}

function registryState(pluginId: string): PluginState {
	return {
		pluginId,
		status: "active",
		version: "1.0.0",
		installedAt: new Date(),
		activatedAt: new Date(),
		deactivatedAt: null,
		source: "registry",
		marketplaceVersion: null,
		displayName: null,
		description: null,
		registryPublisherDid: null,
		registrySlug: null,
	} as PluginState;
}

function createRunner() {
	const loaded: string[] = [];
	let loadsInFlight = 0;
	let maxLoadsInFlight = 0;
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		async load(pluginManifest: PluginManifest) {
			loadsInFlight++;
			maxLoadsInFlight = Math.max(maxLoadsInFlight, loadsInFlight);
			try {
				// Like the Miniflare dev runner, yield before the load completes.
				await new Promise((resolve) => setTimeout(resolve, 5));
				loaded.push(pluginManifest.id);
				return { id: `${pluginManifest.id}:${pluginManifest.version}` } as SandboxedPluginInstance;
			} finally {
				loadsInFlight--;
			}
		},
		setEmailSend() {},
		async terminateAll() {},
	} as unknown as SandboxRunner;
	return {
		runner,
		loaded,
		get maxLoadsInFlight() {
			return maxLoadsInFlight;
		},
	};
}

describe("installed plugin cold-start load", () => {
	let runtimeModule: EmDashRuntimeModule;

	beforeEach(async () => {
		// The sandbox runner and plugin caches are module state: start fresh.
		vi.resetModules();
		runtimeModule = await import("../../../src/emdash-runtime.js");
	});

	async function loadInstalled(
		storage: ReturnType<typeof createMemoryStorage>,
		states: PluginState[],
		runner: SandboxRunner,
	) {
		const cache = new Map<string, SandboxedPluginInstance>();
		await runtimeModule.EmDashRuntime["loadInstalledSandboxedPlugins"](
			"registry",
			{} as never,
			storage,
			{ createSandboxRunner: () => runner, sandboxBypassed: false } as never,
			cache,
			states,
		);
		return cache;
	}

	it("reads every plugin's bundle concurrently, then loads them one at a time in state order", async () => {
		const storage = createMemoryStorage();
		for (const id of ["slow-plugin", "fast-plugin"]) {
			await storeBundleInR2(
				storage,
				id,
				"1.0.0",
				{
					manifest: manifest(id),
					backendCode: "export default {};",
					adminCode: "export const pages = {};",
				},
				"registry",
			);
		}

		const requested: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const download = storage.download.bind(storage);
		storage.download = async (key: string) => {
			requested.push(key);
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				// The first plugin's files arrive last.
				await new Promise((resolve) => setTimeout(resolve, key.includes("slow-plugin") ? 20 : 0));
				return await download(key);
			} finally {
				inFlight--;
			}
		};

		const sandbox = createRunner();
		const cache = await loadInstalled(
			storage,
			[registryState("slow-plugin"), registryState("fast-plugin")],
			sandbox.runner,
		);

		expect(maxInFlight).toBe(4);
		expect(requested.some((key) => key.endsWith("/admin.js"))).toBe(false);
		expect(sandbox.maxLoadsInFlight).toBe(1);
		expect(sandbox.loaded).toEqual(["slow-plugin", "fast-plugin"]);
		expect([...cache.keys()]).toEqual(["slow-plugin:1.0.0", "fast-plugin:1.0.0"]);
	});

	it("never overlaps sandbox loads when the bundles arrive together", async () => {
		const storage = createMemoryStorage();
		for (const id of ["first-plugin", "second-plugin", "third-plugin"]) {
			await storeBundleInR2(
				storage,
				id,
				"1.0.0",
				{ manifest: manifest(id), backendCode: "export default {};" },
				"registry",
			);
		}

		const sandbox = createRunner();
		const cache = await loadInstalled(
			storage,
			[
				registryState("first-plugin"),
				registryState("second-plugin"),
				registryState("third-plugin"),
			],
			sandbox.runner,
		);

		expect(sandbox.maxLoadsInFlight).toBe(1);
		expect(sandbox.loaded).toEqual(["first-plugin", "second-plugin", "third-plugin"]);
		expect([...cache.keys()]).toEqual([
			"first-plugin:1.0.0",
			"second-plugin:1.0.0",
			"third-plugin:1.0.0",
		]);
	});

	it("keeps loading the other plugins when one bundle is missing", async () => {
		const storage = createMemoryStorage();
		await storeBundleInR2(
			storage,
			"present-plugin",
			"1.0.0",
			{ manifest: manifest("present-plugin"), backendCode: "export default {};" },
			"registry",
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		try {
			const { runner } = createRunner();
			const cache = await loadInstalled(
				storage,
				[registryState("missing-plugin"), registryState("present-plugin")],
				runner,
			);

			expect([...cache.keys()]).toEqual(["present-plugin:1.0.0"]);
			expect(warn).toHaveBeenCalledWith(
				"EmDash: registry plugin missing-plugin@1.0.0 not found in R2",
			);
		} finally {
			warn.mockRestore();
		}
	});
});
