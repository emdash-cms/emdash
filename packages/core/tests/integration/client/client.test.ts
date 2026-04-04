/**
 * E2E tests for EmDashClient against a real Astro dev server.
 *
 * Uses an isolated fixture (not the demo site). The test helper
 * creates a temp directory, starts a fresh dev server, runs setup,
 * and seeds collections with test data.
 *
 * Runs by default. Requires built artifacts (auto-builds if missing).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { EmDashClient, EmDashApiError } from "../../../src/client/index.js";
import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const PORT = 4399;

describe("EmDashClient Integration", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: PORT });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	it("fetches the manifest", async () => {
		const manifest = await ctx.client.manifest();
		expect(manifest.version).toBeDefined();
		expect(typeof manifest.collections).toBe("object");
	});

	it("lists collections", async () => {
		const collections = await ctx.client.collections();
		expect(Array.isArray(collections)).toBe(true);
		// Seeded collections should be present
		const slugs = collections.map((c: { slug: string }) => c.slug);
		expect(slugs).toContain("posts");
		expect(slugs).toContain("pages");
	});

	it("lists seeded content", async () => {
		const posts = await ctx.client.list("posts");
		expect(posts.items.length).toBeGreaterThanOrEqual(2);

		// Check published posts are returned
		const titles = posts.items.map((p: { data: Record<string, unknown> }) => p.data.title);
		expect(titles).toContain("First Post");
		expect(titles).toContain("Second Post");
	});

	it("creates, reads, updates, and deletes content", async () => {
		// Create
		const item = await ctx.client.create("posts", {
			data: { title: "E2E Article", body: "Hello **e2e**", excerpt: "Testing" },
			slug: "e2e-article",
		});
		expect(item.id).toBeDefined();
		expect(item.slug).toBe("e2e-article");

		// Read — returns _rev for optimistic concurrency
		const fetched = await ctx.client.get("posts", item.id);
		expect(fetched.data.title).toBe("E2E Article");
		expect(typeof fetched.data.body).toBe("string"); // PT→Markdown
		expect(fetched._rev).toBeDefined();

		// Update — pass _rev explicitly
		const updated = await ctx.client.update("posts", item.id, {
			data: { title: "Updated E2E Article" },
			_rev: fetched._rev,
		});
		expect(updated.data.title).toBe("Updated E2E Article");

		// Publish / unpublish
		await ctx.client.publish("posts", item.id);
		await ctx.client.unpublish("posts", item.id);

		// Delete
		await ctx.client.delete("posts", item.id);
	});

	it("blind update succeeds without _rev", async () => {
		const item = await ctx.client.create("posts", {
			data: { title: "Blind Update Test" },
		});

		// Fresh client — no prior get(), no _rev — blind write should succeed
		const freshClient = new EmDashClient({
			baseUrl: ctx.baseUrl,
			devBypass: true,
		});

		const updated = await freshClient.update("posts", item.id, {
			data: { title: "Blind Write OK" },
		});
		expect(updated.data.title).toBe("Blind Write OK");

		await ctx.client.delete("posts", item.id);
	});

	it("returns Portable Text arrays in raw mode", async () => {
		const item = await ctx.client.create("posts", {
			data: { title: "Raw Test", body: "Some **bold** text" },
		});

		// Normal get — body as markdown string
		const normal = await ctx.client.get("posts", item.id);
		expect(typeof normal.data.body).toBe("string");

		// Raw get — body as PT array
		const raw = await ctx.client.get("posts", item.id, { raw: true });
		expect(Array.isArray(raw.data.body)).toBe(true);

		await ctx.client.delete("posts", item.id);
	});

	it("authenticates with PAT token", async () => {
		// Use the PAT token directly via fetch (not the devBypass client)
		const res = await fetch(`${ctx.baseUrl}/_emdash/api/content/posts`, {
			headers: { Authorization: `Bearer ${ctx.token}` },
		});
		expect(res.ok).toBe(true);
		const json = (await res.json()) as { data: { items: unknown[] } };
		expect(Array.isArray(json.data.items)).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Rendered output tests
	// -----------------------------------------------------------------------

	/** Fetch a page and return the HTML body text */
	async function fetchHtml(path: string): Promise<string> {
		const res = await fetch(`${ctx.baseUrl}${path}`);
		return res.text();
	}

	it("renders seeded posts on the index page", async () => {
		const html = await fetchHtml("/");
		// Published posts should appear
		expect(html).toContain("First Post");
		expect(html).toContain("Second Post");
		// Draft post should NOT appear on the public page
		expect(html).not.toContain("Draft Post");
	});

	it("renders a single post by slug", async () => {
		const html = await fetchHtml("/posts/first-post");
		expect(html).toContain('<h1 id="title">First Post</h1>');
		expect(html).toContain("The very first post"); // excerpt
	});

	it("returns 404 for a nonexistent slug", async () => {
		const res = await fetch(`${ctx.baseUrl}/posts/does-not-exist`);
		expect(res.status).toBe(404);
	});

	it("reflects API edits in rendered output", async () => {
		// Create and publish a new post
		const item = await ctx.client.create("posts", {
			data: { title: "Render Test Post", excerpt: "Check the HTML" },
			slug: "render-test",
		});
		await ctx.client.publish("posts", item.id);

		// Index page should include the new post
		const indexHtml = await fetchHtml("/");
		expect(indexHtml).toContain("Render Test Post");

		// Single page should render it
		const postHtml = await fetchHtml("/posts/render-test");
		expect(postHtml).toContain("Render Test Post");
		expect(postHtml).toContain("Check the HTML");

		// Update the title via API — pass _rev from get()
		const current = await ctx.client.get("posts", item.id);
		await ctx.client.update("posts", item.id, {
			data: { title: "Edited Render Test" },
			_rev: current._rev,
		});

		// Rendered page should reflect the edit
		const updatedHtml = await fetchHtml("/posts/render-test");
		expect(updatedHtml).toContain("Edited Render Test");
		expect(updatedHtml).not.toContain("Render Test Post");

		// Unpublish — should disappear from index
		await ctx.client.unpublish("posts", item.id);
		const afterUnpublish = await fetchHtml("/");
		expect(afterUnpublish).not.toContain("Edited Render Test");

		// Clean up
		await ctx.client.delete("posts", item.id);
	});

	it("creates and deletes collections", async () => {
		const col = await ctx.client.createCollection({
			slug: "e2e_temp",
			label: "Temp",
		});
		expect(col.slug).toBe("e2e_temp");

		const titleField = await ctx.client.createField("e2e_temp", {
			slug: "title",
			type: "string",
			label: "Title",
		});
		expect(titleField.slug).toBe("title");

		await ctx.client.deleteCollection("e2e_temp");

		// Collection should be gone
		const collections = await ctx.client.collections();
		const slugs = collections.map((c: { slug: string }) => c.slug);
		expect(slugs).not.toContain("e2e_temp");
	});

	// -----------------------------------------------------------------------
	// Media tests
	// -----------------------------------------------------------------------

	it("uploads, gets, lists, and deletes media", async () => {
		// Create a small PNG file (1x1 pixel)
		const pngBytes = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
			0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
			0xcf, 0xc0, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
			0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);

		// Upload
		const uploaded = await ctx.client.mediaUpload(pngBytes, "test-pixel.png", {
			alt: "A test pixel",
		});
		expect(uploaded.id).toBeDefined();
		expect(uploaded.filename).toBe("test-pixel.png");
		expect(uploaded.mimeType).toBe("image/png");

		// Get by ID
		const fetched = await ctx.client.mediaGet(uploaded.id);
		expect(fetched.id).toBe(uploaded.id);
		expect(fetched.filename).toBe("test-pixel.png");

		// List — should include the uploaded item
		const list = await ctx.client.mediaList();
		expect(list.items.length).toBeGreaterThanOrEqual(1);
		const ids = list.items.map((m: { id: string }) => m.id);
		expect(ids).toContain(uploaded.id);

		// Delete
		await ctx.client.mediaDelete(uploaded.id);

		// Should be gone
		await expect(ctx.client.mediaGet(uploaded.id)).rejects.toThrow();
	});

	// -----------------------------------------------------------------------
	// Conflict detection
	// -----------------------------------------------------------------------

	it("returns 409 on _rev conflict", async () => {
		const item = await ctx.client.create("posts", {
			data: { title: "Conflict Test" },
		});

		// Two clients both read the same version
		const clientA = new EmDashClient({ baseUrl: ctx.baseUrl, token: ctx.token });
		const clientB = new EmDashClient({ baseUrl: ctx.baseUrl, token: ctx.token });

		const fetchedA = await clientA.get("posts", item.id);
		const fetchedB = await clientB.get("posts", item.id);

		// A updates first — succeeds (passes _rev explicitly)
		await clientA.update("posts", item.id, {
			data: { title: "A wins" },
			_rev: fetchedA._rev,
		});

		// B's _rev is now stale — should get 409
		try {
			await clientB.update("posts", item.id, {
				data: { title: "B loses" },
				_rev: fetchedB._rev,
			});
			expect.fail("Should have thrown a conflict error");
		} catch (error) {
			expect(error).toBeInstanceOf(EmDashApiError);
			const apiErr = error as EmDashApiError;
			expect(apiErr.status).toBe(409);
			expect(apiErr.code).toBe("CONFLICT");
		}

		// Clean up
		await ctx.client.delete("posts", item.id);
	});

	// -----------------------------------------------------------------------
	// Schedule and restore
	// -----------------------------------------------------------------------

	it("schedules and restores content", async () => {
		const item = await ctx.client.create("posts", {
			data: { title: "Schedule Test" },
		});

		// Schedule for a future date
		await ctx.client.schedule("posts", item.id, { at: "2027-06-01T09:00:00Z" });

		// Verify via get
		const fetched = await ctx.client.get("posts", item.id);
		expect(fetched.scheduledAt).toBe("2027-06-01T09:00:00Z");

		// Trash and restore
		await ctx.client.delete("posts", item.id);
		await ctx.client.restore("posts", item.id);

		// Should be accessible again (restore preserves the previous status)
		const restored = await ctx.client.get("posts", item.id);
		expect(restored.status).toBe("scheduled");

		// Final cleanup
		await ctx.client.delete("posts", item.id);
	});

	// -----------------------------------------------------------------------
	// listAll cursor pagination
	// -----------------------------------------------------------------------

	it("listAll iterates through paginated results", async () => {
		// Create enough items to potentially page (use limit=2 to force pagination)
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const item = await ctx.client.create("posts", {
				data: { title: `Paginate ${i}` },
			});
			ids.push(item.id);
		}

		// listAll with small limit should still get all items
		const all: { id: string }[] = [];
		for await (const item of ctx.client.listAll("posts", { limit: 2 })) {
			all.push(item);
		}

		// Should have at least our 5 + the seeded posts
		expect(all.length).toBeGreaterThanOrEqual(5);

		// All our created IDs should be in the results
		const resultIds = all.map((a) => a.id);
		for (const id of ids) {
			expect(resultIds).toContain(id);
		}

		// Clean up
		for (const id of ids) {
			await ctx.client.delete("posts", id);
		}
	});

	// -----------------------------------------------------------------------
	// Error paths
	// -----------------------------------------------------------------------

	it("throws EmDashApiError on 404", async () => {
		try {
			await ctx.client.get("posts", "nonexistent-id-12345");
			expect.fail("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(EmDashApiError);
			const apiErr = error as EmDashApiError;
			expect(apiErr.status).toBe(404);
			expect(apiErr.code).toBe("NOT_FOUND");
		}
	});

	it("throws on unauthorized request (no token)", async () => {
		const noAuthClient = new EmDashClient({
			baseUrl: ctx.baseUrl,
			// No token, no devBypass
		});

		try {
			await noAuthClient.collections();
			expect.fail("Should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(EmDashApiError);
			expect((error as EmDashApiError).status).toBe(401);
		}
	});
});
