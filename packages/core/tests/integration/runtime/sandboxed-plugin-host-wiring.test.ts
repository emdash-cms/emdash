import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
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

function createDeps(
	invokeHook: SandboxedPluginInstance["invokeHook"],
	overrides: Partial<RuntimeDependencies> = {},
	pluginId = "sandbox-host",
): RuntimeDependencies {
	currentInvokeHook = invokeHook;
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn(async (manifest: { id: string; version: string }) => ({
			id: `${manifest.id}:${manifest.version}`,
			invokeHook: (...args: Parameters<SandboxedPluginInstance["invokeHook"]>) =>
				currentInvokeHook(...args),
			invokeRoute: vi.fn(),
			terminate: vi.fn(),
		})),
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
});
