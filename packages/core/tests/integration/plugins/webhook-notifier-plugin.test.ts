/**
 * Boots a runtime with the plugin's manifest and sandbox entry, as a site that
 * bundles it does; the hook pipeline drops hooks the manifest does not cover.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { parse as parseJsonc } from "jsonc-parser";
import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import webhookNotifier from "../../../../plugins/webhook-notifier/src/plugin.js";
import type { PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { adaptSandboxEntry } from "../../../src/plugins/adapt-sandbox-entry.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import type { PluginContext, ResolvedPlugin } from "../../../src/plugins/types.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

const MANIFEST_URL = new URL(
	"../../../../plugins/webhook-notifier/emdash-plugin.jsonc",
	import.meta.url,
);

const WEBHOOK_URL = "https://hooks.example.com/emdash";

interface WebhookNotifierManifest {
	slug: string;
	capabilities: string[];
	allowedHosts: string[];
	storage: Record<string, { indexes?: string[]; uniqueIndexes?: string[] }>;
}

interface SentWebhook {
	url: string;
	payload: unknown;
}

function loadWebhookNotifierPlugin(): ResolvedPlugin {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the manifest is validated by the plugin CLI; the test only reads the trust contract
	const manifest = parseJsonc(readFileSync(MANIFEST_URL, "utf8")) as WebhookNotifierManifest;
	const descriptor: PluginDescriptor = {
		id: manifest.slug,
		version: "0.0.0-test",
		entrypoint: "@emdash-cms/plugin-webhook-notifier/sandbox",
		format: "standard",
		capabilities: manifest.capabilities,
		allowedHosts: manifest.allowedHosts,
		storage: manifest.storage,
	};
	return adaptSandboxEntry(webhookNotifier, descriptor);
}

describe("webhook-notifier plugin", () => {
	let runtime: EmDashRuntime;
	let ctx: PluginContext;
	let warn: MockInstance<typeof console.warn>;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;
	let sent: SentWebhook[];
	let responseStatus: number;

	beforeEach(async () => {
		sent = [];
		responseStatus = 200;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				sent.push({ url, payload: await new Response(init?.body).json() });
				return new Response(null, { status: responseStatus });
			}),
		);
		previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const plugin = loadWebhookNotifierPlugin();
		const sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create({
			config: {
				database: {
					entrypoint: `test-webhook-notifier-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
			},
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			plugins: [plugin],
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		});

		await runtime.schemaRegistry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await runtime.schemaRegistry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
		});

		ctx = new PluginContextFactory({ db: runtime.db }).createContext(plugin);
		await ctx.kv.set("settings:webhookUrl", WEBHOOK_URL);
	});

	async function createPost(title: string) {
		const created = await runtime.handleContentCreate("post", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			status: "draft",
		});
		if (!created.success) throw new Error("create failed");
		await waitForDeferredTasks();
		return created.data.item;
	}

	async function uploadPhoto() {
		const created = await runtime.handleMediaCreate({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			size: 1234,
			storageKey: "photo.jpg",
		});
		if (!created.success) throw new Error("media create failed");
		return created.data.item;
	}

	afterEach(async () => {
		await waitForDeferredTasks();
		await runtime?.stopCron();
		warn.mockRestore();
		setDefaultDnsResolver(previousResolver);
		vi.unstubAllGlobals();
	});

	it("posts a webhook when content is saved", async () => {
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Hello" },
			slug: "hello",
			status: "draft",
		});
		if (!created.success) throw new Error("create failed");
		await waitForDeferredTasks();

		expect(sent).toContainEqual({
			url: WEBHOOK_URL,
			payload: expect.objectContaining({
				event: "content:create",
				collection: "post",
				resourceId: created.data.item.id,
			}),
		});
	});

	it("posts a webhook when content is deleted", async () => {
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Goodbye" },
			slug: "goodbye",
			status: "draft",
		});
		if (!created.success) throw new Error("create failed");
		await waitForDeferredTasks();

		const deleted = await runtime.handleContentDelete("post", created.data.item.id);
		expect(deleted.success).toBe(true);
		await waitForDeferredTasks();

		expect(sent).toContainEqual({
			url: WEBHOOK_URL,
			payload: expect.objectContaining({
				event: "content:delete",
				collection: "post",
				resourceId: created.data.item.id,
			}),
		});
	});

	it("posts a webhook when media is uploaded", async () => {
		const created = await runtime.handleMediaCreate({
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			size: 1234,
			storageKey: "photo.jpg",
		});
		if (!created.success) throw new Error("media create failed");

		await vi.waitFor(() =>
			expect(sent).toContainEqual({
				url: WEBHOOK_URL,
				payload: expect.objectContaining({
					event: "media:upload",
					resourceId: created.data.item.id,
				}),
			}),
		);
	});

	it("sends no content webhooks when the site sends media uploads only", async () => {
		await ctx.kv.set("settings:events", "media");

		await createPost("Hello");
		const photo = await uploadPhoto();

		await vi.waitFor(() =>
			expect(sent).toContainEqual({
				url: WEBHOOK_URL,
				payload: expect.objectContaining({ event: "media:upload", resourceId: photo.id }),
			}),
		);
		expect(sent).toHaveLength(1);
	});

	it("sends no delete webhooks when the site sends media uploads only", async () => {
		const post = await createPost("Goodbye");
		await ctx.kv.set("settings:events", "media");

		const deleted = await runtime.handleContentDelete("post", post.id);
		expect(deleted.success).toBe(true);
		await waitForDeferredTasks();

		expect(sent.map((webhook) => webhook.payload)).toEqual([
			expect.objectContaining({ event: "content:create" }),
		]);
	});

	it("sends no media webhooks when the site sends content changes only", async () => {
		await ctx.kv.set("settings:events", "content");

		await runtime.hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			size: 1234,
			url: "/media/media-1/photo.jpg",
			createdAt: new Date().toISOString(),
		});

		expect(sent).toEqual([]);
	});

	it("adds the saved fields to content payloads only when Include Content Data is on", async () => {
		const withoutData = await createPost("Without data");
		await ctx.kv.set("settings:includeData", true);
		const withData = await createPost("With data");

		expect(sent).toEqual([
			{
				url: WEBHOOK_URL,
				payload: expect.objectContaining({ resourceId: withoutData.id }),
			},
			{
				url: WEBHOOK_URL,
				payload: expect.objectContaining({
					resourceId: withData.id,
					data: { title: "With data" },
				}),
			},
		]);
		expect(sent[0]?.payload).not.toHaveProperty("data");
	});

	it("names the draft revision when content data is an unpublished edit", async () => {
		await runtime.schemaRegistry.createCollection({
			slug: "article",
			label: "Articles",
			labelSingular: "Article",
			supports: ["revisions"],
		});
		await runtime.schemaRegistry.createField("article", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await ctx.kv.set("settings:includeData", true);

		const created = await runtime.handleContentCreate("article", {
			data: { title: "Live" },
			slug: "live",
		});
		if (!created.success) throw new Error("create failed");
		const published = await runtime.handleContentPublish("article", created.data.item.id);
		expect(published.success).toBe(true);
		const edited = await runtime.handleContentUpdate("article", created.data.item.id, {
			data: { title: "Unpublished edit" },
		});
		if (!edited.success) throw new Error("update failed");
		await waitForDeferredTasks();

		expect(edited.data.item.draftRevisionId).toEqual(expect.any(String));
		expect(sent).toContainEqual({
			url: WEBHOOK_URL,
			payload: expect.objectContaining({
				event: "content:update",
				data: { title: "Unpublished edit" },
				metadata: {
					slug: "live",
					status: "published",
					draftRevisionId: edited.data.item.draftRevisionId,
				},
			}),
		});
	});

	it("adds the file's name, type and size to media payloads only when Include Content Data is on", async () => {
		const withoutData = await uploadPhoto();
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		await ctx.kv.set("settings:includeData", true);
		const withData = await uploadPhoto();

		await vi.waitFor(() =>
			expect(sent).toEqual([
				{
					url: WEBHOOK_URL,
					payload: expect.objectContaining({ resourceId: withoutData.id }),
				},
				{
					url: WEBHOOK_URL,
					payload: expect.objectContaining({
						resourceId: withData.id,
						data: { filename: "photo.jpg", mimeType: "image/jpeg", size: 1234 },
					}),
				},
			]),
		);
		expect(sent[0]?.payload).not.toHaveProperty("data");
	});

	it("records each delivery and counts it in the status stats", async () => {
		const delivered = await createPost("Delivered");
		responseStatus = 500;
		const failed = await createPost("Failed");

		const status = await runtime.handlePluginApiRoute(
			"webhook-notifier",
			"GET",
			"status",
			new Request("http://localhost/_emdash/api/plugins/webhook-notifier/status"),
		);
		expect(status).toMatchObject({
			success: true,
			data: { stats: { successful: 1, failed: 1 } },
		});

		const { items } = await ctx.storage.deliveries!.query();
		expect(items.map((item) => item.data)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					event: "content:create",
					resourceId: delivered.id,
					webhookUrl: WEBHOOK_URL,
					status: "success",
					httpStatus: 200,
				}),
				expect.objectContaining({
					event: "content:create",
					resourceId: failed.id,
					webhookUrl: WEBHOOK_URL,
					status: "failed",
					httpStatus: 500,
				}),
			]),
		);
	});

	it("records a delivery to a URL the webhook URL check refuses as failed", async () => {
		await ctx.kv.set("settings:webhookUrl", "http://localhost:8080/hook");

		const post = await createPost("Refused");

		expect(sent).toEqual([]);
		const { items } = await ctx.storage.deliveries!.query();
		expect(items.map((item) => item.data)).toEqual([
			expect.objectContaining({
				resourceId: post.id,
				webhookUrl: "http://localhost:8080/hook",
				status: "failed",
				error: expect.any(String),
			}),
		]);
	});

	it("keeps only the newest 500 delivery records", async () => {
		const deliveries = ctx.storage.deliveries!;
		await deliveries.putMany(
			Array.from({ length: 500 }, (_, i) => ({
				id: `old-${i}`,
				data: {
					timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
					webhookUrl: WEBHOOK_URL,
					event: "content:update",
					status: "success",
				},
			})),
		);

		const post = await createPost("Newest");

		expect(await deliveries.count()).toBe(500);
		expect(await deliveries.exists("old-0")).toBe(false);
		expect(await deliveries.exists("old-1")).toBe(true);
		const newest = await deliveries.query({ orderBy: { timestamp: "desc" }, limit: 1 });
		expect(newest.items[0]?.data).toMatchObject({ resourceId: post.id });
	});

	it("prunes a backlog past one query page down to the cap", async () => {
		const deliveries = ctx.storage.deliveries!;
		await deliveries.putMany(
			Array.from({ length: 650 }, (_, i) => ({
				id: `old-${i}`,
				data: {
					timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
					webhookUrl: WEBHOOK_URL,
					event: "content:update",
					status: "success",
				},
			})),
		);

		const post = await createPost("Newest after backlog");

		expect(await deliveries.count()).toBe(500);
		const newest = await deliveries.query({ orderBy: { timestamp: "desc" }, limit: 1 });
		expect(newest.items[0]?.data).toMatchObject({ resourceId: post.id });
	});
});
