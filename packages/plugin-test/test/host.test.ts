import { createDialect } from "@emdash-cms/cloudflare/db/d1";
import { CloudflareSandboxRunner } from "@emdash-cms/cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { OptionsRepository, type Database, type PluginManifest, type SandboxOptions } from "emdash";
import { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

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
			data: { item: { filename: "checked-restart.png" } },
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

	it("discovers schema, content identity, translations, public URLs, and revisions through Worker Loader", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			site: { url: "https://example.test", locale: "en", trailingSlash: "always" },
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/journal/{slug}",
			fields: [{ slug: "title", label: "Title", type: "string", indexed: true }],
		});
		const english = await runtimeHost.fixtures.content("posts", {
			id: "post-en",
			slug: "hello",
			status: "published",
			locale: "en",
			authorId: "author-1",
			data: { title: "Hello" },
		});
		await runtimeHost.fixtures.content("posts", {
			id: "post-fr",
			slug: "bonjour",
			status: "draft",
			locale: "fr",
			translationOf: english.id,
			data: { title: "Bonjour" },
		});
		const revision = await runtimeHost.fixtures.revision("posts", english.id, {
			title: "Removed history",
		});

		const result = (await runtimeHost.transport.invokeRoute("content-discovery", {
			id: english.id,
		})) as Record<string, any>;
		expect(result.schema).toMatchObject({
			slug: "posts",
			fields: [expect.objectContaining({ slug: "title", indexed: true })],
		});
		expect(result.schema).not.toHaveProperty("id");
		expect(result.item).toMatchObject({
			id: english.id,
			authorId: "author-1",
			translationGroup: english.translationGroup,
			version: 1,
		});
		expect(result.translations.translations).toEqual([
			expect.objectContaining({ id: "post-en", locale: "en" }),
			expect.objectContaining({ id: "post-fr", locale: "fr" }),
		]);
		expect(result.publicUrl).toBe("https://example.test/journal/hello/");
		expect(result.revisions).toEqual([
			expect.objectContaining({ data: { title: "Removed history" } }),
		]);
		await runtimeHost.actions.content.trash("posts", english.id);
		await expect(
			runtimeHost.transport.invokeRoute("revision-discovery", {
				id: english.id,
				revisionId: revision.id,
			}),
		).resolves.toEqual({ list: [], item: null });
	});

	it("creates a translation through the runtime with shared fields, bylines, and taxonomies", async () => {
		runtimeHost = await createPluginRuntimeTestHost({
			i18n: { defaultLocale: "en", locales: ["en", "fr"] },
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "sku", label: "SKU", type: "string", translatable: false },
			],
		});
		const byline = await runtimeHost.fixtures.byline({
			slug: "ada",
			displayName: "Ada Lovelace",
			locale: "en",
		});
		await runtimeHost.fixtures.taxonomy({
			name: "tags",
			slug: "news",
			label: "News",
			locale: "en",
		});
		const source = await runtimeHost.actions.content.create("posts", {
			data: { title: "Hello", sku: "SKU-1" },
			locale: "en",
			bylines: [{ bylineId: byline.id, roleLabel: "Writer" }],
			taxonomies: { tags: ["news"] },
		});
		if (!source.success) throw new Error(source.error.message);
		await vi.waitFor(async () => {
			await expect(
				runtimeHost!.inspect.storage.get("events", source.data.item.id),
			).resolves.toMatchObject({ type: "saved" });
		});

		const translated = (await runtimeHost.transport.invokeRoute("content-translation-create", {
			translationOf: source.data.item.id,
			locale: "fr",
			data: { title: "Bonjour", sku: "IGNORED" },
		})) as { id: string; locale: string; translationGroup: string; data: Record<string, unknown> };

		expect(translated).toMatchObject({
			locale: "fr",
			translationGroup: source.data.item.translationGroup,
			data: { title: "Bonjour [sandbox]", sku: "SKU-1" },
		});
		await expect(runtimeHost.inspect.content.bylines("posts", translated.id)).resolves.toEqual([
			expect.objectContaining({ roleLabel: "Writer" }),
		]);
		await expect(
			runtimeHost.inspect.content.terms("posts", translated.id, "tags", "en"),
		).resolves.toEqual([expect.objectContaining({ slug: "news" })]);
		await expect(
			runtimeHost.transport.invokeRoute("content-translation-error", {
				translationOf: source.data.item.id,
				locale: "fr",
			}),
		).resolves.toMatchObject({ name: "CONFLICT", code: "CONFLICT" });
		await expect(
			runtimeHost.transport.invokeRoute("content-translation-error", {
				translationOf: "missing",
				locale: "fr",
			}),
		).resolves.toMatchObject({ name: "NOT_FOUND", code: "NOT_FOUND" });
		await expect(
			runtimeHost.transport.invokeRoute("content-translation-error", {
				translationOf: source.data.item.id,
				locale: "not_configured",
			}),
		).resolves.toMatchObject({ name: "VALIDATION_ERROR", code: "VALIDATION_ERROR" });
		await expect(
			runtimeHost.transport.invokeRoute("content-save-rejection"),
		).resolves.toMatchObject({ name: "SAVE_REJECTED", code: "SAVE_REJECTED" });
	});

	it("does not re-enter content save hooks for content created inside a save hook", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});

		const result = await runtimeHost.actions.content.create("posts", {
			data: { title: "Original", createCompanion: true },
		});
		expect(result).toMatchObject({
			success: true,
			data: { item: { data: { title: "Original [sandbox]" } } },
		});
		if (!result.success) throw new Error(result.error.message);
		await expect(runtimeHost.inspect.content.list("posts")).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ data: { title: "Original [sandbox]" } }),
				expect.objectContaining({ data: { title: "Companion" } }),
			]),
		);
		await vi.waitFor(async () => {
			await expect(
				runtimeHost!.inspect.storage.get("events", result.data.item.id),
			).resolves.toMatchObject({ type: "saved" });
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

		const due = "2030-01-02T03:04:05.000Z";
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: due },
		});
		await runtimeHost.actions.plugin.deactivate();
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({ name: "runtime-test", enabled: 0 }),
		);
		await runtimeHost.actions.plugin.activate();
		await expect(runtimeHost.inspect.pluginState()).resolves.toMatchObject({
			pluginId: runtimeHost.manifest.id,
			status: "active",
		});
		await expect(
			runtimeHost.inspect.storage
				.list<{ type: string }>("lifecycle")
				.then((entries) => entries.map((entry) => entry.data.type)),
		).resolves.toEqual(["deactivate", "activate"]);

		const media = await runtimeHost.actions.media.upload({
			filename: "pixel.png",
			contentType: "image/png",
			base64:
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
		});
		expect(media.success).toBe(true);
		if (!media.success) throw new Error(media.error.message);
		expect(media.data.item.filename).toBe("checked-pixel.png");
		expect(media.data.item.size).toBe(69);

		const submitted = await runtimeHost.actions.comments.submit({
			collection: "posts",
			contentId: "published-post",
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Useful post",
		});
		expect(submitted.status).toBe(201);
		const submittedBody = (await submitted.json()) as { data: { id: string; status: string } };
		expect(submittedBody.data.status).toBe("pending");
		await runtimeHost.actions.comments.moderate(submittedBody.data.id, "approved", admin);

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
		expect(events).toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({ type: "media-uploaded", size: 69 }),
			}),
		);
		expect(events.map((entry) => (entry.data as { type: string }).type)).toEqual(
			expect.arrayContaining(["media-uploaded", "comment-created", "comment-moderated", "cron"]),
		);
	});

	it("uses one controlled clock for scheduled content and one cron batch", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "scheduler@example.com",
			role: "admin",
		});
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const content = await runtimeHost.fixtures.content("posts", {
			slug: "scheduled-post",
			data: { title: "Scheduled" },
		});
		const due = "2030-01-02T03:04:05.000Z";
		const scheduled = await runtimeHost.actions.content.schedule("posts", content.id, due);
		if (!scheduled.success) throw new Error(scheduled.error.message);

		for (let index = 0; index < 11; index++) {
			await runtimeHost.actions.routes.request("schedule-once", {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body: { at: due, name: `task-${index}` },
			});
		}

		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toEqual({
			processed: 10,
			published: [{ collection: "posts", id: content.id }],
		});
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toHaveLength(1);
	});

	it("runs public comment policy and follows every content-list cursor", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			commentsEnabled: true,
			commentsClosedAfterDays: 1,
		});
		await runtimeHost.fixtures.content("posts", {
			id: "closed-post",
			status: "published",
			publishedAt: "2020-01-01T00:00:00.000Z",
			data: {},
		});

		const response = await runtimeHost.actions.comments.submit({
			collection: "posts",
			contentId: "closed-post",
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Too late",
		});
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "COMMENTS_CLOSED" } });

		for (let index = 0; index < 101; index++) {
			await runtimeHost.fixtures.content("posts", {
				id: `post-${String(index).padStart(3, "0")}`,
				data: {},
			});
		}
		await expect(runtimeHost.inspect.content.list("posts")).resolves.toHaveLength(102);
	});

	it("removes a timezone-less one-shot after it runs", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "local-scheduler@example.com",
			role: "admin",
		});
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: "2030-01-02T03:04:05", name: "local-time" },
		});
		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 1 });
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toEqual([]);
	});

	it("uses the controlled clock to schedule and advance recurring cron tasks", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const admin = await runtimeHost.fixtures.user({
			email: "recurring-scheduler@example.com",
			role: "admin",
		});
		runtimeHost.scheduled.setTime("2030-01-02T03:04:05.000Z");
		await runtimeHost.actions.routes.request("schedule-once", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: { at: "@daily", name: "recurring" },
		});
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({
				name: "recurring",
				nextRunAt: "2030-01-03T00:00:00.000Z",
			}),
		);

		runtimeHost.scheduled.setTime("2030-01-03T00:00:01.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 1 });
		await expect(runtimeHost.inspect.scheduledTasks()).resolves.toContainEqual(
			expect.objectContaining({
				name: "recurring",
				nextRunAt: "2030-01-04T00:00:00.000Z",
			}),
		);
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ processed: 0 });
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
