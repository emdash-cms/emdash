import { describe, it, expect, vi } from "vitest";

const { fakeEnv, controls } = vi.hoisted(() => {
	const state = {
		pluginEnabled: true,
		searchChunks: [] as Array<Record<string, unknown>>,
		searchRequests: [] as Array<Record<string, unknown>>,
	};
	const instance = {
		info: () => Promise.resolve({ id: "emdash-content" }),
		search: (request: Record<string, unknown>) => {
			state.searchRequests.push(request);
			return Promise.resolve({ search_query: "query", chunks: state.searchChunks });
		},
		items: {
			upload: () => Promise.resolve({ id: "item-1" }),
			delete: () => Promise.resolve(),
		},
	};
	const namespace = {
		get: () => instance,
		create: () => Promise.resolve(instance),
	};
	return { fakeEnv: { AI_SEARCH: namespace }, controls: state };
});

vi.mock("cloudflare:workers", () => ({ env: fakeEnv, waitUntil: () => {} }));

const { optionsConstructedWith } = vi.hoisted(() => ({
	optionsConstructedWith: [] as unknown[],
}));

vi.mock("emdash", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash")>();
	class TrackingOptionsRepository {
		constructor(db: unknown) {
			optionsConstructedWith.push(db);
			if (db === undefined || db === null) {
				throw new TypeError("Cannot read properties of undefined (reading 'selectFrom')");
			}
		}
		async get() {
			return null;
		}
	}
	return { ...actual, OptionsRepository: TrackingOptionsRepository };
});

const { runtimeDbHandle } = vi.hoisted(() => ({ runtimeDbHandle: { selectFrom: () => ({}) } }));
vi.mock("emdash/middleware", () => ({
	withEmDashRuntime: async (
		run: (rt: {
			db: unknown;
			getPluginRouteMeta: (id: string, path: string) => object | null;
		}) => unknown,
	) =>
		run({
			db: runtimeDbHandle,
			getPluginRouteMeta: () => (controls.pluginEnabled ? {} : null),
		}),
}));

const { createAISearchSnippetEndpoint } = await import("../../src/plugins/ai-search.js");

function anonymousContext(body: unknown) {
	return {
		request: new Request("https://example.com/api/ai-search/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { emdash: {} },
	} as never;
}

describe("createAISearchSnippetEndpoint() on the anonymous request path", () => {
	it("does not read locals.emdash.db and succeeds when it is undefined (regression)", async () => {
		controls.pluginEnabled = true;
		optionsConstructedWith.length = 0;
		controls.searchRequests.length = 0;
		controls.searchChunks = [
			{
				id: "chunk-1",
				type: "text",
				score: 0.9,
				text: "not returned",
				item: { key: "posts/post-1.md", metadata: { title_desc: "Hi\u001FA result", slug: "hi" } },
			},
		];

		const endpoint = createAISearchSnippetEndpoint();
		const response = await endpoint(
			anonymousContext({ messages: [{ role: "user", content: "hi" }] }),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ success: true });

		expect(optionsConstructedWith).toContain(runtimeDbHandle);
		expect(optionsConstructedWith).not.toContain(undefined);
	});

	it("still works when locals has no emdash at all", async () => {
		controls.pluginEnabled = true;
		optionsConstructedWith.length = 0;
		controls.searchChunks = [];
		const endpoint = createAISearchSnippetEndpoint();
		const ctx = {
			request: new Request("https://example.com/api/ai-search/search", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
			}),
			locals: {},
		} as never;

		const response = await endpoint(ctx);
		expect(response.status).toBe(200);
		expect(optionsConstructedWith).toContain(runtimeDbHandle);
	});

	it("does not search when the plugin is disabled", async () => {
		controls.pluginEnabled = false;
		controls.searchRequests.length = 0;
		optionsConstructedWith.length = 0;
		const endpoint = createAISearchSnippetEndpoint();

		const response = await endpoint(
			anonymousContext({ messages: [{ role: "user", content: "hi" }] }),
		);

		expect(response.status).toBe(404);
		expect(controls.searchRequests).toHaveLength(0);
		expect(optionsConstructedWith).toHaveLength(0);
	});
});
