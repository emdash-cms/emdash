import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { OptionsRepository, type Database, type PluginManifest, type SandboxOptions } from "emdash";
import { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginTestHost, type PluginTestHost } from "../src/index.js";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("plugin test host", () => {
	it("loads the built plugin through Worker Loader and persists host state", async () => {
		host = await createPluginTestHost();
		expect(host.manifest.routes).toContainEqual({
			name: "hello",
			public: true,
			cacheControl: "public, max-age=60",
		});
		expect(host.manifest.routes).toContainEqual({
			name: "content-count",
			permission: "content:read",
		});
		expect(host.manifest.admin.settingsSchema).toHaveProperty("enabled");
		expect(host.manifest.admin.fieldWidgets?.[0]).toMatchObject({ name: "event-picker" });

		await expect(host.invokeRoute("hello")).resolves.toEqual({
			pluginId: "plugin-test-fixture",
		});
		await expect(host.kv.get("last-route")).resolves.toBe("hello");

		await host.invokeHook("content:afterSave", {
			collection: "posts",
			content: { id: "post-1" },
		});
		await expect(host.storage("events").get("post-1")).resolves.toEqual({
			type: "saved",
			collection: "posts",
		});
	});

	it("uses a migrated D1 database for content bridge calls", async () => {
		host = await createPluginTestHost();
		await host.createCollection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await host.seedContent("posts", [{ title: "First" }, { title: "Second" }]);

		await expect(host.invokeRoute("content-count")).resolves.toEqual({ count: 2 });
	});

	it("makes auto-generated admin settings visible inside the Worker Loader isolate", async () => {
		host = await createPluginTestHost();
		const db = new Kysely<Database>({
			dialect: createDialect({ binding: "DB", session: "disabled" }),
		});
		try {
			await new OptionsRepository(db).set(`plugin:${host.manifest.id}:settings:enabled`, false);
			await expect(host.invokeRoute("settings-value")).resolves.toEqual({ enabled: false });
			await expect(host.invokeRoute("settings-update", { enabled: true })).resolves.toEqual({
				enabled: true,
			});
			await expect(
				new OptionsRepository(db).get(`plugin:${host.manifest.id}:settings:enabled`),
			).resolves.toBe(true);
		} finally {
			await db.destroy();
		}
	});

	it("delivers a real host content event to the Worker Loader isolate", async () => {
		const bindings = env as unknown as {
			EMDASH_PLUGIN_CODE: string;
			EMDASH_PLUGIN_MANIFEST: string;
		};
		const manifest = JSON.parse(bindings.EMDASH_PLUGIN_MANIFEST) as PluginManifest;
		const runtimeModuleUrl = new URL("../../core/src/emdash-runtime.ts", import.meta.url).href;
		const { EmDashRuntime } = await import(/* @vite-ignore */ runtimeModuleUrl);
		const entry = {
			id: manifest.id,
			version: manifest.version,
			options: {},
			code: bindings.EMDASH_PLUGIN_CODE,
			capabilities: manifest.capabilities,
			allowedHosts: manifest.allowedHosts,
			storage: manifest.storage,
			hooks: manifest.hooks,
			routes: manifest.routes,
			settingsSchema: manifest.admin.settingsSchema,
			fieldWidgets: manifest.admin.fieldWidgets,
		};
		const deps = {
			config: {
				database: {
					entrypoint: `plugin-test-runtime-${crypto.randomUUID()}`,
					type: "sqlite" as const,
					config: { binding: "DB" },
				},
			},
			plugins: [],
			createDialect: () => createDialect({ binding: "DB", session: "disabled" }),
			createStorage: null,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [entry],
			createSandboxRunner: (options: SandboxOptions) => new CloudflareSandboxRunner(options),
		};
		const runtime = await EmDashRuntime.create(deps);
		try {
			await runtime.schemaRegistry.createCollection({
				slug: "posts",
				label: "Posts",
				labelSingular: "Post",
			});
			await runtime.schemaRegistry.createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});

			const result = await runtime.handleContentCreate("posts", {
				data: { title: "Original" },
			});
			expect(result).toMatchObject({
				success: true,
				data: { item: { data: { title: "Original [sandbox]" } } },
			});
		} finally {
			await runtime.getSandboxRunner()?.terminateAll();
			await runtime.stopCron();
		}
	});
});
