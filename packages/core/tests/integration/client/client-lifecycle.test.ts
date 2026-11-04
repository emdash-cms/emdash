/**
 * Integration tests for EmDashClient.
 *
 * Tests full CRUD lifecycles against a mock HTTP backend that simulates
 * the real API behavior including _rev tokens, schema caching, and
 * content state transitions.
 */

import { describe, it, expect } from "vitest";

import { EmDashClient, EmDashApiError } from "../../../src/client/index.js";
import type { Interceptor } from "../../../src/client/transport.js";

// ---------------------------------------------------------------------------
// Simulated backend
// ---------------------------------------------------------------------------

const COLLECTION_MATCH_REGEX = /^\/schema\/collections\/([^/]+)$/;
const CONTENT_LIST_REGEX = /^\/content\/([^/]+)$/;
const CONTENT_ITEM_REGEX = /^\/content\/([^/]+)\/([^/]+)$/;
const CONTENT_ACTION_REGEX = /^\/content\/([^/]+)\/([^/]+)\/(publish|unpublish|schedule|restore)$/;

interface StoredItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	authorId: string | null;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	version: number;
}

function encodeRev(item: StoredItem): string {
	return btoa(`${item.version}:${item.updatedAt}`);
}

/**
 * Mirrors the API response envelope: `{ success: true, data }` on 2xx and
 * `{ success: false, error }` on 4xx/5xx.
 */
function jsonRes(body: unknown, status = 200): Response {
	// Error callers already pass `{ error: ... }`; add the discriminant so the
	// fixture matches what `apiError()` actually sends.
	const payload =
		status >= 400
			? { success: false, ...(typeof body === "object" && body !== null ? body : {}) }
			: { success: true, data: body };
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * A stateful mock backend that simulates EmDash's REST API.
 * Supports schema, content CRUD, _rev tokens, and conflict detection.
 */
function createStatefulBackend() {
	const collections = new Map<
		string,
		{
			slug: string;
			label: string;
			labelSingular: string;
			fields: Array<{ slug: string; type: string; label: string; required?: boolean }>;
		}
	>();

	const content = new Map<string, StoredItem>();
	let idCounter = 0;

	// Seed a collection
	collections.set("posts", {
		slug: "posts",
		label: "Posts",
		labelSingular: "Post",
		fields: [
			{ slug: "title", type: "string", label: "Title", required: true },
			{ slug: "body", type: "portableText", label: "Body" },
			{ slug: "excerpt", type: "text", label: "Excerpt" },
		],
	});

	const interceptor: Interceptor = async (req) => {
		const url = new URL(req.url);
		const path = url.pathname.replace("/_emdash/api", "");

		// --- Schema routes ---

		if (req.method === "GET" && path === "/schema/collections") {
			return jsonRes({
				items: Array.from(collections.values(), ({ slug, label, labelSingular }) => ({
					slug,
					label,
					labelSingular,
					supports: [],
				})),
			});
		}

		const colMatch = path.match(COLLECTION_MATCH_REGEX);
		if (req.method === "GET" && colMatch) {
			const col = collections.get(colMatch[1]);
			if (!col) return jsonRes({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
			return jsonRes({ item: { ...col, supports: [] } });
		}

		// --- Manifest ---

		if (req.method === "GET" && path === "/manifest") {
			const cols: Record<string, unknown> = {};
			for (const [slug, col] of collections) {
				const fields: Record<string, unknown> = {};
				for (const f of col.fields) {
					fields[f.slug] = { kind: f.type, label: f.label, required: f.required };
				}
				cols[slug] = {
					label: col.label,
					labelSingular: col.labelSingular,
					supports: [],
					fields,
				};
			}
			return jsonRes({ version: "0.1.0", hash: "abc", collections: cols, plugins: {} });
		}

		// --- Content list ---

		const listMatch = path.match(CONTENT_LIST_REGEX);
		if (req.method === "GET" && listMatch) {
			const collectionSlug = listMatch[1];
			const status = url.searchParams.get("status");
			const items = [...content.values()]
				.filter((i) => i.type === collectionSlug)
				.filter((i) => !status || i.status === status);
			return jsonRes({ items, nextCursor: undefined });
		}

		// --- Content create ---

		if (req.method === "POST" && listMatch) {
			const collectionSlug = listMatch[1];
			const body = (await req.json()) as {
				data: Record<string, unknown>;
				slug?: string;
				status?: string;
			};
			const id = `item_${++idCounter}`;
			const now = new Date().toISOString();
			const item: StoredItem = {
				id,
				type: collectionSlug,
				slug: body.slug ?? null,
				status: body.status ?? "draft",
				data: body.data,
				authorId: null,
				createdAt: now,
				updatedAt: now,
				publishedAt: null,
				scheduledAt: null,
				liveRevisionId: null,
				draftRevisionId: null,
				version: 1,
			};
			content.set(id, item);
			return jsonRes({ item, _rev: encodeRev(item) });
		}

		// --- Content get/update/delete ---

		const itemMatch = path.match(CONTENT_ITEM_REGEX);
		if (itemMatch) {
			const itemId = itemMatch[2];
			const item = content.get(itemId);

			if (req.method === "GET") {
				if (!item) return jsonRes({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
				return jsonRes({ item, _rev: encodeRev(item) });
			}

			if (req.method === "PUT") {
				if (!item) return jsonRes({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

				const body = (await req.json()) as {
					data?: Record<string, unknown>;
					slug?: string;
					status?: string;
					_rev?: string;
				};

				// Check _rev for conflict
				if (body._rev) {
					const expected = encodeRev(item);
					if (body._rev !== expected) {
						return jsonRes(
							{
								error: {
									code: "CONFLICT",
									message: "Entry has been modified since last read",
								},
							},
							409,
						);
					}
				}

				// Apply updates
				if (body.data) item.data = { ...item.data, ...body.data };
				if (body.slug !== undefined) item.slug = body.slug;
				if (body.status) item.status = body.status;
				item.updatedAt = new Date().toISOString();
				item.version++;

				return jsonRes({ item, _rev: encodeRev(item) });
			}

			if (req.method === "DELETE") {
				if (!item) return jsonRes({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
				item.status = "trashed";
				item.updatedAt = new Date().toISOString();
				return jsonRes({});
			}
		}

		// --- Content actions ---

		const actionMatch = path.match(CONTENT_ACTION_REGEX);
		if (req.method === "POST" && actionMatch) {
			const itemId = actionMatch[2];
			const action = actionMatch[3];
			const item = content.get(itemId);

			if (!item) return jsonRes({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

			switch (action) {
				case "publish":
					item.status = "published";
					item.publishedAt = new Date().toISOString();
					break;
				case "unpublish":
					item.status = "draft";
					item.publishedAt = null;
					break;
				case "schedule": {
					const body = (await req.json()) as { scheduledAt: string };
					item.scheduledAt = body.scheduledAt;
					break;
				}
				case "restore":
					item.status = "draft";
					break;
			}

			item.updatedAt = new Date().toISOString();
			return jsonRes({});
		}

		// --- Search ---

		if (req.method === "GET" && path === "/search") {
			const q = url.searchParams.get("q") ?? "";
			const items = [...content.values()]
				.filter((i) => JSON.stringify(i.data).toLowerCase().includes(q.toLowerCase()))
				.map((i) => ({
					id: i.id,
					collection: i.type,
					title: typeof i.data.title === "string" ? i.data.title : "",
					score: 1,
				}));
			return jsonRes({ items });
		}

		return jsonRes(
			{ error: { code: "NOT_FOUND", message: `No route: ${req.method} ${path}` } },
			404,
		);
	};

	return { interceptor, collections, content };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmDashClient lifecycle (integration)", () => {
	function createClient() {
		const { interceptor, content } = createStatefulBackend();
		const client = new EmDashClient({
			baseUrl: "http://localhost:4321",
			token: "test",
			interceptors: [interceptor],
		});
		return { client, content };
	}

	it("full content CRUD lifecycle", async () => {
		const { client } = createClient();

		// Create
		const created = await client.create("posts", {
			data: { title: "My Post", body: "Hello **world**" },
			slug: "my-post",
			status: "draft",
		});
		expect(created.id).toBeDefined();
		expect(created.slug).toBe("my-post");
		expect(created.status).toBe("draft");
		// body was converted from markdown to PT
		expect(Array.isArray(created.data.body)).toBe(true);

		// List
		const list = await client.list("posts");
		expect(list.items).toHaveLength(1);
		expect(list.items[0].id).toBe(created.id);

		// Get — returns _rev for optimistic concurrency
		const fetched = await client.get("posts", created.id);
		expect(fetched.id).toBe(created.id);
		expect(typeof fetched.data.body).toBe("string"); // PT -> markdown
		expect(fetched.data.body).toContain("world");
		expect(fetched._rev).toBeDefined();

		// Update with explicit _rev
		const updated = await client.update("posts", created.id, {
			data: { title: "Updated Title" },
			_rev: fetched._rev,
		});
		expect(updated.data.title).toBe("Updated Title");

		// Publish
		await client.publish("posts", created.id);

		// List published
		const published = await client.list("posts", { status: "published" });
		expect(published.items).toHaveLength(1);

		// Unpublish
		await client.unpublish("posts", created.id);

		// Delete (soft)
		await client.delete("posts", created.id);
	});

	it("blind update succeeds without _rev", async () => {
		const { client } = createClient();

		const item = await client.create("posts", {
			data: { title: "Test" },
		});

		// Update without reading — blind write (no _rev) should succeed
		const updated = await client.update("posts", item.id, {
			data: { title: "Blind Write OK" },
		});
		expect(updated.data.title).toBe("Blind Write OK");
	});

	it("get() returns _rev and update() accepts it for conflict detection", async () => {
		const { client } = createClient();

		const item = await client.create("posts", {
			data: { title: "Test" },
		});

		// Read — should return _rev on the item
		const fetched = await client.get("posts", item.id);
		expect(fetched._rev).toBeDefined();

		// Update with explicit _rev
		const updated = await client.update("posts", item.id, {
			data: { title: "Safe Update" },
			_rev: fetched._rev,
		});
		expect(updated.data.title).toBe("Safe Update");
	});

	it("multiple sequential updates work with explicit _rev", async () => {
		const { client } = createClient();

		const item = await client.create("posts", {
			data: { title: "V1" },
		});

		// First read
		const v1 = await client.get("posts", item.id);

		// First update with _rev
		await client.update("posts", item.id, {
			data: { title: "V2" },
			_rev: v1._rev,
		});

		// Re-read for fresh _rev (previous rev is now stale)
		const v2 = await client.get("posts", item.id);

		// Second update with new _rev
		const v3 = await client.update("posts", item.id, {
			data: { title: "V3" },
			_rev: v2._rev,
		});
		expect(v3.data.title).toBe("V3");
	});

	it("listAll() iterates through all items", async () => {
		const { client } = createClient();

		// Create multiple items
		await client.create("posts", { data: { title: "A" } });
		await client.create("posts", { data: { title: "B" } });
		await client.create("posts", { data: { title: "C" } });

		const all = [];
		for await (const item of client.listAll("posts")) {
			all.push(item);
		}
		expect(all).toHaveLength(3);
	});

	it("schedule() sets scheduling metadata", async () => {
		const { client } = createClient();

		const item = await client.create("posts", { data: { title: "Scheduled" } });
		await client.schedule("posts", item.id, { at: "2026-06-01T09:00:00Z" });

		// Verify via get
		const fetched = await client.get("posts", item.id);
		expect(fetched.scheduledAt).toBe("2026-06-01T09:00:00Z");
	});

	it("search() finds matching content", async () => {
		const { client } = createClient();

		await client.create("posts", { data: { title: "Deployment Guide" } });
		await client.create("posts", { data: { title: "Getting Started" } });

		const results = await client.search("deployment");
		expect(results).toHaveLength(1);
		expect(results[0].title).toBe("Deployment Guide");
	});

	it("schema operations work", async () => {
		const { client } = createClient();

		const cols = await client.collections();
		expect(cols.length).toBeGreaterThan(0);
		expect(cols[0].slug).toBe("posts");

		const col = await client.collection("posts");
		expect(col.fields).toHaveLength(3);
		expect(col.fields[0].slug).toBe("title");
	});

	it("manifest() returns full schema", async () => {
		const { client } = createClient();

		const manifest = await client.manifest();
		expect(manifest.version).toBe("0.1.0");
		expect(manifest.collections.posts).toBeDefined();
		expect(manifest.collections.posts.fields.title).toBeDefined();
	});

	it("API errors are typed correctly", async () => {
		const { client } = createClient();

		try {
			await client.get("posts", "nonexistent");
			expect.fail("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(EmDashApiError);
			const apiErr = error as EmDashApiError;
			expect(apiErr.status).toBe(404);
			expect(apiErr.code).toBe("NOT_FOUND");
		}
	});

	it("PT conversion round-trips through create and get", async () => {
		const { client } = createClient();

		// Create with markdown
		const item = await client.create("posts", {
			data: {
				title: "Markdown Post",
				body: "# Hello\n\nSome **bold** text\n\n- Item 1\n- Item 2",
			},
		});

		// Data stored as PT
		expect(Array.isArray(item.data.body)).toBe(true);

		// Get returns markdown
		const fetched = await client.get("posts", item.id);
		expect(typeof fetched.data.body).toBe("string");
		const body = fetched.data.body as string;
		expect(body).toContain("# Hello");
		expect(body).toContain("**bold**");
		expect(body).toContain("- Item 1");
	});
});
