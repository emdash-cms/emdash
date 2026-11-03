import { randomUUID } from "node:crypto";

import type { APIContext } from "astro";
import { sql, SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { POST as disablePlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/disable.js";
import { POST as enablePlugin } from "../../../src/astro/routes/api/admin/plugins/[id]/enable.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { CronAccessImpl } from "../../../src/plugins/cron.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import {
	SandboxUnavailableError,
	type SandboxedPluginInstance,
	type SandboxRunner,
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
const sandboxHookHandlers = new Map<string, SandboxedPluginInstance["invokeHook"]>();
let sandboxActive = false;
let sandboxInvokeRoute: ReturnType<typeof vi.fn> = vi.fn();
let setSandboxActive = vi.fn<(active: boolean) => void>();
let ensureRunning = vi.fn<NonNullable<SandboxRunner["ensureRunning"]>>(async () => undefined);
let isHealthy = vi.fn(() => true);

function createDeps(
	invokeHook: SandboxedPluginInstance["invokeHook"],
	overrides: Partial<RuntimeDependencies> = {},
	pluginId = "sandbox-host",
): RuntimeDependencies {
	currentInvokeHook = invokeHook;
	loadedSandboxCapabilities = [];
	sandboxHookHandlers.clear();
	sandboxActive = false;
	sandboxInvokeRoute = vi.fn(async () => ({ status: 200, body: { ok: true } }));
	setSandboxActive = vi.fn();
	isHealthy = vi.fn(() => true);
	ensureRunning = vi.fn<NonNullable<SandboxRunner["ensureRunning"]>>(async (options) => {
		if (options?.waitForPendingRestart) isHealthy.mockReturnValue(true);
	});
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
					(sandboxHookHandlers.get(manifest.id) ?? currentInvokeHook)(...args),
				invokeRoute: sandboxInvokeRoute,
				setActive: (active: boolean) => {
					sandboxActive = active;
					setSandboxActive(active);
				},
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

	it("does not activate when the runner becomes unhealthy during install and retries next boot", async () => {
		const calls: string[] = [];
		let crash = true;
		const invokeHook = vi.fn(async (name: string) => {
			calls.push(name);
			if (name === "plugin:install" && crash) {
				isHealthy.mockReturnValue(false);
			}
		});
		const deps = createDeps(invokeHook, {}, "sandbox-unhealthy-after-install");
		deps.sandboxedPluginEntries[0]!.hooks = [
			"plugin:install",
			...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
		];

		deps.sandboxedPluginEntries.push({ ...deps.sandboxedPluginEntries[0]!, id: "later-sandbox" });
		const laterHook = vi.fn(async () => undefined);
		sandboxHookHandlers.set("later-sandbox", laterHook);
		runtime = await EmDashRuntime.create(deps);
		expect(calls).toEqual(["plugin:install"]);
		expect(
			await new PluginStateRepository(runtime.db).get("sandbox-unhealthy-after-install"),
		).toBeNull();
		expect(await new PluginStateRepository(runtime.db).get("later-sandbox")).toMatchObject({
			status: "active",
		});
		expect(isHealthy()).toBe(true);
		expect(ensureRunning).toHaveBeenCalledTimes(2);

		await runtime.shutdown();
		runtime = undefined;
		crash = false;
		runtime = await EmDashRuntime.create(deps);

		expect(calls).toEqual(["plugin:install", "plugin:install", "plugin:activate"]);
		expect(
			await new PluginStateRepository(runtime.db).get("sandbox-unhealthy-after-install"),
		).toMatchObject({ status: "active" });
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
					isHealthy.mockReturnValue(false);
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
			const laterHook = vi.fn(async () => undefined);
			sandboxHookHandlers.set("later-sandbox", laterHook);

			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual(
				unavailableHook === "plugin:install"
					? ["plugin:install"]
					: ["plugin:install", "plugin:activate"],
			);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-unavailable-hook"),
			).toBeNull();
			expect(await new PluginStateRepository(runtime.db).get("later-sandbox")).toMatchObject({
				status: "active",
			});
			expect(ensureRunning).toHaveBeenCalledTimes(2);
			expect(runtime.hooks.getHookCount("cron")).toBeGreaterThan(0);
			expect(setSandboxActive).not.toHaveBeenCalledWith(false);
			await runtime.shutdown();

			unavailable = false;
			calls.length = 0;
			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual(["plugin:install", "plugin:activate"]);
			expect(laterHook).toHaveBeenCalledTimes(2);
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

	it.each(["plugin:install", "plugin:activate"])(
		"keeps later-sandbox active when the first plugin reports %s unavailable on two boots",
		async (unavailableHook) => {
			const firstCalls: string[] = [];
			const deps = createDeps(
				async (name) => {
					firstCalls.push(name);
					if (name === unavailableHook) {
						isHealthy.mockReturnValue(false);
						throw new SandboxUnavailableError("first-sandbox", "connection lost");
					}
				},
				{},
				"first-sandbox",
			);
			deps.sandboxedPluginEntries[0]!.hooks = ["plugin:install", "plugin:activate"];
			deps.sandboxedPluginEntries.push({ ...deps.sandboxedPluginEntries[0]!, id: "later-sandbox" });
			const laterCalls: string[] = [];
			sandboxHookHandlers.set("later-sandbox", async (name) => {
				laterCalls.push(name);
			});

			for (let boot = 0; boot < 2; boot++) {
				ensureRunning.mockClear();
				runtime = await EmDashRuntime.create(deps);
				const states = new PluginStateRepository(runtime.db);
				expect(await states.get("first-sandbox")).toBeNull();
				expect(await states.get("later-sandbox")).toMatchObject({ status: "active" });
				expect(ensureRunning).toHaveBeenCalledTimes(boot === 0 ? 2 : 1);
				await runtime.shutdown();
			}
			const attempted =
				unavailableHook === "plugin:install"
					? ["plugin:install"]
					: ["plugin:install", "plugin:activate"];
			expect(firstCalls).toEqual([...attempted, ...attempted]);
			expect(laterCalls).toEqual(["plugin:install", "plugin:activate"]);
		},
	);

	it("retries after a hook timeout while the runner is restarting", async () => {
		vi.useFakeTimers();
		let resolveRecovery!: () => void;
		const recovery = new Promise<void>((resolve) => {
			resolveRecovery = resolve;
		});
		let signalInvoked!: () => void;
		const invoked = new Promise<void>((resolve) => {
			signalInvoked = resolve;
		});
		const calls: string[] = [];
		let crash = true;
		const invokeHook = vi.fn(async (name: string) => {
			calls.push(name);
			if (name === "plugin:install" && crash) {
				isHealthy.mockReturnValue(false);
				signalInvoked();
				await recovery;
			}
		});
		const deps = createDeps(invokeHook, {}, "sandbox-hook-timeout-restart");
		deps.sandboxedPluginEntries[0]!.hooks = [
			"plugin:install",
			...(deps.sandboxedPluginEntries[0]!.hooks ?? []),
		];
		deps.sandboxedPluginEntries.push({ ...deps.sandboxedPluginEntries[0]!, id: "later-sandbox" });
		const laterHook = vi.fn(async () => undefined);
		sandboxHookHandlers.set("later-sandbox", laterHook);
		ensureRunning.mockImplementation(async (options) => {
			if (!isHealthy() && options?.waitForPendingRestart) {
				await recovery;
				isHealthy.mockReturnValue(true);
			}
		});
		const boot = EmDashRuntime.create(deps);

		try {
			await invoked;
			await vi.advanceTimersByTimeAsync(6000);
			expect(ensureRunning).toHaveBeenCalledTimes(2);
			expect(laterHook).not.toHaveBeenCalled();
			resolveRecovery();
			runtime = await boot;
			expect(await new PluginStateRepository(runtime.db).get("later-sandbox")).toMatchObject({
				status: "active",
			});
			expect(calls).toEqual(["plugin:install"]);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-hook-timeout-restart"),
			).toBeNull();

			await runtime.shutdown();
			runtime = undefined;
			crash = false;
			isHealthy.mockReturnValue(true);
			runtime = await EmDashRuntime.create(deps);
			expect(calls).toEqual(["plugin:install", "plugin:install", "plugin:activate"]);
			expect(
				await new PluginStateRepository(runtime.db).get("sandbox-hook-timeout-restart"),
			).toMatchObject({ status: "active" });
		} finally {
			resolveRecovery();
			try {
				runtime ??= await boot;
			} finally {
				vi.useRealTimers();
			}
		}
	});

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

	it.each(["rejects", "exhausts the crash budget"])(
		"defers remaining plugins when refreshed readiness %s after a hook loses the sandbox",
		async (failure) => {
			const firstCalls: string[] = [];
			const deps = createDeps(
				async (name) => {
					firstCalls.push(name);
					isHealthy.mockReturnValue(false);
					throw new SandboxUnavailableError("first-sandbox", "connection lost");
				},
				{},
				"first-sandbox",
			);
			deps.sandboxedPluginEntries[0]!.hooks = ["plugin:install", "plugin:activate"];
			for (const id of ["later-sandbox", "third-sandbox"]) {
				deps.sandboxedPluginEntries.push({ ...deps.sandboxedPluginEntries[0]!, id });
			}
			const laterHook = vi.fn(async () => undefined);
			sandboxHookHandlers.set("later-sandbox", laterHook);
			sandboxHookHandlers.set("third-sandbox", laterHook);
			ensureRunning.mockResolvedValueOnce(undefined);
			if (failure === "rejects") {
				ensureRunning.mockRejectedValueOnce(new Error("restart failed"));
			} else {
				ensureRunning.mockResolvedValueOnce(undefined);
			}

			runtime = await EmDashRuntime.create(deps);
			const states = new PluginStateRepository(runtime.db);
			for (const id of ["first-sandbox", "later-sandbox", "third-sandbox"]) {
				expect(await states.get(id)).toBeNull();
			}
			expect(firstCalls).toEqual(["plugin:install"]);
			expect(laterHook).not.toHaveBeenCalled();
			expect(ensureRunning).toHaveBeenCalledTimes(2);
			expect(setSandboxActive).not.toHaveBeenCalledWith(false);
		},
	);

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
				ensureRunning.mockImplementation(async () => {
					isHealthy.mockReturnValue(false);
				});
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

	it("rolls back a failed sandbox activation during an admin re-enable", async () => {
		const activationAttempts: string[] = [];
		const successfulHook = async (name: string) => {
			activationAttempts.push(name);
			if (name === "plugin:activate") expect(sandboxActive).toBe(true);
		};
		runtime = await EmDashRuntime.create(createDeps(successfulHook));
		const cron = new CronAccessImpl(runtime.db, "sandbox-host", () => undefined);
		await cron.schedule("before-disable", { schedule: "*/5 * * * *" });

		const context = (id = "sandbox-host"): APIContext =>
			({
				params: { id },
				locals: { emdash: runtime, user: { id: "admin-1", role: 50 } },
				request: new Request(`http://test.local/_emdash/api/admin/plugins/${id}`),
			}) as unknown as APIContext;

		expect((await disablePlugin(context())).status).toBe(200);
		expect(sandboxActive).toBe(false);
		expect(
			(
				await runtime.db
					.selectFrom("_emdash_cron_tasks")
					.select("enabled")
					.where("plugin_id", "=", "sandbox-host")
					.execute()
			).map((task) => task.enabled),
		).toEqual([0]);

		const secret = "activation secret must not escape";
		currentInvokeHook = async (name: string) => {
			activationAttempts.push(name);
			if (name === "plugin:activate") {
				expect(sandboxActive).toBe(true);
				await cron.schedule("activation-task", { schedule: "*/5 * * * *" });
				throw new Error(secret);
			}
		};
		const failed = await enablePlugin(context());
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({
			success: false,
			error: { code: "PLUGIN_ENABLE_ERROR", message: "Failed to enable plugin" },
		});
		expect(activationAttempts).toContain("plugin:activate");
		expect((await new PluginStateRepository(runtime.db).get("sandbox-host"))?.status).toBe(
			"inactive",
		);
		expect(
			(
				await runtime.db
					.selectFrom("_emdash_cron_tasks")
					.select("enabled")
					.where("plugin_id", "=", "sandbox-host")
					.execute()
			).map((task) => task.enabled),
		).toEqual([0, 0]);
		expect(sandboxActive).toBe(false);
		expect(runtime.getPluginRouteMeta("sandbox-host", "/ping")).toBeNull();
		const rejected = await runtime.handlePluginApiRoute(
			"sandbox-host",
			"GET",
			"/ping",
			new Request("http://test.local/_emdash/api/plugins/sandbox-host/ping"),
		);
		expect(rejected).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
		expect(sandboxInvokeRoute).not.toHaveBeenCalled();
		await runtime.hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "image.png",
			mimeType: "image/png",
			size: 1,
			url: "/image.png",
			createdAt: new Date().toISOString(),
		});
		expect(activationAttempts).not.toContain("media:afterUpload");

		currentInvokeHook = successfulHook;
		const retried = await enablePlugin(context());
		expect(retried.status).toBe(200);
		expect((await new PluginStateRepository(runtime.db).get("sandbox-host"))?.status).toBe(
			"active",
		);
		expect(sandboxActive).toBe(true);
		expect(runtime.getPluginRouteMeta("sandbox-host", "/ping")).toEqual({ public: false });
		const route = await runtime.handlePluginApiRoute(
			"sandbox-host",
			"GET",
			"/ping",
			new Request("http://test.local/_emdash/api/plugins/sandbox-host/ping"),
		);
		expect(route).toMatchObject({ success: true, data: { status: 200, body: { ok: true } } });
		expect(
			(
				await runtime.db
					.selectFrom("_emdash_cron_tasks")
					.select("enabled")
					.where("plugin_id", "=", "sandbox-host")
					.execute()
			).map((task) => task.enabled),
		).toEqual([1, 1]);
	});

	it("reports cron rollback persistence failures without exposing activation details", async () => {
		runtime = await EmDashRuntime.create(createDeps(async () => undefined));
		const cron = new CronAccessImpl(runtime.db, "sandbox-host", () => undefined);
		await cron.schedule("before-disable", { schedule: "*/5 * * * *" });
		await runtime.handlePluginDisable("sandbox-host");
		await sql`
			CREATE TRIGGER fail_cron_task_rollback
			BEFORE UPDATE OF enabled ON _emdash_cron_tasks
			WHEN NEW.enabled = 0
			BEGIN
				SELECT RAISE(ABORT, 'simulated cron rollback failure');
			END
		`.execute(runtime.db);

		currentInvokeHook = async (name: string) => {
			if (name === "plugin:activate") {
				const activationCron = new CronAccessImpl(runtime!.db, "sandbox-host", () => undefined);
				await activationCron.schedule("activation-task", { schedule: "*/5 * * * *" });
				throw new Error("activation failed");
			}
		};
		const context = {
			params: { id: "sandbox-host" },
			locals: { emdash: runtime, user: { id: "admin-1", role: 50 } },
			request: new Request("http://test.local/_emdash/api/admin/plugins/sandbox-host/enable"),
		} as unknown as APIContext;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const result = await enablePlugin(context);

			expect(result.status).toBe(500);
			expect(await result.json()).toEqual({
				success: false,
				error: { code: "PLUGIN_ENABLE_ERROR", message: "Failed to enable plugin" },
			});
			expect(errorSpy).toHaveBeenCalledWith(
				'EmDash: Failed to disable cron tasks for plugin "sandbox-host":',
				expect.objectContaining({ message: "simulated cron rollback failure" }),
			);
		} finally {
			errorSpy.mockRestore();
		}

		expect(sandboxActive).toBe(false);
		expect(runtime.getPluginRouteMeta("sandbox-host", "/ping")).toBeNull();
		expect((await new PluginStateRepository(runtime.db).get("sandbox-host"))?.status).toBe(
			"inactive",
		);
		expect(
			await runtime.db
				.selectFrom("_emdash_cron_tasks")
				.select(["task_name", "enabled"])
				.where("plugin_id", "=", "sandbox-host")
				.orderBy("task_name")
				.execute(),
		).toEqual([
			{ task_name: "activation-task", enabled: 1 },
			{ task_name: "before-disable", enabled: 0 },
		]);
	});

	it("tolerates a missing cron task table during failed activation rollback", async () => {
		runtime = await EmDashRuntime.create(createDeps(async () => undefined));
		currentInvokeHook = async (name) => {
			if (name === "plugin:activate") throw new Error("activation failed");
		};
		await runtime.handlePluginDisable("sandbox-host");
		await sql`DROP TABLE _emdash_cron_tasks`.execute(runtime.db);

		const context = {
			params: { id: "sandbox-host" },
			locals: { emdash: runtime, user: { id: "admin-1", role: 50 } },
			request: new Request("http://test.local/_emdash/api/admin/plugins/sandbox-host/enable"),
		} as unknown as APIContext;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const result = await enablePlugin(context);

			expect(result.status).toBe(500);
			expect(await result.json()).toEqual({
				success: false,
				error: { code: "PLUGIN_ENABLE_ERROR", message: "Failed to enable plugin" },
			});
			expect(
				errorSpy.mock.calls.some(
					([message]) =>
						message === 'EmDash: Failed to disable cron tasks for plugin "sandbox-host":',
				),
			).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("disables cron tasks when activation rollback persistence fails", async () => {
		const invokeHook = async (name: string) => {
			if (name === "plugin:activate") {
				const cron = new CronAccessImpl(runtime!.db, "sandbox-host", () => undefined);
				await cron.schedule("activation-task", { schedule: "*/5 * * * *" });
				throw new Error("activation failed");
			}
		};
		runtime = await EmDashRuntime.create(createDeps(async () => undefined));
		currentInvokeHook = invokeHook;
		const cron = new CronAccessImpl(runtime.db, "sandbox-host", () => undefined);
		await cron.schedule("before-disable", { schedule: "*/5 * * * *" });
		await runtime.handlePluginDisable("sandbox-host");
		await sql`
			CREATE TRIGGER fail_plugin_activation_rollback
			BEFORE UPDATE OF status ON _plugin_state
			WHEN NEW.status = 'inactive'
			BEGIN
				SELECT RAISE(ABORT, 'simulated rollback failure');
			END
		`.execute(runtime.db);

		const result = await runtime.handlePluginEnable("sandbox-host");

		expect(result).toEqual({
			success: false,
			error: { code: "PLUGIN_ENABLE_ERROR", message: "Failed to enable plugin" },
		});
		expect(sandboxActive).toBe(false);
		expect(runtime.getPluginRouteMeta("sandbox-host", "/ping")).toBeNull();
		expect(
			(
				await runtime.db
					.selectFrom("_emdash_cron_tasks")
					.select("enabled")
					.where("plugin_id", "=", "sandbox-host")
					.execute()
			).map((task) => task.enabled),
		).toEqual([0, 0]);
	});

	it("rolls back a failed trusted plugin activation", async () => {
		let shouldThrow = false;
		const trustedPlugin = definePlugin({
			id: "trusted-host",
			version: "1.0.0",
			capabilities: ["media:read"],
			hooks: {
				"plugin:activate": async () => {
					if (shouldThrow) throw new Error("trusted activation failed");
				},
				"media:afterUpload": async () => undefined,
			},
			routes: {
				ping: { handler: async () => ({ status: 200, body: { ok: true } }) },
			},
		});
		runtime = await EmDashRuntime.create(
			createDeps(vi.fn(), { plugins: [trustedPlugin], sandboxedPluginEntries: [] }),
		);

		shouldThrow = true;
		await runtime.handlePluginDisable("trusted-host");
		const failed = await runtime.handlePluginEnable("trusted-host");
		expect(failed.success).toBe(false);
		expect(runtime.getPluginRouteMeta("trusted-host", "/ping")).toBeNull();
		expect(runtime.hooks.getHookCount("media:afterUpload")).toBe(0);
		expect((await new PluginStateRepository(runtime.db).get("trusted-host"))?.status).toBe(
			"inactive",
		);

		shouldThrow = false;
		const retried = await runtime.handlePluginEnable("trusted-host");
		expect(retried.success).toBe(true);
	});
});
