import { describe, it, expect } from "vitest";

import { EmDashClient, EmDashApiError } from "../../../src/client/index.js";
import type { Interceptor } from "../../../src/client/transport.js";

// Regex patterns for route matching
const CONTENT_POSTS_ABC_REGEX = /\/content\/posts\/abc/;

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

interface MockRoute {
	method: string;
	path: RegExp | string;
	handler: (req: Request) => Response | Promise<Response>;
}

/**
 * Creates a mock HTTP backend as an interceptor.
 * Routes are matched in order. Unmatched requests return 404.
 */
function createMockBackend(routes: MockRoute[]): Interceptor {
	return async (req) => {
		const url = new URL(req.url);
		const path = url.pathname + url.search;

		for (const route of routes) {
			if (req.method !== route.method) continue;
			if (typeof route.path === "string") {
				if (!path.includes(route.path)) continue;
			} else {
				if (!route.path.test(path)) continue;
			}
			return route.handler(req);
		}

		return new Response(
			JSON.stringify({ error: { code: "NOT_FOUND", message: "No matching route" } }),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		);
	};
}

/** Wraps body in `{ data: body }` to match the standard API response envelope. */
function jsonResponse(body: unknown, status: number = 200): Response {
	// Error responses (4xx/5xx) are NOT wrapped in { data }
	const payload = status >= 400 ? body : { data: body };
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmDashClient", () => {
	describe("_rev token flow", () => {
		it("blind update (no _rev) succeeds", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								label: "Posts",
								fields: [{ slug: "title", type: "string", label: "Title" }],
							},
						}),
				},
				{
					method: "PUT",
					path: CONTENT_POSTS_ABC_REGEX,
					handler: async (req) => {
						const body = (await req.json()) as Record<string, unknown>;
						// No _rev should be sent
						expect(body._rev).toBeUndefined();
						return jsonResponse({
							item: { id: "abc", data: { title: "Blind" } },
							_rev: "newrev",
						});
					},
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const updated = await client.update("posts", "abc", {
				data: { title: "Blind" },
			});
			expect(updated.data.title).toBe("Blind");
		});

		it("get() returns _rev on the item", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								label: "Posts",
								fields: [{ slug: "title", type: "string", label: "Title" }],
							},
						}),
				},
				{
					method: "GET",
					path: CONTENT_POSTS_ABC_REGEX,
					handler: () =>
						jsonResponse({
							item: {
								id: "abc",
								type: "posts",
								slug: "hello",
								status: "draft",
								data: { title: "Hello" },
								authorId: null,
								createdAt: "2026-01-01",
								updatedAt: "2026-01-01",
								publishedAt: null,
								scheduledAt: null,
								liveRevisionId: null,
								draftRevisionId: null,
							},
							_rev: "dGVzdHJldg",
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const post = await client.get("posts", "abc");
			expect(post.id).toBe("abc");
			expect(post._rev).toBe("dGVzdHJldg");
		});

		it("update() sends _rev when provided", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								label: "Posts",
								fields: [{ slug: "title", type: "string", label: "Title" }],
							},
						}),
				},
				{
					method: "PUT",
					path: CONTENT_POSTS_ABC_REGEX,
					handler: async (req) => {
						const body = await req.json();
						expect((body as Record<string, unknown>)._rev).toBe("dGVzdHJldg");
						return jsonResponse({
							item: { id: "abc", data: { title: "Updated" } },
							_rev: "bmV3cmV2",
						});
					},
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const updated = await client.update("posts", "abc", {
				data: { title: "Updated" },
				_rev: "dGVzdHJldg",
			});
			expect(updated.data.title).toBe("Updated");
			expect(updated._rev).toBe("bmV3cmV2");
		});
	});

	describe("create()", () => {
		it("does not require a prior get()", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								label: "Posts",
								fields: [{ slug: "title", type: "string", label: "Title" }],
							},
						}),
				},
				{
					method: "POST",
					path: "/content/posts",
					handler: () =>
						jsonResponse({
							item: {
								id: "new1",
								type: "posts",
								slug: "hello",
								status: "draft",
								data: { title: "Hello" },
								authorId: null,
								createdAt: "2026-01-01",
								updatedAt: "2026-01-01",
								publishedAt: null,
								scheduledAt: null,
								liveRevisionId: null,
								draftRevisionId: null,
							},
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const item = await client.create("posts", {
				data: { title: "Hello" },
				slug: "hello",
			});
			expect(item.id).toBe("new1");
		});
	});

	describe("API error handling", () => {
		it("throws EmDashApiError on 4xx responses", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections",
					handler: () => jsonResponse({ error: { code: "FORBIDDEN", message: "No access" } }, 403),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			try {
				await client.collections();
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(EmDashApiError);
				const apiErr = error as EmDashApiError;
				expect(apiErr.status).toBe(403);
				expect(apiErr.code).toBe("FORBIDDEN");
				expect(apiErr.message).toBe("No access");
			}
		});

		it("throws EmDashApiError on 500 responses", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/manifest",
					handler: () =>
						jsonResponse(
							{
								error: {
									code: "INTERNAL_ERROR",
									message: "Something broke",
								},
							},
							500,
						),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			try {
				await client.manifest();
				expect.fail("Should have thrown");
			} catch (error) {
				expect(error).toBeInstanceOf(EmDashApiError);
				expect((error as EmDashApiError).status).toBe(500);
			}
		});
	});

	describe("list()", () => {
		it("returns items and nextCursor", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/content/posts",
					handler: () =>
						jsonResponse({
							items: [
								{
									id: "1",
									type: "posts",
									slug: "a",
									status: "published",
									data: {},
								},
								{
									id: "2",
									type: "posts",
									slug: "b",
									status: "published",
									data: {},
								},
							],
							nextCursor: "cursor123",
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const result = await client.list("posts", { status: "published" });
			expect(result.items).toHaveLength(2);
			expect(result.nextCursor).toBe("cursor123");
		});
	});

	describe("listAll()", () => {
		it("follows cursors until exhaustion", async () => {
			let page = 0;
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/content/posts",
					handler: () => {
						page++;
						if (page === 1) {
							return jsonResponse({
								items: [{ id: "1", data: {} }],
								nextCursor: "page2",
							});
						}
						return jsonResponse({
							items: [{ id: "2", data: {} }],
						});
					},
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const all = [];
			for await (const item of client.listAll("posts")) {
				all.push(item);
			}
			expect(all).toHaveLength(2);
			expect(all[0]?.id).toBe("1");
			expect(all[1]?.id).toBe("2");
		});
	});

	describe("delete/publish/unpublish/schedule/restore", () => {
		it("calls the correct endpoints", async () => {
			const calledPaths: string[] = [];

			const backend: Interceptor = async (req) => {
				calledPaths.push(`${req.method} ${new URL(req.url).pathname}`);
				return jsonResponse({});
			};

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			await client.delete("posts", "abc");
			await client.publish("posts", "abc");
			await client.unpublish("posts", "abc");
			await client.schedule("posts", "abc", { at: "2026-03-01T00:00:00Z" });
			await client.restore("posts", "abc");

			expect(calledPaths).toEqual([
				"DELETE /_emdash/api/content/posts/abc",
				"POST /_emdash/api/content/posts/abc/publish",
				"POST /_emdash/api/content/posts/abc/unpublish",
				"POST /_emdash/api/content/posts/abc/schedule",
				"POST /_emdash/api/content/posts/abc/restore",
			]);
		});
	});

	describe("schema methods", () => {
		it("collections() returns list", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections",
					handler: () =>
						jsonResponse({
							items: [
								{ slug: "posts", label: "Posts", supports: [] },
								{ slug: "pages", label: "Pages", supports: [] },
							],
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const cols = await client.collections();
			expect(cols).toHaveLength(2);
			expect(cols[0]?.slug).toBe("posts");
		});

		it("createCollection() sends correct payload", async () => {
			let capturedBody: unknown;
			const backend = createMockBackend([
				{
					method: "POST",
					path: "/schema/collections",
					handler: async (req) => {
						capturedBody = await req.json();
						return jsonResponse({
							item: {
								slug: "events",
								label: "Events",
								labelSingular: "Event",
							},
						});
					},
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			await client.createCollection({
				slug: "events",
				label: "Events",
				labelSingular: "Event",
			});

			expect(capturedBody).toEqual({
				slug: "events",
				label: "Events",
				labelSingular: "Event",
			});
		});
	});

	describe("PT <-> Markdown auto-conversion", () => {
		it("converts PT fields to markdown on get()", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								label: "Posts",
								fields: [
									{ slug: "title", type: "string", label: "Title" },
									{ slug: "body", type: "portableText", label: "Body" },
								],
							},
						}),
				},
				{
					method: "GET",
					path: CONTENT_POSTS_ABC_REGEX,
					handler: () =>
						jsonResponse({
							item: {
								id: "abc",
								type: "posts",
								data: {
									title: "Hello",
									body: [
										{
											_type: "block",
											style: "normal",
											markDefs: [],
											children: [
												{
													_type: "span",
													text: "World",
													marks: [],
												},
											],
										},
									],
								},
							},
							_rev: "rev1",
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const item = await client.get("posts", "abc");
			expect(item.data.title).toBe("Hello");
			expect(typeof item.data.body).toBe("string");
			expect(item.data.body).toContain("World");
		});

		it("returns raw PT when raw: true", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								fields: [{ slug: "body", type: "portableText", label: "Body" }],
							},
						}),
				},
				{
					method: "GET",
					path: CONTENT_POSTS_ABC_REGEX,
					handler: () =>
						jsonResponse({
							item: {
								id: "abc",
								data: {
									body: [
										{
											_type: "block",
											children: [{ _type: "span", text: "Raw" }],
										},
									],
								},
							},
							_rev: "rev1",
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const item = await client.get("posts", "abc", { raw: true });
			expect(Array.isArray(item.data.body)).toBe(true);
		});

		it("converts markdown to PT on create()", async () => {
			let capturedData: Record<string, unknown> | undefined;

			const backend = createMockBackend([
				{
					method: "GET",
					path: "/schema/collections/posts",
					handler: () =>
						jsonResponse({
							item: {
								slug: "posts",
								fields: [
									{ slug: "title", type: "string", label: "Title" },
									{ slug: "body", type: "portableText", label: "Body" },
								],
							},
						}),
				},
				{
					method: "POST",
					path: "/content/posts",
					handler: async (req) => {
						const body = (await req.json()) as Record<string, unknown>;
						capturedData = body.data as Record<string, unknown>;
						return jsonResponse({
							item: {
								id: "new1",
								data: capturedData,
							},
						});
					},
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			await client.create("posts", {
				data: {
					title: "Hello",
					body: "Some **bold** text",
				},
			});

			expect(capturedData).toBeDefined();
			expect(capturedData!.title).toBe("Hello");
			expect(Array.isArray(capturedData!.body)).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// Taxonomy & menu envelope bugs
	// -----------------------------------------------------------------------

	describe("taxonomies()", () => {
		it("returns taxonomy array from { taxonomies } envelope", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/taxonomies",
					handler: () =>
						jsonResponse({
							taxonomies: [
								{
									id: "t1",
									name: "categories",
									label: "Categories",
									hierarchical: true,
									collections: ["posts"],
								},
							],
						}),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const result = await client.taxonomies();
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(1);
			expect(result[0]!.name).toBe("categories");
		});
	});

	describe("menus()", () => {
		it("returns menu array from bare-array envelope", async () => {
			const backend = createMockBackend([
				{
					method: "GET",
					path: "/menus",
					handler: () =>
						jsonResponse([
							{
								id: "m1",
								name: "primary",
								label: "Primary",
								itemCount: 3,
							},
						]),
				},
			]);

			const client = new EmDashClient({
				baseUrl: "http://localhost:4321",
				token: "test",
				interceptors: [backend],
			});

			const result = await client.menus();
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(1);
			expect(result[0]!.name).toBe("primary");
		});
	});
});
