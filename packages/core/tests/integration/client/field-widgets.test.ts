/**
 * Integration tests for plugin field widgets.
 *
 * Tests the full pipeline:
 * - Manifest includes widget property on fields
 * - Manifest includes plugin fieldWidgets declarations
 * - Content CRUD works with widget-annotated fields
 * - Widget data roundtrips correctly through the API
 *
 * The integration fixture is configured with the color plugin and a
 * "theme_color" field with widget "color:picker" on the posts collection.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const PORT = 4397;

describe("Field Widgets Integration", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: PORT });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	describe("manifest", () => {
		it("includes widget property on the theme_color field", async () => {
			const res = await fetch(`${ctx.baseUrl}/_emdash/api/manifest`, {
				headers: {
					Cookie: ctx.sessionCookie,
					"X-EmDash-Request": "1",
				},
			});
			expect(res.ok).toBe(true);
			const body = (await res.json()) as { data: Record<string, unknown> };
			const manifest = body.data;

			const collections = manifest.collections as Record<string, Record<string, unknown>>;
			expect(collections.posts).toBeTruthy();

			const fields = collections.posts.fields as Record<string, { kind: string; widget?: string }>;
			expect(fields.theme_color).toBeTruthy();
			expect(fields.theme_color.kind).toBe("string");
			expect(fields.theme_color.widget).toBe("color:picker");
		});

		it("does not include widget on fields without one", async () => {
			const res = await fetch(`${ctx.baseUrl}/_emdash/api/manifest`, {
				headers: {
					Cookie: ctx.sessionCookie,
					"X-EmDash-Request": "1",
				},
			});
			const body = (await res.json()) as { data: Record<string, unknown> };
			const manifest = body.data;
			const collections = manifest.collections as Record<string, Record<string, unknown>>;
			const fields = collections.posts.fields as Record<string, { kind: string; widget?: string }>;

			expect(fields.title).toBeTruthy();
			expect(fields.title.widget).toBeUndefined();
		});

		it("includes color plugin with fieldWidgets in plugin manifest", async () => {
			const res = await fetch(`${ctx.baseUrl}/_emdash/api/manifest`, {
				headers: {
					Cookie: ctx.sessionCookie,
					"X-EmDash-Request": "1",
				},
			});
			const body = (await res.json()) as { data: Record<string, unknown> };
			const manifest = body.data;
			const plugins = manifest.plugins as Record<string, Record<string, unknown>>;

			expect(plugins.color).toBeTruthy();
			expect(plugins.color.enabled).toBe(true);

			const fieldWidgets = plugins.color.fieldWidgets as Array<{
				name: string;
				label: string;
				fieldTypes: string[];
			}>;
			expect(fieldWidgets).toBeTruthy();
			expect(fieldWidgets.length).toBe(1);
			expect(fieldWidgets[0]!.name).toBe("picker");
			expect(fieldWidgets[0]!.label).toBe("Color Picker");
			expect(fieldWidgets[0]!.fieldTypes).toEqual(["string"]);
		});
	});

	describe("content CRUD with widget fields", () => {
		it("creates content with a color widget field value", async () => {
			const item = await ctx.client.create("posts", {
				data: {
					title: "Colorful Post",
					theme_color: "#ff6600",
				},
				slug: "colorful-post",
			});
			expect(item.id).toBeDefined();
			expect(item.slug).toBe("colorful-post");
		});

		it("reads back the color value correctly", async () => {
			const item = await ctx.client.create("posts", {
				data: {
					title: "Read Color Test",
					theme_color: "#00ff88",
				},
				slug: "read-color-test",
			});

			const fetched = await ctx.client.get("posts", item.id);
			expect(fetched.data.title).toBe("Read Color Test");
			expect(fetched.data.theme_color).toBe("#00ff88");
		});

		it("updates the color value", async () => {
			const item = await ctx.client.create("posts", {
				data: {
					title: "Update Color Test",
					theme_color: "#111111",
				},
				slug: "update-color-test",
			});

			const fetched = await ctx.client.get("posts", item.id);
			const updated = await ctx.client.update("posts", item.id, {
				data: { theme_color: "#222222" },
				_rev: fetched._rev,
			});
			expect(updated.data.theme_color).toBe("#222222");
		});

		it("allows null/empty color value", async () => {
			const item = await ctx.client.create("posts", {
				data: {
					title: "No Color Post",
				},
				slug: "no-color-post",
			});

			const fetched = await ctx.client.get("posts", item.id);
			// Color field is optional, so it should be null/undefined
			expect(fetched.data.theme_color == null || fetched.data.theme_color === "").toBe(true);
		});

		it("stores color value alongside other content fields", async () => {
			const item = await ctx.client.create("posts", {
				data: {
					title: "Full Post",
					excerpt: "A post with color",
					theme_color: "#abcdef",
				},
				slug: "full-post-with-color",
			});

			const fetched = await ctx.client.get("posts", item.id);
			expect(fetched.data.title).toBe("Full Post");
			expect(fetched.data.excerpt).toBe("A post with color");
			expect(fetched.data.theme_color).toBe("#abcdef");
		});
	});

	describe("content list with widget fields", () => {
		it("includes widget field values in list results", async () => {
			await ctx.client.create("posts", {
				data: {
					title: "Listed Color Post",
					theme_color: "#ff0000",
				},
				slug: "listed-color-post",
			});

			const list = await ctx.client.list("posts");
			const post = list.items.find(
				(p: { data: Record<string, unknown> }) => p.data.title === "Listed Color Post",
			);
			expect(post).toBeTruthy();
			expect((post as { data: Record<string, unknown> }).data.theme_color).toBe("#ff0000");
		});
	});
});
