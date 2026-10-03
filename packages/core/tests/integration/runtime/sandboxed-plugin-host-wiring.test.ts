import { randomUUID } from "node:crypto";

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DatabaseTables } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { PLUGIN_CAPABILITY_IMPLICATIONS } from "../../../src/plugins/types.js";
import type { Storage } from "../../../src/storage/types.js";

class MemoryStorage implements Storage {
	private files = new Map<string, Uint8Array>();

	putText(key: string, value: string): void {
		this.files.set(key, new TextEncoder().encode(value));
	}

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
	}) {
		if (!(options.body instanceof Uint8Array)) throw new Error("Test storage expects bytes");
		this.files.set(options.key, options.body);
		return { key: options.key, url: `memory://${options.key}`, size: options.body.byteLength };
	}

	async download(key: string) {
		const bytes = this.files.get(key);
		if (!bytes) throw new Error(`Missing ${key}`);
		return {
			body: new Blob([bytes]).stream(),
			contentType: "application/octet-stream",
			size: bytes.byteLength,
		};
	}

	async delete(key: string): Promise<void> {
		this.files.delete(key);
	}

	async exists(key: string): Promise<boolean> {
		return this.files.has(key);
	}

	async list() {
		return { files: [] };
	}

	async getSignedUploadUrl() {
		return {
			url: "memory://upload",
			method: "PUT" as const,
			headers: {},
			expiresAt: new Date().toISOString(),
		};
	}

	getPublicUrl(key: string): string {
		return `memory://${key}`;
	}
}

let currentInvokeHook: SandboxedPluginInstance["invokeHook"] = async () => undefined;
let loadedSandboxCapabilities: string[] = [];
let sandboxLoadCalls: Array<{ id: string; version: string }> = [];

function createDeps(
	invokeHook: SandboxedPluginInstance["invokeHook"],
	overrides: Partial<RuntimeDependencies> = {},
	pluginId = "sandbox-host",
): RuntimeDependencies {
	currentInvokeHook = invokeHook;
	loadedSandboxCapabilities = [];
	sandboxLoadCalls = [];
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (manifest: { id: string; version: string; capabilities: string[] }) => {
			sandboxLoadCalls.push({ id: manifest.id, version: manifest.version });
			loadedSandboxCapabilities = [...manifest.capabilities];
			return {
				id: `${manifest.id}:${manifest.version}`,
				invokeHook: (...args: Parameters<SandboxedPluginInstance["invokeHook"]>) =>
					currentInvokeHook(...args),
				invokeRoute: vi.fn(),
				terminate: vi.fn(),
			};
		}),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};

	return {
		config: {
			database: {
				entrypoint: `test-sandbox-host-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		createScheduler: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: pluginId,
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: [
					"content:read",
					"media:read",
					"users:read",
					"hooks.email-events:register",
					"hooks.email-transport:register",
					"hooks.page-fragments:register",
				],
				allowedHosts: [],
				storage: {},
				hooks: [
					"plugin:activate",
					"content:afterSave",
					{ name: "media:afterUpload", priority: 50 },
					"cron",
					"email:afterSend",
					{ name: "email:deliver", exclusive: true },
					{ name: "comment:moderate", exclusive: true },
					"page:metadata",
					"page:fragments",
				],
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- fake implements the published runner boundary
		createSandboxRunner: (() => runner) as any,
		...overrides,
	};
}

describe("EmDashRuntime sandboxed plugin host wiring", () => {
	let runtime: EmDashRuntime | undefined;

	afterEach(async () => {
		await runtime?.stopCron();
		runtime = undefined;
	});

	it("dispatches config-managed hooks through the shared host pipeline", async () => {
		const calls: string[] = [];
		const invokeHook = vi.fn(async (name: string) => {
			calls.push(name);
			if (name === "comment:moderate") return { status: "approved", reason: "sandbox" };
			if (name === "page:metadata") {
				return { kind: "meta", name: "sandbox", content: "active" };
			}
		});
		runtime = await EmDashRuntime.create(createDeps(invokeHook));

		await runtime.hooks.runContentAfterSave({ id: "post-1" }, "posts", true);
		await runtime.hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "image.png",
			mimeType: "image/png",
			size: 1,
			url: "/image.png",
			createdAt: new Date().toISOString(),
		});
		await runtime.hooks.invokeCronHook("sandbox-host", {
			name: "daily",
			scheduledAt: new Date().toISOString(),
		});
		await runtime.hooks.runEmailAfterSend(
			{ to: "test@example.com", subject: "Test", text: "Hello" },
			"test",
		);
		await runtime.setPluginStatus("sandbox-host", "inactive");
		await runtime.setPluginStatus("sandbox-host", "active");
		const metadata = await runtime.collectPageMetadata({ kind: "generic", url: "https://test/" });

		expect(calls).toEqual([
			"content:afterSave",
			"media:afterUpload",
			"cron",
			"email:afterSend",
			"plugin:activate",
			"page:metadata",
		]);
		expect(metadata).toContainEqual({ kind: "meta", name: "sandbox", content: "active" });
		expect(runtime.hooks.getExclusiveHookProviders("email:deliver")).toContainEqual({
			pluginId: "sandbox-host",
		});
		expect(runtime.hooks.getExclusiveHookProviders("comment:moderate")).toContainEqual({
			pluginId: "sandbox-host",
		});
		expect(runtime.hooks.getHookCount("page:fragments")).toBe(0);
	});

	it("applies every canonical capability implication before loading the sandbox", async () => {
		const deps = createDeps(vi.fn(), {}, "sandbox-implications");
		deps.sandboxedPluginEntries[0]!.capabilities = PLUGIN_CAPABILITY_IMPLICATIONS.map(
			([granted]) => granted,
		);
		runtime = await EmDashRuntime.create(deps);

		expect(loadedSandboxCapabilities).toEqual(
			expect.arrayContaining(PLUGIN_CAPABILITY_IMPLICATIONS.flat()),
		);
	});

	it("loads a cold registry plugin without replaying install or activating twice", async () => {
		const calls: string[] = [];
		const invokeHook = vi.fn(async (name: string) => {
			calls.push(name);
		});
		const storage = new MemoryStorage();
		const deps = createDeps(
			invokeHook,
			{
				config: {
					database: {
						entrypoint: `test-registry-host-${randomUUID()}`,
						config: {},
						type: "sqlite",
					},
					storage: { entrypoint: `memory-${randomUUID()}`, config: {} },
					registry: "https://registry.example.com",
				},
				createStorage: () => storage,
				sandboxedPluginEntries: [],
			},
			"registry-host",
		);
		runtime = await EmDashRuntime.create(deps);
		const manifest = {
			id: "registry-host",
			version: "1.0.0",
			capabilities: ["media:read"],
			allowedHosts: [],
			storage: {},
			hooks: [
				"plugin:install",
				"plugin:activate",
				"plugin:deactivate",
				"plugin:uninstall",
				"media:afterUpload",
			],
			routes: [],
			admin: {},
		};
		storage.putText("registry/registry-host/1.0.0/manifest.json", JSON.stringify(manifest));
		storage.putText("registry/registry-host/1.0.0/backend.js", "export default {};");
		await new PluginStateRepository(runtime.db).upsert("registry-host", "1.0.0", "active", {
			source: "registry",
			registryPublisherDid: "did:plc:test",
			registrySlug: "registry-host",
		});

		await runtime.syncRegistryPlugins();
		expect(calls).toEqual([]);

		await runtime.setPluginStatus("registry-host", "active");
		await runtime.hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "image.png",
			mimeType: "image/png",
			size: 1,
			url: "/image.png",
			createdAt: new Date().toISOString(),
		});
		await runtime.runPluginUninstallLifecycle("registry-host", true);

		expect(calls).toEqual([
			"plugin:activate",
			"media:afterUpload",
			"plugin:deactivate",
			"plugin:uninstall",
		]);
	});

	describe("load-time requires gate", () => {
		function putStoredBundle(
			storage: MemoryStorage,
			source: "marketplace" | "registry",
			pluginId: string,
			version: string,
			requires?: Record<string, string>,
		): void {
			const manifest: Record<string, unknown> = {
				id: pluginId,
				version,
				capabilities: ["media:read"],
				allowedHosts: [],
				storage: {},
				hooks: ["media:afterUpload"],
				routes: [],
				admin: {},
			};
			if (requires) manifest.requires = requires;
			storage.putText(`${source}/${pluginId}/${version}/manifest.json`, JSON.stringify(manifest));
			storage.putText(`${source}/${pluginId}/${version}/backend.js`, "export default {};");
		}

		async function upsertState(
			target: EmDashRuntime,
			pluginId: string,
			source: "marketplace" | "registry",
		): Promise<void> {
			await new PluginStateRepository(target.db).upsert(pluginId, "1.0.0", "active", {
				source,
				...(source === "registry"
					? { registryPublisherDid: "did:plc:test", registrySlug: pluginId }
					: {}),
			});
		}

		function createGateDeps(
			invokeHook: SandboxedPluginInstance["invokeHook"],
			source: "marketplace" | "registry",
			storage: MemoryStorage,
			extra: Partial<RuntimeDependencies> = {},
		): RuntimeDependencies {
			return createDeps(invokeHook, {
				config: {
					database: {
						entrypoint: `test-load-gate-${randomUUID()}`,
						config: {},
						type: "sqlite",
					},
					storage: { entrypoint: `memory-${randomUUID()}`, config: {} },
					astroVersion: "5.6.0",
					...(source === "registry" ? { registry: "https://registry.example.com" } : {}),
					...(source === "marketplace" ? { marketplace: "https://marketplace.example.com" } : {}),
				},
				createStorage: () => storage,
				sandboxedPluginEntries: [],
				...extra,
			});
		}

		async function runMediaHook(target: EmDashRuntime): Promise<void> {
			await target.hooks.runMediaAfterUpload({
				id: "media-1",
				filename: "image.png",
				mimeType: "image/png",
				size: 1,
				url: "/image.png",
				createdAt: new Date().toISOString(),
			});
		}

		it("skips loading a registry plugin whose stored requires exclude the host", async () => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
			});
			const storage = new MemoryStorage();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			runtime = await EmDashRuntime.create(createGateDeps(invokeHook, "registry", storage));
			putStoredBundle(storage, "registry", "load-incompat", "1.0.0", {
				"env:astro": "^4.0.0",
			});
			await upsertState(runtime, "load-incompat", "registry");

			await runtime.syncRegistryPlugins();

			// Never loaded: no sandbox instance, no pipeline entry, no hook dispatch.
			expect(sandboxLoadCalls).toEqual([]);
			await runMediaHook(runtime);
			expect(calls).toEqual([]);
			// Warning names the plugin, version, host, and unsatisfied constraint.
			const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
			expect(warnings).toContain("load-incompat");
			expect(warnings).toContain("1.0.0");
			expect(warnings).toContain("env:astro");
			expect(warnings).toContain("^4.0.0");
			// In-memory record for the admin list; DB state stays active.
			expect(runtime.getSandboxedPluginLoadIncompatibility("load-incompat")).toEqual([
				{ key: "env:astro", required: "^4.0.0", host: "5.6.0" },
			]);
			const state = await new PluginStateRepository(runtime.db).get("load-incompat");
			expect(state?.status).toBe("active");
			warn.mockRestore();
		});

		it("loads a registry plugin whose stored requires the host satisfies", async () => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
			});
			const storage = new MemoryStorage();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			runtime = await EmDashRuntime.create(createGateDeps(invokeHook, "registry", storage));
			putStoredBundle(storage, "registry", "load-compat", "1.0.0", {
				"env:astro": "^5.0.0",
			});
			await upsertState(runtime, "load-compat", "registry");

			await runtime.syncRegistryPlugins();

			expect(sandboxLoadCalls).toEqual([{ id: "load-compat", version: "1.0.0" }]);
			await runMediaHook(runtime);
			expect(calls).toEqual(["media:afterUpload"]);
			expect(runtime.getSandboxedPluginLoadIncompatibility("load-compat")).toBeNull();
			warn.mockRestore();
		});

		it("fails open when stored requires are unparseable or absent", async () => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
			});
			const storage = new MemoryStorage();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			runtime = await EmDashRuntime.create(createGateDeps(invokeHook, "registry", storage));
			putStoredBundle(storage, "registry", "load-unparseable", "1.0.0", {
				"env:astro": "not-a-semver-range",
			});
			putStoredBundle(storage, "registry", "load-no-requires", "1.0.0");
			await upsertState(runtime, "load-unparseable", "registry");
			await upsertState(runtime, "load-no-requires", "registry");

			await runtime.syncRegistryPlugins();

			expect(sandboxLoadCalls).toEqual(
				expect.arrayContaining([
					{ id: "load-unparseable", version: "1.0.0" },
					{ id: "load-no-requires", version: "1.0.0" },
				]),
			);
			await runMediaHook(runtime);
			expect(calls).toEqual(["media:afterUpload", "media:afterUpload"]);
			expect(runtime.getSandboxedPluginLoadIncompatibility("load-unparseable")).toBeNull();
			expect(runtime.getSandboxedPluginLoadIncompatibility("load-no-requires")).toBeNull();
			warn.mockRestore();
		});

		it("applies the same load-time gate to marketplace plugins", async () => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
			});
			const storage = new MemoryStorage();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			runtime = await EmDashRuntime.create(createGateDeps(invokeHook, "marketplace", storage));
			putStoredBundle(storage, "marketplace", "mp-incompat", "1.0.0", {
				"env:astro": "^4.0.0",
			});
			await upsertState(runtime, "mp-incompat", "marketplace");

			await runtime.syncMarketplacePlugins();

			expect(sandboxLoadCalls).toEqual([]);
			await runMediaHook(runtime);
			expect(calls).toEqual([]);
			const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
			expect(warnings).toContain("mp-incompat");
			expect(runtime.getSandboxedPluginLoadIncompatibility("mp-incompat")).toEqual([
				{ key: "env:astro", required: "^4.0.0", host: "5.6.0" },
			]);
			warn.mockRestore();
		});

		it("skips a cold-start registry plugin whose stored requires exclude the host", async () => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
			});
			const storage = new MemoryStorage();
			putStoredBundle(storage, "registry", "cold-incompat", "1.0.0", {
				"env:astro": "^4.0.0",
			});

			// Plant the active state row before create() so the runtime's
			// cold-start loader — not the post-install sync — is the code path
			// under test.
			const sqlite = openNodeSqliteDatabase(":memory:");
			const db = new Kysely<DatabaseTables>({
				dialect: new SqliteDialect({ database: sqlite }),
			});
			await runMigrations(db);
			await new PluginStateRepository(db).upsert("cold-incompat", "1.0.0", "active", {
				source: "registry",
				registryPublisherDid: "did:plc:test",
				registrySlug: "cold-incompat",
			});

			const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			runtime = await EmDashRuntime.create(
				createGateDeps(invokeHook, "registry", storage, {
					createDialect: () => new SqliteDialect({ database: sqlite }),
				}),
			);

			expect(sandboxLoadCalls).toEqual([]);
			await runMediaHook(runtime);
			expect(calls).toEqual([]);
			const warnings = warn.mock.calls.map((call) => String(call[0])).join("\n");
			expect(warnings).toContain("cold-incompat");
			expect(runtime.getSandboxedPluginLoadIncompatibility("cold-incompat")).toEqual([
				{ key: "env:astro", required: "^4.0.0", host: "5.6.0" },
			]);
			const state = await new PluginStateRepository(runtime.db).get("cold-incompat");
			expect(state?.status).toBe("active");
			warn.mockRestore();
		});
	});

	it("runs first-install lifecycle exactly once when requested by an install flow", async () => {
		const calls: string[] = [];
		const invokeHook = vi.fn(async (name: string) => calls.push(name));
		const deps = createDeps(invokeHook, {}, "sandbox-install-lifecycle");
		deps.sandboxedPluginEntries[0]!.hooks = [
			"plugin:install",
			...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
		];
		runtime = await EmDashRuntime.create(deps);

		await runtime.runPluginInstallLifecycle("sandbox-install-lifecycle");

		expect(calls).toEqual(["plugin:install", "plugin:activate"]);
	});

	it("orders sandboxed and trusted hooks by shared pipeline priority", async () => {
		const calls: string[] = [];
		const invokeHook = vi.fn(async (name: string) => {
			if (name === "media:afterUpload") calls.push("sandbox");
		});
		runtime = await EmDashRuntime.create(
			createDeps(
				invokeHook,
				{
					plugins: [
						definePlugin({
							id: "trusted-host",
							version: "1.0.0",
							capabilities: ["media:read"],
							hooks: {
								"media:afterUpload": async () => {
									calls.push("trusted");
								},
							},
						}),
					],
				},
				"sandbox-order",
			),
		);

		await runtime.hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "image.png",
			mimeType: "image/png",
			size: 1,
			url: "/image.png",
			createdAt: new Date().toISOString(),
		});

		expect(calls).toEqual(["sandbox", "trusted"]);
	});

	it("does not register a sandbox hook without its consented capability", async () => {
		const invokeHook = vi.fn();
		const deps = createDeps(invokeHook, {}, "sandbox-consent");
		deps.sandboxedPluginEntries[0]!.capabilities = [];
		runtime = await EmDashRuntime.create(deps);

		expect(runtime.hooks.getHookCount("media:afterUpload")).toBe(0);
		await runtime.hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "image.png",
			mimeType: "image/png",
			size: 1,
			url: "/image.png",
			createdAt: new Date().toISOString(),
		});
		expect(invokeHook).not.toHaveBeenCalledWith("media:afterUpload", expect.anything());
	});
});
