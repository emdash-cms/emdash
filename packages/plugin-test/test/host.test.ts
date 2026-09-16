import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { OptionsRepository, type Database, type PluginManifest, type SandboxOptions } from "emdash";
import { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	createPluginTestHost,
	type PluginRuntimeTestHost,
	type PluginTestHost,
} from "../src/index.js";

let host: PluginTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("runtime plugin test host", () => {
	let runtimeHost: PluginRuntimeTestHost | undefined;

	afterEach(async () => {
		await runtimeHost?.dispose();
		runtimeHost = undefined;
	});

	it("runs content actions through EmDashRuntime and preserves state across a cold restart", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "never" },
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await expect(runtimeHost.transport.invokeRoute("site-info")).resolves.toEqual({
			name: "EmDash plugin test site",
			url: "https://example.test",
			locale: "en",
			trailingSlash: "never",
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});

		const created = await runtimeHost.actions.content.create("posts", {
			data: { title: "Original" },
		});
		if (!created.success) throw new Error(created.error.message);
		const contentId = created.data.item.id;
		expect(created).toMatchObject({
			success: true,
			data: { item: { data: { title: "Original [sandbox]" } } },
		});
		await expect(runtimeHost.inspect.content.get("posts", contentId)).resolves.toMatchObject({
			id: contentId,
			data: { title: "Original [sandbox]" },
		});

		const before = (await runtimeHost.transport.invokeRoute("isolate-id")) as {
			isolateId: string;
		};
		await runtimeHost.fixtures.plugin.kv("restart-proof", { persisted: true });
		const uploaded = await runtimeHost.actions.media.upload({
			filename: "restart.png",
			contentType: "image/png",
			base64:
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		});
		if (!uploaded.success) throw new Error(uploaded.error.message);
		await runtimeHost.restart();
		const after = (await runtimeHost.transport.invokeRoute("isolate-id")) as {
			isolateId: string;
		};
		expect(after.isolateId).not.toBe(before.isolateId);
		await expect(runtimeHost.inspect.content.get("posts", contentId)).resolves.toMatchObject({
			id: contentId,
		});
		await expect(runtimeHost.inspect.kv.get("restart-proof")).resolves.toEqual({ persisted: true });
		await expect(runtimeHost.inspect.media(uploaded.data.item.id)).resolves.toMatchObject({
			success: true,
			data: { item: { filename: "restart.png" } },
		});
		await expect(
			runtimeHost.actions.content.update("posts", contentId, {
				data: { title: "Restarted" },
			}),
		).resolves.toMatchObject({
			success: true,
			data: { item: { data: { title: "Restarted [sandbox]" } } },
		});
	});

	it("uses the production route dispatcher for authorization, CSRF, and cache policy", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const publicResponse = await runtimeHost.actions.routes.request("isolate-id", {
			method: "GET",
		});
		expect(publicResponse.status).toBe(200);
		expect(publicResponse.headers.get("Cache-Control")).toBe("public, max-age=60");

		const unauthorized = await runtimeHost.actions.routes.request("private-user");
		expect(unauthorized.status).toBe(401);

		const user = await runtimeHost.fixtures.user({
			email: "editor@example.com",
			name: "Editor",
			role: "editor",
		});
		const missingCsrf = await runtimeHost.actions.routes.request("private-user", { user });
		expect(missingCsrf.status).toBe(403);
		const subscriber = await runtimeHost.fixtures.user({
			email: "subscriber@example.com",
			role: "subscriber",
		});
		const forbidden = await runtimeHost.actions.routes.request("private-user", {
			user: subscriber,
			headers: { "X-EmDash-Request": "1" },
		});
		expect(forbidden.status).toBe(403);
		const insufficientScope = await runtimeHost.actions.routes.request("private-user", {
			user,
			tokenScopes: ["content:read"],
		});
		expect(insufficientScope.status).toBe(403);
		const tokenAllowed = await runtimeHost.actions.routes.request("private-user", {
			user,
			tokenScopes: ["admin"],
		});
		expect(tokenAllowed.status).toBe(200);
		const allowed = await runtimeHost.actions.routes.request("private-user", {
			user,
			headers: { "X-EmDash-Request": "1" },
		});
		expect(allowed.status).toBe(200);
		await expect(allowed.json()).resolves.toMatchObject({ data: { userId: user.id } });
	});

	it("replaces the plugin isolate on update and removes it on uninstall", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const before = (await runtimeHost.transport.invokeRoute("isolate-id")) as {
			isolateId: string;
		};
		await runtimeHost.actions.plugin.update("0.2.0");
		const after = (await runtimeHost.transport.invokeRoute("isolate-id")) as {
			isolateId: string;
		};
		expect(after.isolateId).not.toBe(before.isolateId);
		expect(runtimeHost.manifest.version).toBe("0.2.0");
		await expect(runtimeHost.inspect.pluginState()).resolves.toMatchObject({ version: "0.2.0" });

		await runtimeHost.actions.plugin.uninstall(false);
		await expect(runtimeHost.inspect.pluginState()).resolves.toBeNull();
		await expect(runtimeHost.actions.routes.request("isolate-id")).resolves.toMatchObject({
			status: 404,
		});
	});

	it("runs lifecycle, media, comment, scheduler, and email journeys through the isolate", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			commentsEnabled: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await runtimeHost.fixtures.content("posts", {
			id: "published-post",
			status: "published",
			data: { title: "Published" },
		});
		const admin = await runtimeHost.fixtures.user({
			email: "admin@example.com",
			name: "Admin",
			role: "admin",
		});

		await runtimeHost.actions.plugin.install();
		await runtimeHost.actions.plugin.deactivate();
		await runtimeHost.actions.plugin.activate();
		await expect(runtimeHost.inspect.pluginState()).resolves.toMatchObject({
			pluginId: runtimeHost.manifest.id,
			status: "active",
		});
		await expect(
			runtimeHost.inspect.storage
				.list<{ type: string }>("lifecycle")
				.then((entries) => entries.map((entry) => entry.data.type)),
		).resolves.toEqual(["install", "activate", "deactivate", "activate"]);

		const media = await runtimeHost.actions.media.upload({
			filename: "pixel.png",
			contentType: "image/png",
			base64:
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		});
		expect(media.success).toBe(true);

		const submitted = await runtimeHost.actions.comments.submit({
			collection: "posts",
			contentId: "published-post",
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Useful post",
		});
		expect(submitted?.comment.status).toBe("pending");
		await runtimeHost.actions.comments.moderate(submitted!.comment.id, "approved", admin);

		const due = "2030-01-02T03:04:05.000Z";
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: due },
		});
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({ name: "runtime-test", nextRunAt: due }),
		);
		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 1 });
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toEqual([]);

		await runtimeHost.actions.routes.request("send-email", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
		});
		await expect(runtimeHost.inspect.email()).resolves.toContainEqual(
			expect.objectContaining({ to: "author@example.com", subject: "Runtime host" }),
		);
		const events = await runtimeHost.inspect.storage.list("events");
		expect(events.map((entry) => (entry.data as { type: string }).type)).toEqual(
			expect.arrayContaining(["media-uploaded", "comment-created", "comment-moderated", "cron"]),
		);
	});

	it("clears database and isolate state when disposed", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({ slug: "temporary", label: "Temporary" });
		await runtimeHost.dispose();
		runtimeHost = await createPluginRuntimeTestHost();
		await expect(runtimeHost.inspect.content.list("temporary")).rejects.toThrow();
	});
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
