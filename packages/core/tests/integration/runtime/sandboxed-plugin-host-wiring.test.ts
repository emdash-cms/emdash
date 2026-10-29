import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import {
	SandboxUnavailableError,
	type SandboxedPluginInstance,
} from "../../../src/plugins/sandbox/types.js";
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
let setSandboxActive = vi.fn<(active: boolean) => void>();
let ensureRunning = vi.fn<() => Promise<void>>(async () => undefined);
let isHealthy = vi.fn(() => true);

function createDeps(
	invokeHook: SandboxedPluginInstance["invokeHook"],
	overrides: Partial<RuntimeDependencies> = {},
	pluginId = "sandbox-host",
): RuntimeDependencies {
	currentInvokeHook = invokeHook;
	loadedSandboxCapabilities = [];
	setSandboxActive = vi.fn();
	ensureRunning = vi.fn(async () => undefined);
	isHealthy = vi.fn(() => true);
	const database = new Database(":memory:");
	const runner = {
		isAvailable: () => true,
		isHealthy,
		ensureRunning,
		load: vi.fn(async (manifest: { id: string; version: string; capabilities: string[] }) => {
			loadedSandboxCapabilities = [...manifest.capabilities];
			return {
				id: `${manifest.id}:${manifest.version}`,
				invokeHook: (...args: Parameters<SandboxedPluginInstance["invokeHook"]>) =>
					currentInvokeHook(...args),
				invokeRoute: vi.fn(),
				setActive: setSandboxActive,
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
		createDialect: () => new SqliteDialect({ database }),
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
		await runtime?.shutdown();
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
			"plugin:activate",
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

	it("runs the first-install lifecycle automatically on boot and only once", async () => {
		const calls: string[] = [];
		const invokeHook = vi.fn(async (name: string) => calls.push(name));
		const deps = createDeps(invokeHook, {}, "sandbox-install-lifecycle");
		deps.sandboxedPluginEntries[0]!.hooks = [
			"plugin:install",
			...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
		];
		runtime = await EmDashRuntime.create(deps);

		expect(calls).toEqual(["plugin:install", "plugin:activate"]);
		expect(
			await new PluginStateRepository(runtime.db).get("sandbox-install-lifecycle"),
		).toMatchObject({
			status: "active",
			version: "1.0.0",
		});

		await runtime.shutdown();
		runtime = await EmDashRuntime.create(deps);
		await expect(
			new PluginStateRepository(runtime.db).get("sandbox-install-lifecycle"),
		).resolves.toMatchObject({
			status: "active",
		});
		expect(calls).toEqual(["plugin:install", "plugin:activate"]);
	});

	it.each(["plugin:install", "plugin:activate"])(
		"revokes sandbox access after %s fails and does not retry on boot",
		async (failingHook) => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
				if (name === failingHook) throw new Error("lifecycle failed");
			});
			const deps = createDeps(invokeHook, {}, "sandbox-failed-install");
			deps.sandboxedPluginEntries[0]!.hooks = [
				"plugin:install",
				...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
			];
			const expectedCalls =
				failingHook === "plugin:install"
					? ["plugin:install"]
					: ["plugin:install", "plugin:activate"];
			runtime = await EmDashRuntime.create(deps);

			expect(calls).toEqual(expectedCalls);
			expect(setSandboxActive).toHaveBeenLastCalledWith(false);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-failed-install"),
			).toMatchObject({
				status: "inactive",
			});
			await runtime.shutdown();
			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual(expectedCalls);
			expect(setSandboxActive).toHaveBeenLastCalledWith(false);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-failed-install"),
			).toMatchObject({
				status: "inactive",
			});
		},
	);

	it.each(["plugin:install", "plugin:activate"])(
		"retries %s after the sandbox reports it is unavailable",
		async (unavailableHook) => {
			const calls: string[] = [];
			let unavailable = true;
			const invokeHook = vi.fn(async (name: string) => {
				calls.push(name);
				if (unavailable && name === unavailableHook) {
					throw new SandboxUnavailableError("sandbox-unavailable-hook", "starting");
				}
			});
			const database = new Database(":memory:");
			const dialect = new SqliteDialect({ database });
			const entrypoint = `test-unavailable-hook-${randomUUID()}`;
			const deps = createDeps(
				invokeHook,
				{
					config: { database: { entrypoint, config: {}, type: "sqlite" } },
					createDialect: () => dialect,
				},
				"sandbox-unavailable-hook",
			);
			deps.sandboxedPluginEntries[0]!.hooks = [
				"plugin:install",
				...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
			];
			deps.sandboxedPluginEntries.push({ ...deps.sandboxedPluginEntries[0]!, id: "later-sandbox" });

			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual(
				unavailableHook === "plugin:install"
					? ["plugin:install"]
					: ["plugin:install", "plugin:activate"],
			);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-unavailable-hook"),
			).toBeNull();
			expect(await new PluginStateRepository(runtime.db).get("later-sandbox")).toBeNull();
			expect(runtime.hooks.getHookCount("cron")).toBeGreaterThan(0);
			expect(setSandboxActive).not.toHaveBeenCalledWith(false);
			await runtime.shutdown();

			unavailable = false;
			calls.length = 0;
			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual([
				"plugin:install",
				"plugin:activate",
				"plugin:install",
				"plugin:activate",
			]);
			expect(await new PluginStateRepository(runtime.db).get("later-sandbox")).toMatchObject({
				status: "active",
			});
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-unavailable-hook"),
			).toMatchObject({
				status: "active",
			});
		},
	);

	it("does not start the lifecycle timeout until sandbox readiness completes", async () => {
		vi.useFakeTimers();
		let resolveReadiness!: () => void;
		const readiness = new Promise<void>((resolve) => {
			resolveReadiness = resolve;
		});
		const calls: string[] = [];
		const invokeHook = vi.fn(async (name: string) => calls.push(name));
		const deps = createDeps(invokeHook, {}, "sandbox-slow-readiness");
		deps.sandboxedPluginEntries[0]!.hooks = [
			"plugin:install",
			...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
		];
		let markStarting!: () => void;
		const starting = new Promise<void>((resolve) => {
			markStarting = resolve;
		});
		ensureRunning.mockImplementation(async () => {
			markStarting();
			await readiness;
		});
		const boot = EmDashRuntime.create(deps);

		try {
			await starting;
			await vi.advanceTimersByTimeAsync(6000);
			expect(calls).toEqual([]);
			resolveReadiness();
			runtime = await boot;
			expect(calls).toEqual(["plugin:install", "plugin:activate"]);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-slow-readiness"),
			).toMatchObject({
				status: "active",
			});
		} finally {
			resolveReadiness();
			try {
				runtime = await boot;
			} finally {
				vi.useRealTimers();
			}
		}
	});

	it.each(["rejects", "stays unhealthy"])(
		"retries on a later boot when sandbox readiness %s",
		async (failure) => {
			const calls: string[] = [];
			const invokeHook = vi.fn(async (name: string) => calls.push(name));
			const database = new Database(":memory:");
			const dialect = new SqliteDialect({ database });
			const entrypoint = `test-readiness-rejection-${randomUUID()}`;
			const deps = createDeps(
				invokeHook,
				{
					config: { database: { entrypoint, config: {}, type: "sqlite" } },
					createDialect: () => dialect,
				},
				"sandbox-readiness-rejection",
			);
			deps.sandboxedPluginEntries[0]!.hooks = [
				"plugin:install",
				...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
			];
			deps.sandboxedPluginEntries.push({
				...deps.sandboxedPluginEntries[0]!,
				id: "second-sandbox",
			});
			if (failure === "rejects") {
				ensureRunning.mockRejectedValue(new Error("sandbox starting"));
			} else {
				isHealthy.mockReturnValue(false);
			}

			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual([]);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-readiness-rejection"),
			).toBeNull();
			expect(await new PluginStateRepository(runtime.db).get("second-sandbox")).toBeNull();
			expect(ensureRunning).toHaveBeenCalledTimes(1);
			expect(setSandboxActive).not.toHaveBeenCalledWith(false);
			await runtime.shutdown();

			const retryDeps = createDeps(
				invokeHook,
				{
					config: { database: { entrypoint, config: {}, type: "sqlite" } },
					createDialect: () => dialect,
				},
				"sandbox-readiness-rejection",
			);
			retryDeps.sandboxedPluginEntries[0]!.hooks = [
				"plugin:install",
				...(retryDeps.sandboxedPluginEntries[0]!.hooks ?? []),
			];
			retryDeps.sandboxedPluginEntries.push({
				...retryDeps.sandboxedPluginEntries[0]!,
				id: "second-sandbox",
			});
			runtime = await EmDashRuntime.create(retryDeps);
			expect(calls).toEqual([
				"plugin:install",
				"plugin:activate",
				"plugin:install",
				"plugin:activate",
			]);
			expect(ensureRunning).toHaveBeenCalledTimes(1);
			expect(await new PluginStateRepository(runtime.db).get("second-sandbox")).toMatchObject({
				status: "active",
			});
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-readiness-rejection"),
			).toMatchObject({
				status: "active",
			});
		},
	);

	it("does not record a state when the sandbox runner is unavailable", async () => {
		const calls: string[] = [];
		const database = new Database(":memory:");
		const dialect = new SqliteDialect({ database });
		const entrypoint = `test-unavailable-${randomUUID()}`;
		const invokeHook = vi.fn(async (name: string) => calls.push(name));
		const unavailable = createDeps(
			invokeHook,
			{
				config: { database: { entrypoint, config: {}, type: "sqlite" } },
				createDialect: () => dialect,
				createSandboxRunner: () => null,
			},
			"sandbox-unavailable",
		);
		runtime = await EmDashRuntime.create(unavailable);
		expect(await new PluginStateRepository(runtime.db).get("sandbox-unavailable")).toBeNull();
		await runtime.shutdown();

		const available = createDeps(
			invokeHook,
			{
				config: { database: { entrypoint, config: {}, type: "sqlite" } },
				createDialect: () => dialect,
			},
			"sandbox-unavailable",
		);
		runtime = await EmDashRuntime.create(available);
		expect(calls).toEqual(["plugin:activate"]);
		expect(await new PluginStateRepository(runtime.db).get("sandbox-unavailable")).toMatchObject({
			status: "active",
		});
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
