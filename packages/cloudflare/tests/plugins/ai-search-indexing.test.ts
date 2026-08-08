import type { PluginContext } from "emdash";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { uploads, deletions, createConfigs, updates, controls, pendingUploads, fakeEnv } =
	vi.hoisted(() => {
		const captured: Array<{
			key: string;
			content: string;
			metadata: Record<string, unknown>;
		}> = [];
		const removed: string[] = [];
		const configs: Array<Record<string, unknown>> = [];
		const instanceUpdates: Array<Record<string, unknown>> = [];
		const state = {
			uploadFailures: 0,
			holdUploads: false,
			instanceMissing: false,
			infoError: null as Error | null,
			createError: null as Error | null,
			searchError: null as Error | null,
			searchChunks: [] as Array<Record<string, unknown>>,
			searchRequests: [] as Array<Record<string, unknown>>,
			instanceInfo: { id: "emdash-content" } as Record<string, unknown>,
		};
		const pending = new Map<
			string,
			{ resolve: (item: { id: string }) => void; reject: (error: Error) => void }
		>();
		const instance = {
			info: () => {
				if (state.infoError) return Promise.reject(state.infoError);
				if (!state.instanceMissing) return Promise.resolve(state.instanceInfo);
				const error = new Error("ai_search_not_found");
				error.name = "AiSearchNotFoundError";
				return Promise.reject(error);
			},
			update: (config: Record<string, unknown>) => {
				instanceUpdates.push(config);
				state.instanceInfo = { ...state.instanceInfo, ...config };
				return Promise.resolve();
			},
			search: (request: Record<string, unknown>) => {
				state.searchRequests.push(request);
				return state.searchError
					? Promise.reject(state.searchError)
					: Promise.resolve({ search_query: "query", chunks: state.searchChunks });
			},
			items: {
				upload: (
					key: string,
					content: string,
					options?: { metadata?: Record<string, unknown> },
				) => {
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
				state.instanceMissing = false;
				state.instanceInfo = config;
				if (state.createError) return Promise.reject(state.createError);
				return Promise.resolve(instance);
			},
		};
		return {
			uploads: captured,
			deletions: removed,
			createConfigs: configs,
			updates: instanceUpdates,
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
					timestamp: 123,
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
					max_num_results: 5,
					metadata_only: true,
					filters: { locale: { $eq: "fr" } },
				},
			},
		});
		const body = (await response.json()) as {
			result: { chunks: Array<{ item: Record<string, unknown> }> };
		};
		expect(body).toMatchObject({
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
		expect(body.result.chunks[0]?.item).not.toHaveProperty("timestamp");
	});

	it.each([0, 51, 1.5, "5"])("rejects invalid max_num_results value %j", async (value) => {
		const response = await handleAISearchSnippetRequest(
			snippetRequest({
				messages: [{ role: "user", content: "hello" }],
				ai_search_options: { retrieval: { max_num_results: value } },
			}),
			snippetOptions(makeContext()),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			success: false,
			error: "max_num_results must be an integer between 1 and 50",
		});
	});

	it("pushes one collection into the folder filter and excludes mismatched upstream results", async () => {
		controls.searchRequests.length = 0;
		controls.searchChunks = [
			{
				id: "chunk-from-another-folder",
				type: "text",
				score: 0.9,
				text: "",
				item: {
					key: "pages/page-1.md",
					timestamp: 123,
					metadata: { title_desc: "Page\u001FDescription", slug: "page-1" },
				},
			},
		];
		const ctx = makeContext();

		const response = await handleAISearchSnippetRequest(
			snippetRequest({
				messages: [{ role: "user", content: "query" }],
				collection: " posts ",
			}),
			snippetOptions(ctx),
		);

		expect(controls.searchRequests.at(-1)).toMatchObject({
			ai_search_options: { retrieval: { filters: { folder: "posts/" } } },
		});
		const body = (await response.json()) as { result: { chunks: Array<Record<string, unknown>> } };
		expect(body.result.chunks).toHaveLength(0);
	});

	it("pushes multiple collections into a built-in folder $in filter", async () => {
		controls.searchRequests.length = 0;
		controls.searchChunks = [];
		const ctx = makeContext();

		await handleAISearchSnippetRequest(
			snippetRequest({
				messages: [{ role: "user", content: "query" }],
				collection: "posts, pages",
			}),
			snippetOptions(ctx),
		);

		expect(controls.searchRequests.at(-1)).toMatchObject({
			ai_search_options: {
				retrieval: { filters: { folder: { $in: ["posts/", "pages/"] } } },
			},
		});
	});

	it("refreshes synonyms at most once per minute", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
		try {
			const ctx = makeContext();
			const plugin = createPlugin();
			await plugin.routes.config!.handler(
				routeContext(ctx, { synonyms: [{ from: "autorag", to: "AI Search" }] }) as never,
			);
			const get = vi.spyOn(ctx.kv, "get");

			await handleAISearchSnippetRequest(
				snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
				snippetOptions(ctx),
			);
			await handleAISearchSnippetRequest(
				snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
				snippetOptions(ctx),
			);

			expect(get).toHaveBeenCalledTimes(0);
			expect(controls.searchRequests.at(-1)).toMatchObject({
				messages: [{ role: "user", content: "AI Search" }],
			});

			vi.advanceTimersByTime(60_001);
			await handleAISearchSnippetRequest(
				snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
				snippetOptions(ctx),
			);
			expect(get).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses newly saved synonyms immediately in the same isolate", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2100-06-01T00:00:00.000Z"));
		try {
			const ctx = makeContext();
			const plugin = createPlugin();
			await plugin.routes.config!.handler(
				routeContext(ctx, { synonyms: [{ from: "autorag", to: "old term" }] }) as never,
			);
			await handleAISearchSnippetRequest(
				snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
				snippetOptions(ctx),
			);

			await plugin.routes.config!.handler(
				routeContext(ctx, { synonyms: [{ from: "autorag", to: "new term" }] }) as never,
			);
			await handleAISearchSnippetRequest(
				snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
				snippetOptions(ctx),
			);

			expect(controls.searchRequests.at(-1)).toMatchObject({
				messages: [{ role: "user", content: "new term" }],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let a stale in-flight refresh overwrite newly saved synonyms", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2100-09-01T00:00:00.000Z"));
		const ctx = makeContext();
		const plugin = createPlugin();
		await plugin.routes.config!.handler(
			routeContext(ctx, { synonyms: [{ from: "autorag", to: "old term" }] }) as never,
		);
		vi.advanceTimersByTime(60_001);

		const originalGet = ctx.kv.get.bind(ctx.kv);
		let releaseRead!: () => void;
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		let blockRefresh = true;
		const get = vi.spyOn(ctx.kv, "get").mockImplementation(async <T>(key: string) => {
			if (key !== "config:synonyms" || !blockRefresh) return originalGet<T>(key);
			blockRefresh = false;
			const staleValue = await originalGet<T>(key);
			await readGate;
			return staleValue;
		});

		const staleSearch = handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
			snippetOptions(ctx),
		);
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
		await plugin.routes.config!.handler(
			routeContext(ctx, { synonyms: [{ from: "autorag", to: "new term" }] }) as never,
		);

		try {
			releaseRead();
			await staleSearch;
			await handleAISearchSnippetRequest(
				snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
				snippetOptions(ctx),
			);
			expect(controls.searchRequests.at(-1)).toMatchObject({
				messages: [{ role: "user", content: "new term" }],
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("coalesces concurrent synonym refreshes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2101-01-01T00:00:00.000Z"));
		const ctx = makeContext();
		const plugin = createPlugin();
		await plugin.routes.config!.handler(
			routeContext(ctx, { synonyms: [{ from: "autorag", to: "AI Search" }] }) as never,
		);
		vi.advanceTimersByTime(60_001);
		const originalGet = ctx.kv.get.bind(ctx.kv);
		let releaseRead!: () => void;
		const readGate = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		const get = vi.spyOn(ctx.kv, "get").mockImplementation(async <T>(key: string) => {
			await readGate;
			return originalGet<T>(key);
		});
		const searchCount = controls.searchRequests.length;

		const first = handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
			snippetOptions(ctx),
		);
		await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(1));
		const second = handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "autorag" }] }),
			snippetOptions(ctx),
		);
		await vi.waitFor(() => expect(controls.searchRequests.length).toBeGreaterThan(searchCount));
		expect(get).toHaveBeenCalledTimes(1);

		try {
			releaseRead();
			await Promise.all([first, second]);
		} finally {
			vi.useRealTimers();
		}
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

describe("ai-search collection configuration", () => {
	it("returns effective defaults without persisting them", async () => {
		const plugin = createPlugin();
		const ctx = makeContext();

		await expect(
			plugin.routes.config!.handler(routeContext(ctx, {}, "GET") as never),
		).resolves.toMatchObject({ collections: ["posts", "pages"] });
		await expect(ctx.kv.get("config:collections")).resolves.toBeNull();
	});

	it("preserves an explicitly empty collection selection", async () => {
		const plugin = createPlugin();
		const ctx = makeContext();

		await plugin.routes.config!.handler(routeContext(ctx, { collections: [] }) as never);

		await expect(
			plugin.routes.config!.handler(routeContext(ctx, {}, "GET") as never),
		).resolves.toMatchObject({ collections: [] });
	});

	it("removes already-indexed items of a deselected collection", async () => {
		uploads.length = 0;
		deletions.length = 0;
		createConfigs.length = 0;
		controls.uploadFailures = 0;
		controls.holdUploads = false;
		controls.instanceMissing = false;
		const plugin = createPlugin();
		const ctx = makeContext();

		const index = async (collection: string, id: string) => {
			await plugin.hooks["content:afterSave"]!.handler(
				{
					content: {
						id,
						slug: id,
						status: "published",
						locale: "en",
						data: { title: `Title ${id}`, body: `Body ${id}` },
					},
					collection,
					isNew: true,
				},
				ctx,
			);
		};

		await index("posts", "stale-post");
		await index("pages", "kept-page");
		const staleItemId = await ctx.kv.get<string>("item:posts/stale-post.md");
		const keptItemId = await ctx.kv.get<string>("item:pages/kept-page.md");
		expect(staleItemId).toBeTruthy();
		expect(keptItemId).toBeTruthy();

		await plugin.routes.config!.handler(routeContext(ctx, { collections: ["pages"] }) as never);

		expect(deletions).toEqual([staleItemId]);
		await expect(ctx.kv.get("item:posts/stale-post.md")).resolves.toBeNull();
		await expect(ctx.kv.get("item:pages/kept-page.md")).resolves.toBe(keptItemId);
	});
});

describe("ai-search metadata schema route", () => {
	const requiredSchema = [
		{ field_name: "visible_after", data_type: "number" },
		{ field_name: "title_desc", data_type: "text" },
		{ field_name: "slug", data_type: "text" },
		{ field_name: "image", data_type: "text" },
		{ field_name: "locale", data_type: "text" },
	];

	it("reports a bare existing instance as invalid without mutating it", async () => {
		createConfigs.length = 0;
		updates.length = 0;
		controls.instanceInfo = { id: "emdash-content" };
		const plugin = createPlugin();
		const ctx = makeContext();

		await expect(
			plugin.routes.metadata!.handler(routeContext(ctx, {}, "GET") as never),
		).resolves.toEqual({ valid: false });
		expect(updates).toHaveLength(0);
		expect(createConfigs).toHaveLength(0);
	});

	it("treats Cloudflare's ai_search_not_found error as valid without creating or updating the instance", async () => {
		createConfigs.length = 0;
		updates.length = 0;
		controls.instanceMissing = true;
		const plugin = createPlugin();

		try {
			await expect(
				plugin.routes.metadata!.handler(routeContext(makeContext(), {}, "GET") as never),
			).resolves.toEqual({ valid: true });
			expect(createConfigs).toHaveLength(0);
			expect(updates).toHaveLength(0);
		} finally {
			controls.instanceMissing = false;
		}
	});

	it("rejects unsupported methods without repairing the instance", async () => {
		createConfigs.length = 0;
		updates.length = 0;
		controls.instanceInfo = { id: "emdash-content", custom_metadata: [] };
		const plugin = createPlugin();

		await expect(
			plugin.routes.metadata!.handler(routeContext(makeContext(), {}, "PUT") as never),
		).rejects.toMatchObject({ status: 405, code: "METHOD_NOT_ALLOWED" });
		expect(createConfigs).toHaveLength(0);
		expect(updates).toHaveLength(0);
	});

	it("does not mutate a bare existing instance during normal search", async () => {
		updates.length = 0;
		controls.instanceInfo = { id: "emdash-content" };
		controls.searchChunks = [];

		await handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "query" }] }),
			snippetOptions(makeContext()),
		);

		expect(updates).toHaveLength(0);
	});

	it("updates an invalid instance to the required schema", async () => {
		updates.length = 0;
		controls.instanceInfo = { id: "emdash-content", custom_metadata: [] };
		const plugin = createPlugin();
		const ctx = makeContext();

		await expect(
			plugin.routes.metadata!.handler(routeContext(ctx, {}, "POST") as never),
		).resolves.toEqual({ valid: true });
		expect(updates).toEqual([{ custom_metadata: requiredSchema }]);
	});

	it("accepts an equivalent schema in a different order without updating it", async () => {
		updates.length = 0;
		controls.instanceInfo = {
			id: "emdash-content",
			custom_metadata: requiredSchema.toReversed(),
		};
		const plugin = createPlugin();
		const ctx = makeContext();

		await expect(
			plugin.routes.metadata!.handler(routeContext(ctx, {}, "POST") as never),
		).resolves.toEqual({ valid: true });
		expect(updates).toHaveLength(0);
	});

	it("returns a structured 503 when the binding is missing", async () => {
		const binding = fakeEnv.AI_SEARCH;
		Reflect.deleteProperty(fakeEnv, "AI_SEARCH");
		try {
			const plugin = createPlugin();
			await expect(
				plugin.routes.metadata!.handler(routeContext(makeContext(), {}, "GET") as never),
			).rejects.toMatchObject({ status: 503, code: "AI_SEARCH_UNAVAILABLE" });
		} finally {
			fakeEnv.AI_SEARCH = binding;
		}
	});
});

describe("ai-search content:afterSave indexing", () => {
	it("uses the effective default collections before configuration is saved", async () => {
		uploads.length = 0;
		const plugin = createPlugin();

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: {
					id: "product",
					slug: "product",
					status: "published",
					data: { title: "Product" },
				},
				collection: "products",
				isNew: true,
			},
			makeContext(),
		);

		expect(uploads).toHaveLength(0);
	});

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
			custom_metadata: [
				{ field_name: "visible_after", data_type: "number" },
				{ field_name: "title_desc", data_type: "text" },
				{ field_name: "slug", data_type: "text" },
				{ field_name: "image", data_type: "text" },
				{ field_name: "locale", data_type: "text" },
			],
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

	it("removes non-public content even when its collection is deselected", async () => {
		deletions.length = 0;
		const plugin = createPlugin();
		const ctx = makeContext();
		await plugin.routes.config!.handler(routeContext(ctx, { collections: ["pages"] }) as never);
		for (const id of ["saved-draft", "restored-draft"]) {
			await ctx.kv.set(`item:posts/${id}.md`, `item-${id}`);
		}

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: { id: "saved-draft", slug: "saved-draft", status: "draft", data: {} },
				collection: "posts",
				isNew: false,
			},
			ctx,
		);
		await plugin.hooks["content:afterRestore"]!.handler(
			{
				content: { id: "restored-draft", slug: "restored-draft", status: "draft", data: {} },
				collection: "posts",
			} as never,
			ctx,
		);

		expect(deletions).toEqual(["item-saved-draft", "item-restored-draft"]);
	});

	it("always removes unpublished, unscheduled, and deleted content from deselected collections", async () => {
		deletions.length = 0;
		const plugin = createPlugin();
		const ctx = makeContext();
		await plugin.routes.config!.handler(routeContext(ctx, { collections: ["pages"] }) as never);
		for (const id of ["unpublished", "unscheduled", "deleted"]) {
			await ctx.kv.set(`item:posts/${id}.md`, `item-${id}`);
		}

		await plugin.hooks["content:afterUnpublish"]!.handler(
			{ content: { id: "unpublished" }, collection: "posts" } as never,
			ctx,
		);
		await plugin.hooks["content:afterUnschedule"]!.handler(
			{ content: { id: "unscheduled" }, collection: "posts" } as never,
			ctx,
		);
		await plugin.hooks["content:afterDelete"]!.handler(
			{ id: "deleted", collection: "posts" } as never,
			ctx,
		);

		expect(deletions).toEqual(["item-unpublished", "item-unscheduled", "item-deleted"]);
	});

	it("still gates public additions when a collection is deselected", async () => {
		uploads.length = 0;
		const plugin = createPlugin();
		const ctx = makeContext();
		await plugin.routes.config!.handler(routeContext(ctx, { collections: ["pages"] }) as never);

		await plugin.hooks["content:afterSave"]!.handler(
			{
				content: {
					id: "published",
					slug: "published",
					status: "published",
					data: { title: "Published" },
				},
				collection: "posts",
				isNew: true,
			},
			ctx,
		);

		expect(uploads).toHaveLength(0);
	});
});

describe("ai-search instance creation", () => {
	beforeEach(() => {
		createConfigs.length = 0;
		controls.searchChunks = [];
		controls.searchError = null;
		controls.infoError = null;
		controls.createError = null;
		controls.instanceMissing = false;
		controls.instanceInfo = { id: "emdash-content" };
	});

	afterEach(() => {
		controls.infoError = null;
		controls.createError = null;
		controls.instanceMissing = false;
		controls.instanceInfo = { id: "emdash-content" };
	});

	it("does not create an instance when the info probe fails transiently", async () => {
		controls.infoError = new Error("internal error");

		const response = await handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "query" }] }),
			snippetOptions(makeContext()),
		);

		expect(response.status).toBe(503);
		expect(createConfigs).toHaveLength(0);
	});

	it("searches successfully after losing a concurrent create race", async () => {
		controls.instanceMissing = true;
		controls.createError = new Error("instance already exists");

		const response = await handleAISearchSnippetRequest(
			snippetRequest({ messages: [{ role: "user", content: "query" }] }),
			snippetOptions(makeContext()),
		);

		expect(response.status).toBe(200);
		expect(createConfigs).toHaveLength(1);
	});
});
