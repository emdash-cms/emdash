/**
 * Boots a runtime with the AI Search plugin as a site that lists `aiSearch()`
 * does, and drives it through content actions, plugin routes, and scheduled
 * tasks. Only the AI Search namespace binding is replaced, with an in-memory
 * service that indexes what the plugin uploads. As in AI Search, an upload is
 * queued and becomes searchable only after `INDEXING_MS` on the fake clock;
 * until then, searches still find the version it replaces.
 */

import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { createPlugin } from "../../../../plugins/ai-search/src/index.js";
import { FakeAiSearch } from "../../../../plugins/ai-search/tests/fake-ai-search.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { PluginResponse } from "../../../src/plugin-types.js";

const INDEXING_MS = 30_000;

const aiSearch = vi.hoisted(() => ({ current: null as FakeAiSearch | null }));

vi.mock("cloudflare:workers", () => ({
	env: {
		get AI_SEARCH() {
			return aiSearch.current;
		},
	},
}));

// The plugin imports its helpers from the `emdash` package. Resolve it to this
// source tree so its route errors are the runtime's own error class.
vi.mock("emdash", async () => await import("../../../src/index.js"));

describe("ai-search plugin", () => {
	let runtime: EmDashRuntime;
	let service: FakeAiSearch;

	beforeEach(async () => {
		service = new FakeAiSearch({ indexingMs: INDEXING_MS });
		aiSearch.current = service;
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00.000Z") });
		const sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create({
			config: {
				database: { entrypoint: `test-ai-search-${randomUUID()}`, config: {}, type: "sqlite" },
			},
			createDialect: () => new SqliteDialect({ database: sqlite }),
			createStorage: null,
			plugins: [createPlugin()],
			sandboxEnabled: false,
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
			now: () => new Date(),
			siteInfo: { url: "https://example.com" },
		});

		await runtime.schemaRegistry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			urlPattern: "/posts/{slug}",
		});
		await runtime.schemaRegistry.createField("posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await runtime.schemaRegistry.createField("posts", {
			slug: "body",
			label: "Body",
			type: "text",
		});
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		await runtime.shutdown();
		aiSearch.current = null;
		vi.useRealTimers();
	});

	async function route(method: "GET" | "POST", path: string, body?: unknown) {
		const request = new Request(`http://localhost/_emdash/api/plugins/ai-search/${path}`, {
			method,
			...(body === undefined
				? {}
				: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		return runtime.handlePluginApiRoute("ai-search", method, path, request);
	}

	async function data(method: "GET" | "POST", path: string, body?: unknown) {
		const result = await route(method, path, body);
		if (!result.success) throw new Error(`${path} failed: ${JSON.stringify(result.error)}`);
		return result.data;
	}

	/** Saves the default configuration and runs its build from the settings page. */
	async function setUpSearch() {
		const { config } = (await data("GET", "config")) as { config: unknown };
		await data("POST", "config/save", config);
		for (let step = 0; step < 20; step++) {
			const { build } = (await data("POST", "index/step")) as { build: unknown };
			if (!build) return;
		}
		throw new Error("the build did not finish");
	}

	async function search(query: string) {
		const response = (await data("POST", "search", {
			messages: [{ role: "user", content: query }],
		})) as PluginResponse;
		const body = response.body?.kind === "text" ? JSON.parse(response.body.value) : null;
		return { status: response.status, body };
	}

	async function resultUrls(query: string): Promise<string[]> {
		const { body } = await search(query);
		return (body.result.chunks as Array<{ item: { key: string } }>).map((chunk) => chunk.item.key);
	}

	async function createPost(title: string, body: string) {
		const created = await runtime.handleContentCreate("posts", {
			data: { title, body },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			status: "draft",
		});
		if (!created.success) throw new Error("create failed");
		await waitForDeferredTasks();
		return created.data.item;
	}

	async function publish(id: string) {
		const published = await runtime.handleContentPublish("posts", id);
		if (!published.success) throw new Error("publish failed");
		await waitForDeferredTasks();
	}

	/** Moves the clock past AI Search's processing of every upload so far. */
	function finishIndexing() {
		vi.setSystemTime(Date.now() + INDEXING_MS);
	}

	/** Moves the clock forward and runs the scheduled tasks, as the platform's cron trigger does. */
	async function tick(minutes: number) {
		vi.setSystemTime(Date.now() + minutes * 60_000);
		await runtime.runScheduledTasks();
		await waitForDeferredTasks();
	}

	it("indexes the site's published posts on setup and serves them from the search route", async () => {
		await publish((await createPost("Rose garden", "Planting roses in spring.")).id);
		await createPost("Draft garden", "Not ready yet.");

		await setUpSearch();
		finishIndexing();

		const { status, body } = await search("garden");
		expect(status).toBe(200);
		expect(body.result.chunks).toEqual([
			{
				id: "/posts/rose-garden",
				type: "text",
				text: "Planting roses in spring.",
				item: {
					key: "/posts/rose-garden",
					metadata: {
						title: "Rose garden",
						description: "Planting roses in spring.",
						group: "Posts",
					},
				},
			},
		]);
	});

	it("finishes a build from scheduled tasks when the settings page is closed", async () => {
		await publish((await createPost("Rose garden", "Planting roses.")).id);
		const { config } = (await data("GET", "config")) as { config: unknown };
		await data("POST", "config/save", config);

		await tick(1);
		finishIndexing();

		expect(await data("GET", "status")).toMatchObject({ build: null });
		expect(await resultUrls("roses")).toEqual(["/posts/rose-garden"]);
	});

	it("keeps search in step as posts are published, unpublished, and deleted", async () => {
		await setUpSearch();
		const post = await createPost("Tulip care", "Watering tulips.");

		await publish(post.id);
		finishIndexing();
		expect(await resultUrls("tulips")).toEqual(["/posts/tulip-care"]);

		const unpublished = await runtime.handleContentUnpublish("posts", post.id);
		expect(unpublished.success).toBe(true);
		await waitForDeferredTasks();
		expect(await resultUrls("tulips")).toEqual([]);

		await publish(post.id);
		const deleted = await runtime.handleContentDelete("posts", post.id);
		expect(deleted.success).toBe(true);
		await waitForDeferredTasks();
		expect(await resultUrls("tulips")).toEqual([]);
	});

	it("indexes a scheduled post when the scheduler publishes it", async () => {
		await setUpSearch();
		const post = await createPost("Autumn bulbs", "Planting bulbs before frost.");
		const scheduled = await runtime.handleContentSchedule(
			"posts",
			post.id,
			new Date(Date.now() + 5 * 60_000).toISOString(),
		);
		expect(scheduled.success).toBe(true);
		await waitForDeferredTasks();
		expect(await resultUrls("bulbs")).toEqual([]);

		await tick(6);
		finishIndexing();

		expect(await resultUrls("bulbs")).toEqual(["/posts/autumn-bulbs"]);
	});

	it("keeps finding a post's indexed version while its edit is processed", async () => {
		await setUpSearch();
		const post = await createPost("Hedges", "Pruning hedges in winter.");
		await publish(post.id);
		finishIndexing();

		const updated = await runtime.handleContentUpdate("posts", post.id, {
			data: { body: "Trimming hedges in autumn." },
		});
		expect(updated.success).toBe(true);
		await publish(post.id);

		expect(await resultUrls("winter")).toEqual(["/posts/hedges"]);
		finishIndexing();
		expect(await resultUrls("winter")).toEqual([]);
		expect(await resultUrls("autumn")).toEqual(["/posts/hedges"]);
	});

	it("retries an upload that failed when a post was published", async () => {
		await setUpSearch();
		const post = await createPost("Pruning", "Pruning hedges in winter.");
		service.items.failKeys.add(`posts/${post.id}.md`);
		await publish(post.id);
		service.items.failKeys.clear();

		await tick(2);
		finishIndexing();

		expect(await resultUrls("hedges")).toEqual(["/posts/pruning"]);
	});

	it("refuses index work before AI Search is set up", async () => {
		expect(await route("POST", "index/step")).toMatchObject({
			success: false,
			status: 409,
			error: { code: "NOT_CONFIGURED" },
		});
	});

	it("answers 503 before AI Search is set up and while it is failing", async () => {
		expect((await search("garden")).status).toBe(503);

		await setUpSearch();
		service.searchError = new Error("AiSearchInternalError: internal_error");

		expect(await search("garden")).toEqual({
			status: 503,
			body: {
				success: false,
				error: { code: "SEARCH_UNAVAILABLE", message: "Search is temporarily unavailable" },
			},
		});
	});
});
