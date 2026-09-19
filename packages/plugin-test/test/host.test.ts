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

	it("enforces publication policy through Worker Loader for every action origin", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const editor = await runtimeHost.fixtures.user({
			email: "policy-editor@example.com",
			role: "editor",
		});
		const content = await runtimeHost.fixtures.content("posts", {
			slug: "policy-post",
			data: { title: "Policy post" },
		});

		const origins = [
			{ origin: { source: "api" as const }, actor: { id: editor.id, role: editor.role } },
			{ origin: { source: "mcp" as const }, actor: { id: editor.id, role: editor.role } },
			{
				origin: { source: "visual-editor" as const },
				actor: { id: editor.id, role: editor.role },
			},
			{ origin: { source: "plugin" as const, pluginId: "review-cycle" } },
			{ origin: { source: "system" as const } },
		];
		let revision: string | undefined;
		for (const action of origins) {
			const result = await runtimeHost.actions.content.publish("posts", content.id, {
				_rev: revision,
				...action,
			});
			if (!result.success) throw new Error(result.error.message);
			revision = result.data._rev;
		}

		const beforeStale = await runtimeHost.inspect.storage.list("events");
		await expect(
			runtimeHost.actions.content.publish("posts", content.id, {
				_rev: "stale-revision",
				origin: { source: "api" },
				actor: { id: editor.id, role: editor.role },
			}),
		).resolves.toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await runtimeHost.inspect.storage.list("events")).toHaveLength(beforeStale.length);

		await runtimeHost.fixtures.plugin.kv(
			"policy:content:beforeUnpublish",
			"Legal approval is required.",
		);
		await expect(
			runtimeHost.actions.content.unpublish("posts", content.id, {
				_rev: revision,
				origin: { source: "mcp" },
				actor: { id: editor.id, role: editor.role },
			}),
		).resolves.toMatchObject({
			success: false,
			error: { code: "UNPUBLISH_REJECTED", message: "Legal approval is required." },
		});
		await expect(runtimeHost.inspect.content.get("posts", content.id)).resolves.toMatchObject({
			status: "published",
		});

		const scheduledContent = await runtimeHost.fixtures.content("posts", {
			slug: "scheduled-policy-post",
			data: { title: "Scheduled policy post" },
		});
		const due = "2030-01-02T03:04:05.000Z";
		const scheduled = await runtimeHost.actions.content.schedule(
			"posts",
			scheduledContent.id,
			due,
			{ origin: { source: "system" } },
		);
		if (!scheduled.success) throw new Error(scheduled.error.message);
		await runtimeHost.fixtures.plugin.kv(
			"policy:content:beforePublish",
			"A reviewer must approve this entry.",
		);
		runtimeHost.scheduled.setTime("2030-01-02T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ published: [] });
		await expect(
			runtimeHost.inspect.content.get("posts", scheduledContent.id),
		).resolves.toMatchObject({ status: "draft", scheduledAt: null });
		await expect(runtimeHost.inspect.scheduledPolicyRejections()).resolves.toContainEqual(
			expect.objectContaining({
				collection: "posts",
				id: scheduledContent.id,
				pluginId: runtimeHost.manifest.id,
				reason: "A reviewer must approve this entry.",
			}),
		);
		await runtimeHost.fixtures.plugin.kv("policy:content:beforePublish", null);
		const rescheduled = await runtimeHost.actions.content.schedule(
			"posts",
			scheduledContent.id,
			"2031-01-01T00:00:00.000Z",
			{ origin: { source: "api" }, actor: { id: editor.id, role: editor.role } },
		);
		if (!rescheduled.success) throw new Error(rescheduled.error.message);
		await expect(runtimeHost.inspect.scheduledPolicyRejections()).resolves.toEqual([]);

		const retryableContent = await runtimeHost.fixtures.content("posts", {
			slug: "retryable-policy-post",
			data: { title: "Retryable policy post" },
		});
		const retryable = await runtimeHost.actions.content.schedule(
			"posts",
			retryableContent.id,
			"2030-01-03T03:04:05.000Z",
			{ origin: { source: "system" } },
		);
		if (!retryable.success) throw new Error(retryable.error.message);
		await runtimeHost.fixtures.plugin.kv("policy:content:beforePublish", "__invalid__");
		runtimeHost.scheduled.setTime("2030-01-03T03:04:06.000Z");
		await expect(runtimeHost.scheduled.run()).resolves.toMatchObject({ published: [] });
		await expect(
			runtimeHost.inspect.content.get("posts", retryableContent.id),
		).resolves.toMatchObject({
			status: "scheduled",
			scheduledAt: "2030-01-03T03:04:05.000Z",
		});

		const policyEvents = (await runtimeHost.inspect.storage.list("events"))
			.map(
				(entry) =>
					entry.data as {
						type: string;
						hook?: string;
						origin?: { source: string };
						actor?: { source?: string };
					},
			)
			.filter((entry) => entry.type === "content-policy");
		expect(policyEvents.map((event) => event.origin?.source)).toEqual(
			expect.arrayContaining(["api", "mcp", "visual-editor", "plugin", "scheduler", "system"]),
		);
		expect(
			policyEvents.find((event) => event.origin?.source === "visual-editor")?.actor,
		).toMatchObject({ source: "visual-editor" });
		expect(policyEvents.find((event) => event.origin?.source === "plugin")?.actor).toBeUndefined();
	});

	it("runs versioned publication and restore actions through Worker Loader", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			routable: true,
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		const admin = await runtimeHost.fixtures.user({
			email: "publication-actions@example.com",
			role: "admin",
		});
		const content = await runtimeHost.fixtures.content("posts", {
			slug: "publication-actions",
			data: { title: "Publication actions" },
		});
		const invoke = async (body: Record<string, unknown>) => {
			const response = await runtimeHost!.actions.routes.request("content-action", {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body,
			});
			expect(response.status).toBe(200);
			const json: unknown = await response.json();
			if (
				typeof json !== "object" ||
				json === null ||
				!("data" in json) ||
				typeof json.data !== "object" ||
				json.data === null
			) {
				throw new Error("Expected versioned action response");
			}
			return json.data as {
				item: { id: string; status: string; scheduledAt?: string | null };
				_rev: string;
			};
		};

		let current = await invoke({
			action: "getVersioned",
			collection: "posts",
			id: content.id,
		});
		await runtimeHost.fixtures.plugin.kv("policy:reenter-publish", true);
		const reentrant = await runtimeHost.actions.routes.request("content-action", {
			user: admin,
			headers: { "X-EmDash-Request": "1" },
			body: {
				action: "publish",
				collection: "posts",
				id: "publication-actions",
				_rev: current._rev,
			},
		});
		expect(reentrant.status).toBe(200);
		await expect(reentrant.json()).resolves.toMatchObject({
			data: { actionError: { code: "PUBLISH_REJECTED" } },
		});
		await expect(runtimeHost.inspect.content.get("posts", content.id)).resolves.toMatchObject({
			status: "draft",
		});
		await expect(runtimeHost.inspect.storage.list("events")).resolves.toContainEqual(
			expect.objectContaining({
				data: expect.objectContaining({
					type: "content-action-rejected",
					code: "CONTENT_ACTION_REENTRANT",
				}),
			}),
		);
		await runtimeHost.fixtures.plugin.kv("policy:reenter-publish", false);
		current = await invoke({
			action: "publish",
			collection: "posts",
			id: content.id,
			_rev: current._rev,
		});
		expect(current.item.status).toBe("published");
		current = await invoke({
			action: "unpublish",
			collection: "posts",
			id: content.id,
			_rev: current._rev,
		});
		expect(current.item.status).toBe("draft");
		current = await invoke({
			action: "schedule",
			collection: "posts",
			id: content.id,
			scheduledAt: "2031-01-01T00:00:00.000Z",
			_rev: current._rev,
		});
		expect(current.item.scheduledAt).toBe("2031-01-01T00:00:00.000Z");
		current = await invoke({
			action: "unschedule",
			collection: "posts",
			id: content.id,
			_rev: current._rev,
		});
		expect(current.item.scheduledAt).toBeNull();

		await runtimeHost.actions.content.trash("posts", content.id);
		const trashed = await invoke({
			action: "getTrashedVersioned",
			collection: "posts",
			id: content.id,
		});
		const restored = await invoke({
			action: "restore",
			collection: "posts",
			id: content.id,
			_rev: trashed._rev,
		});
		expect(restored.item.id).toBe(content.id);
		await vi.waitFor(async () => {
			for (const action of ["publish", "unpublish", "schedule", "unschedule", "restore"]) {
				await expect(
					runtimeHost!.inspect.storage.get("events", `action:${action}:${content.id}`),
				).resolves.toMatchObject({ type: "content-action", action, contentId: content.id });
			}
		});
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
