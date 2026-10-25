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
let sandboxActive = false;
let sandboxInvokeRoute: ReturnType<typeof vi.fn> = vi.fn();

function createDeps(
	invokeHook: SandboxedPluginInstance["invokeHook"],
	overrides: Partial<RuntimeDependencies> = {},
	pluginId = "sandbox-host",
): RuntimeDependencies {
	currentInvokeHook = invokeHook;
	loadedSandboxCapabilities = [];
	sandboxActive = false;
	sandboxInvokeRoute = vi.fn(async () => ({ status: 200, body: { ok: true } }));
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (manifest: { id: string; version: string; capabilities: string[] }) => {
			loadedSandboxCapabilities = [...manifest.capabilities];
			return {
				id: `${manifest.id}:${manifest.version}`,
				invokeHook: (...args: Parameters<SandboxedPluginInstance["invokeHook"]>) =>
					currentInvokeHook(...args),
				invokeRoute: sandboxInvokeRoute,
				setActive: (active: boolean) => {
					sandboxActive = active;
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
		runtime = await EmDashRuntime.create(
			createDeps(async (name) => {
				if (name === "plugin:activate") throw new Error("activation failed");
			}),
		);
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
		runtime = await EmDashRuntime.create(createDeps(invokeHook));
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
