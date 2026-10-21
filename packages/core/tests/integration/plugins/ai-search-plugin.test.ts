/**
 * Boots a runtime with the AI Search plugin as a site that lists `aiSearch()`
 * does, and drives it through content actions, plugin routes, and scheduled
 * tasks. Only the AI Search provider is replaced, with an in-memory one that
 * indexes what the plugin uploads. As in AI Search, an upload is
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

const aiSearch = vi.hoisted(() => ({
	current: null as FakeAiSearch | null,
	accountChanged: false,
}));

vi.mock("../../../../plugins/ai-search/src/connection.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../plugins/ai-search/src/connection.js")>()),
	openProvider: async () => aiSearch.current,
	saveCredentials: async (
		_ctx: unknown,
		_options: unknown,
		_input: unknown,
		save?: { ensureInstance?: boolean },
	) => ({
		created: save?.ensureInstance ? (await aiSearch.current!.ensureInstance()).created : false,
		accountChanged: aiSearch.accountChanged,
	}),
}));

// The plugin imports its helpers from the `emdash` package. Resolve it to this
// source tree so its route errors are the runtime's own error class.
vi.mock("emdash", async () => await import("../../../src/index.js"));

describe("ai-search plugin", () => {
	let runtime: EmDashRuntime;
	let service: FakeAiSearch;

	beforeEach(async () => {
		service = new FakeAiSearch({ indexingMs: INDEXING_MS, requireInstance: true });
		aiSearch.current = service;
		vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-01T12:00:00.000Z") });
		const sqlite = new Database(":memory:");
		runtime = await EmDashRuntime.create({
			config: {
				database: { entrypoint: `test-ai-search-${randomUUID()}`, config: {}, type: "sqlite" },
				trustedProxyHeaders: ["x-real-ip"],
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
		aiSearch.accountChanged = false;
		vi.useRealTimers();
	});

	async function route(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	) {
		const request = new Request(`http://localhost/_emdash/api/plugins/ai-search/${path}`, {
			method,
			...(body === undefined
				? { headers }
				: {
						headers: { "content-type": "application/json", ...headers },
						body: JSON.stringify(body),
					}),
		});
		return runtime.handlePluginApiRoute("ai-search", method, path, request);
	}

	async function data(
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		headers?: Record<string, string>,
	) {
		const result = await route(method, path, body, headers);
		if (!result.success) throw new Error(`${path} failed: ${JSON.stringify(result.error)}`);
		return result.data;
	}

	/** Saves the default configuration and runs its build from the settings page. */
	async function setUpSearch() {
		const { config } = (await data("GET", "config")) as { config: unknown };
		await setUpSearchWith(config);
	}

	/** Saves `config` and runs its build from the settings page. */
	async function setUpSearchWith(config: unknown) {
		await data("POST", "config/save", config);
		await runBuild();
	}

	/** Runs the current build from the settings page. */
	async function runBuild() {
		for (let step = 0; step < 20; step++) {
			const { build } = (await data("POST", "index/step")) as { build: unknown };
			if (!build) return;
		}
		throw new Error("the build did not finish");
	}

	async function search(query: string, ip?: string) {
		const response = (await data(
			"POST",
			"search",
			{ messages: [{ role: "user", content: query }] },
			ip ? { "x-real-ip": ip } : {},
		)) as PluginResponse;
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
		service.failKeys.add(`posts/${post.id}.md`);
		await publish(post.id);
		service.failKeys.clear();

		await tick(2);
		finishIndexing();

		expect(await resultUrls("hedges")).toEqual(["/posts/pruning"]);
	});

	it("indexes a post with the new settings when they are saved while its publish hook syncs it", async () => {
		await setUpSearch();
		const post = await createPost("Pruning", "Pruning hedges in winter.");
		const { config } = (await data("GET", "config")) as {
			config: { sources: Record<string, { fields: string[] }> };
		};
		const upload = service.uploadItem.bind(service);
		let saved = false;
		service.uploadItem = async (...args) => {
			if (!saved) {
				saved = true;
				config.sources.posts!.fields = ["title"];
				await setUpSearchWith(config);
			}
			return upload(...args);
		};

		await publish(post.id);
		service.uploadItem = upload;
		await tick(1);
		finishIndexing();

		expect(await resultUrls("pruning")).toEqual(["/posts/pruning"]);
		expect(await resultUrls("hedges")).toEqual([]);
	});

	it("refuses index work before AI Search is set up", async () => {
		expect(await route("POST", "index/step")).toMatchObject({
			success: false,
			status: 409,
			error: { code: "NOT_CONFIGURED" },
		});
	});

	it("reports credentials Cloudflare rejects, so the admin can ask for new ones", async () => {
		await setUpSearch();
		service.failAll = "unauthorized";

		expect(await data("GET", "status")).toMatchObject({
			connected: false,
			method: null,
			credentialsRejected: true,
			configured: true,
		});
	});

	it("still reports status while Cloudflare rate-limits it, so the admin stays usable", async () => {
		await setUpSearch();
		service.failAll = "rate-limited";

		expect(await data("GET", "status")).toMatchObject({
			connected: true,
			rateLimited: true,
			credentialsRejected: false,
		});
	});

	it("reports a rejected token that Cloudflare answers as rate-limited", async () => {
		await setUpSearch();
		service.failAll = "rate-limited";
		service.rejectsToken = true;

		expect(await data("GET", "status")).toMatchObject({
			connected: false,
			rateLimited: false,
			credentialsRejected: true,
		});
	});

	it("rebuilds the index in a new account that has no instance yet", async () => {
		await publish((await createPost("Rose garden", "Planting roses.")).id);
		await setUpSearch();
		service = new FakeAiSearch({ indexingMs: INDEXING_MS, requireInstance: true });
		aiSearch.current = service;

		expect(await data("GET", "status")).toMatchObject({ instanceMissing: true });

		await data("POST", "connection/save", { accountId: "other-account" });
		await runBuild();
		finishIndexing();

		expect(await data("GET", "status")).toMatchObject({ instanceMissing: false });
		expect(await resultUrls("roses")).toEqual(["/posts/rose-garden"]);
	});

	it("rebuilds the index in a new account whose instance an earlier failed save created", async () => {
		await publish((await createPost("Rose garden", "Planting roses.")).id);
		await setUpSearch();
		service = new FakeAiSearch({ indexingMs: INDEXING_MS, requireInstance: true });
		await service.ensureInstance();
		aiSearch.current = service;
		aiSearch.accountChanged = true;

		await data("POST", "connection/save", { accountId: "other-account" });
		await runBuild();
		finishIndexing();

		expect(await resultUrls("roses")).toEqual(["/posts/rose-garden"]);
	});

	it("rebuilds the index when setup is saved again after the instance went missing", async () => {
		await publish((await createPost("Rose garden", "Planting roses.")).id);
		await setUpSearch();
		service = new FakeAiSearch({ indexingMs: INDEXING_MS, requireInstance: true });
		aiSearch.current = service;

		await setUpSearch();
		finishIndexing();

		expect(await resultUrls("roses")).toEqual(["/posts/rose-garden"]);
	});

	it("limits how often one visitor searches through the REST API", async () => {
		await setUpSearch();
		service.kind = "rest";

		for (let i = 0; i < 30; i++) expect((await search("garden", "192.0.2.10")).status).toBe(200);
		expect((await search("garden", "192.0.2.10")).status).toBe(429);
		expect((await search("garden", "192.0.2.11")).status).toBe(200);
		expect(service.searches).toHaveLength(31);
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
