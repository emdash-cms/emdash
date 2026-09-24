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
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
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
	let warn: MockInstance<typeof console.warn>;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;
	let sent: SentWebhook[];

	beforeEach(async () => {
		sent = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				sent.push({ url, payload: await new Response(init?.body).json() });
				return new Response(null, { status: 200 });
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

		const ctx = new PluginContextFactory({ db: runtime.db }).createContext(plugin);
		await ctx.kv.set("settings:webhookUrl", WEBHOOK_URL);
	});

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
});
