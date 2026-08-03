import type { PluginContext } from "emdash";
import { describe, it, expect, vi } from "vitest";

const { uploads, deletions, createConfigs, controls, pendingUploads, fakeEnv } = vi.hoisted(() => {
	const captured: Array<{
		key: string;
		content: string;
		metadata: Record<string, unknown>;
	}> = [];
	const removed: string[] = [];
	const configs: Array<Record<string, unknown>> = [];
	const state = {
		uploadFailures: 0,
		holdUploads: false,
		instanceMissing: false,
		searchError: null as Error | null,
		searchChunks: [] as Array<Record<string, unknown>>,
		searchRequests: [] as Array<Record<string, unknown>>,
	};
	const pending = new Map<
		string,
		{ resolve: (item: { id: string }) => void; reject: (error: Error) => void }
	>();
	const instance = {
		info: () =>
			state.instanceMissing
				? Promise.reject(new Error("instance not found"))
				: Promise.resolve({ id: "emdash-content" }),
		search: (request: Record<string, unknown>) => {
			state.searchRequests.push(request);
			return state.searchError
				? Promise.reject(state.searchError)
				: Promise.resolve({ search_query: "query", chunks: state.searchChunks });
		},
		items: {
			upload: (key: string, content: string, options?: { metadata?: Record<string, unknown> }) => {
				if (state.uploadFailures > 0) {
					state.uploadFailures--;
					return Promise.reject(new Error("upload failed"));
				}
				captured.push({ key, content, metadata: options?.metadata ?? {} });
				const item = { id: `item-${captured.length}` };
				if (!state.holdUploads) return Promise.resolve(item);
				return new Promise<{ id: string }>((resolve, reject) => {
					pending.set(key, { resolve, reject });
				});
			},
			delete: (id: string) => {
				removed.push(id);
				return Promise.resolve();
			},
		},
	};
	const namespace = {
		get: () => instance,
		create: (config: Record<string, unknown>) => {
			configs.push(config);
			return Promise.resolve(instance);
		},
	};
	return {
		uploads: captured,
		deletions: removed,
		createConfigs: configs,
		controls: state,
		pendingUploads: pending,
		fakeEnv: { AI_SEARCH: namespace },
	};
});

vi.mock("cloudflare:workers", () => ({ env: fakeEnv, waitUntil: () => {} }));

const { createPlugin, handleAISearchSnippetRequest, unpackTitleDescription } =
	await import("../../src/plugins/ai-search.js");

function makeContext(content?: PluginContext["content"]): PluginContext {
	const store = new Map<string, unknown>();
	const kv = {
		get: async <T>(key: string) => (store.has(key) ? (store.get(key) as T) : null),
		set: async (key: string, value: unknown) => void store.set(key, value),
		delete: async (key: string) => void store.delete(key),
		list: async (prefix: string) =>
			[...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
	};
	return {
		kv,
		content,
		cron: {
			schedule: vi.fn(),
			cancel: vi.fn(),
			list: vi.fn().mockResolvedValue([]),
		},
		site: { name: "Test", url: "http://localhost", locale: "en" },
	} as unknown as PluginContext;
}

function routeContext(ctx: PluginContext, input: Record<string, unknown>, method = "POST") {
	return {
		...ctx,
		input,
		request: new Request("http://localhost/_emdash/api/plugins/ai-search/reindex", { method }),
	};
}

function snippetRequest(body: unknown): Request {
	return new Request("https://example.com/api/ai-search/search", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function snippetOptions(ctx: PluginContext, config = {}) {
	return { config, kv: ctx.kv, defaultLocale: "en" };
}

async function runReindexCron(plugin: ReturnType<typeof createPlugin>, ctx: PluginContext) {
	await plugin.hooks.cron!.handler(
		{ name: "reindex", scheduledAt: "2026-01-01T00:00:00.000Z" },
		ctx,
	);
}

describe("ai-search reindex jobs", () => {
	it("processes two pages per cron tick and resumes from its persisted cursor", async () => {
		uploads.length = 0;
		const items = Array.from({ length: 101 }, (_, index) => ({
			id: `post-${index}`,
			type: "posts",
			slug: `post-${index}`,
			status: "published",
			locale: "en-us",
			data: { title: `Post ${index}`, content: `Body ${index}` },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			publishedAt: "2026-01-01T00:00:00.000Z",
		}));
		const cursors: Array<string | undefined> = [];
		const ctx = makeContext({
			get: vi.fn(),
			list: async (_collection, options) => {
				cursors.push(options?.cursor);
				const start = Number(options?.cursor ?? 0);
				const next = start + 50;
				return {
					items: items.slice(start, next),
					...(next < items.length ? { cursor: String(next), hasMore: true } : { hasMore: false }),
				};
			},
		} as PluginContext["content"]);
		const plugin = createPlugin();
		const handler = plugin.routes.reindex!.handler;

		const started = (await handler(
			routeContext(ctx, { collections: ["posts"] }) as never,
		)) as Record<string, unknown>;
		expect(started.done).toBe(false);
		expect(started.indexed).toBe(0);
		expect(uploads).toHaveLength(0);

		await runReindexCron(plugin, ctx);
		const firstTick = (await handler(routeContext(ctx, {}, "GET") as never)) as Record<
			string,
			unknown
		>;
		expect(firstTick.done).toBe(false);
		expect(firstTick.indexed).toBe(100);

		await runReindexCron(plugin, ctx);
		const complete = (await handler(routeContext(ctx, {}, "GET") as never)) as Record<
			string,
			unknown
		>;
		expect(complete.done).toBe(true);
		expect(complete.indexed).toBe(101);
		expect(cursors).toEqual([undefined, "50", "100"]);
	});

	it("uploads a page concurrently and checkpoints each accepted upload", async () => {
		uploads.length = 0;
		pendingUploads.clear();
		controls.uploadFailures = 0;
		controls.holdUploads = true;
		const items = Array.from({ length: 3 }, (_, index) => ({
			id: `concurrent-${index}`,
			type: "posts",
			slug: `concurrent-${index}`,
			status: "published",
			locale: "en-us",
			data: { title: `Concurrent ${index}`, content: `Body ${index}` },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			publishedAt: "2026-01-01T00:00:00.000Z",
		}));
		const ctx = makeContext({
			get: vi.fn(),
			list: async () => ({ items, hasMore: false }),
		} as PluginContext["content"]);
		const plugin = createPlugin();
		const handler = plugin.routes.reindex!.handler;

		await handler(routeContext(ctx, { collections: ["posts"] }) as never);
		const cron = runReindexCron(plugin, ctx);

		await vi.waitFor(() => expect(pendingUploads.size).toBe(3));
		expect(uploads.map((upload) => upload.key)).toEqual([
			"posts/concurrent-0.md",
			"posts/concurrent-1.md",
			"posts/concurrent-2.md",
		]);

		pendingUploads.get("posts/concurrent-1.md")!.resolve({ id: "accepted-1" });
		await vi.waitFor(async () => {
			const progress = (await handler(routeContext(ctx, {}, "GET") as never)) as Record<
				string,
				unknown
			>;
			expect(progress.indexed).toBe(1);
		});

		pendingUploads.get("posts/concurrent-0.md")!.resolve({ id: "accepted-0" });
		pendingUploads.get("posts/concurrent-2.md")!.resolve({ id: "accepted-2" });
		await cron;
		controls.holdUploads = false;

		const complete = (await handler(routeContext(ctx, {}, "GET") as never)) as Record<
			string,
			unknown
		>;
		expect(complete.done).toBe(true);
		expect(complete.indexed).toBe(3);
	});

	it("overwrites an item already mirrored by EmDash without deleting it first", async () => {
		uploads.length = 0;
		deletions.length = 0;
		controls.uploadFailures = 0;
		const ctx = makeContext({
			get: vi.fn(),
			list: async () => ({
				items: [
					{
						id: "existing",
						type: "posts",
						slug: "existing",
						status: "published",
						locale: "en-us",
						data: { title: "Existing", content: "Updated body" },
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
						publishedAt: "2026-01-01T00:00:00.000Z",
					},
				],
				hasMore: false,
			}),
		} as PluginContext["content"]);
		await ctx.kv.set("item:posts/existing.md", "old-item-id");
		const plugin = createPlugin();
		const handler = plugin.routes.reindex!.handler;

		await handler(routeContext(ctx, { collections: ["posts"] }) as never);
		await runReindexCron(plugin, ctx);

		expect(uploads).toHaveLength(1);
		expect(uploads[0]?.key).toBe("posts/existing.md");
		expect(deletions).toHaveLength(0);
		expect(await ctx.kv.get("item:posts/existing.md")).toBe("item-1");
	});

	it("preserves the mirrored item when replacement uploads exhaust their retries", async () => {
		uploads.length = 0;
		deletions.length = 0;
		controls.uploadFailures = 3;
		const ctx = makeContext({
			get: vi.fn(),
			list: async () => ({
				items: [
					{
						id: "broken",
						type: "posts",
						slug: "broken",
						status: "published",
						locale: "en-us",
						data: { title: "Broken", content: "Body" },
						createdAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
						publishedAt: "2026-01-01T00:00:00.000Z",
					},
				],
				hasMore: false,
			}),
		} as PluginContext["content"]);
		await ctx.kv.set("item:posts/broken.md", "old-item-id");
		const plugin = createPlugin();
		const handler = plugin.routes.reindex!.handler;

		await handler(routeContext(ctx, { collections: ["posts"] }) as never);
		await runReindexCron(plugin, ctx);

		expect(deletions).toHaveLength(0);
		expect(await ctx.kv.get("item:posts/broken.md")).toBe("old-item-id");
	});
});

describe("AI Search snippet endpoint", () => {
	it("returns metadata-only snippet results using configured URL templates", async () => {
		controls.searchRequests.length = 0;
		controls.searchChunks = [
			{
				id: "chunk-1",
				type: "text",
				score: 0.9,
				text: "not returned",
				item: {
					key: "posts/post-1.md",
					metadata: {
						title_desc: "Hello\u001FA useful result",
						slug: "hello",
					},
				},
			},
		];
		const ctx = makeContext();
		const response = await handleAISearchSnippetRequest(
			snippetRequest({
				messages: [{ role: "user", content: "hello" }],
				locale: "fr",
				ai_search_options: { retrieval: { max_num_results: 5 } },
			}),
			snippetOptions(ctx, { urlTemplates: { posts: "/writing/{slug}?lang={locale}" } }),
		);

		expect(response.status).toBe(200);
		expect(controls.searchRequests.at(-1)).toMatchObject({
			ai_search_options: {
				retrieval: {
					metadata_only: true,
					filters: { locale: { $eq: "fr" } },
				},
			},
		});
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			result: {
				chunks: [
					{
						item: {
							key: "/writing/hello?lang=fr",
							metadata: {
								title: "Hello",
								description: "A useful result",
							},
						},
					},
				],
			},
		});
	});
});

describe("ai-search endpoint and route errors", () => {
	it("uses structured errors instead of successful error payloads", async () => {
		const plugin = createPlugin();
		const ctx = makeContext();

		await expect(
			plugin.routes.config!.handler(routeContext(ctx, { collections: 42 }) as never),
		).rejects.toMatchObject({ status: 400, code: "BAD_REQUEST" });
	});

	it("does not expose an upstream search error through the snippet endpoint", async () => {
		controls.searchError = new Error("secret upstream details");
		const ctx = makeContext();

		const response = await handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "query" }] }),
			snippetOptions(ctx),
		);
		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			success: false,
			error: "Search is temporarily unavailable",
		});
		controls.searchError = null;
	});

	it("reports unavailable cron scheduling and unknown jobs with structured errors", async () => {
		const plugin = createPlugin();
		const withoutCron = makeContext();
		delete (withoutCron as { cron?: unknown }).cron;

		await expect(
			plugin.routes.reindex!.handler(
				routeContext(withoutCron, { collections: ["posts"] }) as never,
			),
		).rejects.toMatchObject({ status: 503 });

		const ctx = makeContext();
		await expect(
			plugin.routes.reindex!.handler(routeContext(ctx, { jobId: "missing" }) as never),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
	});
});

describe("ai-search content:afterSave indexing", () => {
	it("creates new instances with the current index_method configuration", async () => {
		uploads.length = 0;
		createConfigs.length = 0;
		controls.instanceMissing = true;
		const plugin = createPlugin({ hybridSearch: true });
		const ctx = makeContext();

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: {
					id: "create-instance",
					slug: "create-instance",
					status: "published",
					locale: "en",
					data: { title: "Create instance", body: "Body" },
				},
				collection: "posts",
				isNew: true,
			},
			ctx,
		);

		expect(createConfigs).toHaveLength(1);
		expect(createConfigs[0]).toMatchObject({
			index_method: { vector: true, keyword: true },
		});
		expect(createConfigs[0]).not.toHaveProperty("hybrid_search_enabled");
		controls.instanceMissing = false;
	});
	it("indexes the real title and body from the hook's `.data` payload", async () => {
		uploads.length = 0;
		const plugin = createPlugin();
		const ctx = makeContext();

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: {
					id: "01H",
					slug: "hello-world",
					status: "published",
					locale: "fr",
					data: { title: "Hello World", body: "The quick brown fox jumps over the lazy dog" },
				},
				collection: "posts",
				isNew: true,
			},
			ctx,
		);

		expect(uploads).toHaveLength(1);
		const [uploaded] = uploads;
		const { title, description } = unpackTitleDescription(String(uploaded!.metadata.title_desc));

		expect(title).toBe("Hello World");
		expect(description).toBe("");
		expect(uploaded!.content).toContain("Hello World");
		expect(uploaded!.content).toContain("quick brown fox");
		expect(uploaded!.metadata.locale).toBe("fr");
		expect(uploaded!.metadata.slug).toBe("hello-world");
	});

	it("uses the excerpt and featured image without indexing system metadata", async () => {
		uploads.length = 0;
		const plugin = createPlugin();
		const ctx = makeContext();

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: {
					id: "01POST",
					slug: "threat-intel",
					status: "published",
					authorId: "01AUTHOR",
					createdAt: "2026-06-08T13:00:03.516Z",
					updatedAt: "2026-06-08T14:00:00.000Z",
					locale: "en-us",
					translationGroup: "01GROUP",
					data: {
						title: "Threat intelligence",
						excerpt: "The exact article excerpt.",
						content: "The full article body.",
						secondaryImage: { src: "https://example.com/secondary.png" },
						featured_image: {
							meta: { storageKey: "featured.png" },
						},
					},
				},
				collection: "posts",
				isNew: false,
			},
			ctx,
		);

		expect(uploads).toHaveLength(1);
		const [uploaded] = uploads;
		const { description } = unpackTitleDescription(String(uploaded!.metadata.title_desc));

		expect(description).toBe("The exact article excerpt.");
		expect(uploaded!.metadata.image).toBe("/_emdash/api/media/file/featured.png");
		expect(uploaded!.content).toContain("The full article body.");
		expect(uploaded!.content).not.toContain("01AUTHOR");
		expect(uploaded!.content).not.toContain("2026-06-08T13:00:03.516Z");
		expect(uploaded!.content).not.toContain("01GROUP");
	});

	it("does not index a pending draft for published content", async () => {
		uploads.length = 0;
		const plugin = createPlugin();
		const ctx = makeContext();

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: {
					id: "published-with-draft",
					slug: "published-with-draft",
					status: "published",
					liveRevisionId: "live-revision",
					draftRevisionId: "draft-revision",
					data: { title: "Unpublished title", body: "Unpublished body" },
					liveData: { title: "Published title", body: "Published body" },
				},
				collection: "posts",
				isNew: false,
			},
			ctx,
		);

		expect(uploads).toHaveLength(0);
	});
});
