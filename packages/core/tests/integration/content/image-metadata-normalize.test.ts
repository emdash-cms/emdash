import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { INTERNAL_MEDIA_PREFIX } from "../../../src/media/normalize.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type ImageValue = Record<string, unknown>;

const externalUrl = "https://example.com/a.jpg";

describeEachDialect("image metadata normalization", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let mediaId: string;
	let storageKey: string;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "hero",
			label: "Hero",
			type: "image",
			options: { darkVariant: true },
		});
		await registry.createField("posts", {
			slug: "gallery",
			label: "Gallery",
			type: "repeater",
			validation: { subFields: [{ slug: "image", label: "Image", type: "image" }] },
		});

		mediaId = ulid();
		storageKey = "soup.jpg";
		await ctx.db
			.insertInto("media")
			.values({
				id: mediaId,
				filename: storageKey,
				mime_type: "image/jpeg",
				size: 100,
				width: 1200,
				height: 800,
				alt: "Provider alt",
				caption: "Provider caption",
				focal_x: 0.25,
				focal_y: 0.75,
				storage_key: storageKey,
				content_hash: null,
				blurhash: null,
				dominant_color: null,
				status: "ready",
				author_id: null,
			})
			.execute();

		runtime = createTestRuntime(ctx.db);
		runtime.mediaProviders.set("local", createMediaProvider({ db: ctx.db }));
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it.each([
		["missing id and provider", {}],
		["empty id and provider", { id: "", provider: "" }],
	])("keeps metadata when upgrading an external image with %s", async (_name, identity) => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "external-metadata",
			data: { title: "Before" },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const image = {
			...identity,
			src: externalUrl,
			alt: "A bowl of soup",
			caption: "Soup",
			width: 640,
			meta: { importedFrom: "wordpress" },
		};
		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { title: "After", hero: image, gallery: [{ image }] },
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;

		const data = updated.data.item.data as {
			title: string;
			hero: ImageValue;
			gallery: Array<{ image: ImageValue }>;
		};
		const expected = {
			provider: "external",
			id: "",
			src: externalUrl,
			alt: "A bowl of soup",
			caption: "Soup",
			width: 640,
			meta: { importedFrom: "wordpress" },
		};
		expect(data.hero).toEqual(expected);
		expect(data.gallery[0]!.image).toEqual(expected);

		const savedAgain = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: { ...data, title: "After again" },
		});
		expect(savedAgain.success).toBe(true);
		if (!savedAgain.success) return;
		const dataAfterSecondSave = savedAgain.data.item.data as typeof data;
		expect(dataAfterSecondSave.hero).toEqual(expected);
		expect(dataAfterSecondSave.gallery[0]!.image).toEqual(expected);
	});

	it.each([
		{ name: "missing coordinates", input: {}, expected: { focalX: 0.25, focalY: 0.75 } },
		{ name: "valid override", input: { focalX: 0, focalY: 1 }, expected: { focalX: 0, focalY: 1 } },
		{
			name: "partial coordinates",
			input: { focalX: 0.9 },
			expected: { focalX: 0.25, focalY: 0.75 },
		},
		{
			name: "invalid coordinate pair",
			input: { focalX: -1, focalY: 0.8 },
			expected: { focalX: 0.25, focalY: 0.75 },
		},
		{
			name: "malformed coordinate pair",
			input: { focalX: "0.9", focalY: "0.8" },
			expected: { focalX: 0.25, focalY: 0.75 },
		},
	])("retains local focal points and alt text with $name", async ({ name, input, expected }) => {
		const created = await runtime.handleContentCreate("posts", {
			slug: `local-focal-${name.replaceAll(" ", "-")}`,
			data: { title: "Before" },
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const updated = await runtime.handleContentUpdate("posts", created.data.item.id, {
			data: {
				title: "After",
				hero: { src: mediaId, alt: "Caller alt", ...input },
				gallery: [
					{ image: { src: `${INTERNAL_MEDIA_PREFIX}${mediaId}`, alt: "Caller alt", ...input } },
				],
			},
		});
		expect(updated.success).toBe(true);
		if (!updated.success) return;

		const data = updated.data.item.data as {
			hero: ImageValue;
			gallery: Array<{ image: ImageValue }>;
		};
		for (const image of [data.hero, data.gallery[0]!.image]) {
			expect(image).toMatchObject({ alt: "Caller alt", ...expected });
		}
	});

	it("resolves local legacy values while keeping caller metadata and removing derived src", async () => {
		const created = await runtime.handleContentCreate("posts", {
			slug: "local-metadata",
			data: {
				title: "Before",
				hero: {
					src: mediaId,
					alt: "Caller alt",
					caption: "Caller caption",
					meta: { importedFrom: "wordpress" },
				},
				gallery: [
					{
						image: {
							src: `${INTERNAL_MEDIA_PREFIX}${mediaId}`,
							alt: "Gallery alt",
							caption: "Gallery caption",
							meta: { importedFrom: "wordpress" },
						},
					},
				],
			},
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const data = created.data.item.data as {
			hero: ImageValue;
			gallery: Array<{ image: ImageValue }>;
		};
		expect(data.hero).toMatchObject({
			id: mediaId,
			provider: "local",
			meta: { storageKey, importedFrom: "wordpress", caption: "Caller caption" },
			alt: "Caller alt",
			caption: "Caller caption",
		});
		expect(data.hero).not.toHaveProperty("src");
		expect(data.gallery[0]!.image).toMatchObject({
			id: mediaId,
			provider: "local",
			meta: { storageKey, importedFrom: "wordpress", caption: "Gallery caption" },
			alt: "Gallery alt",
			caption: "Gallery caption",
		});
		expect(data.gallery[0]!.image).not.toHaveProperty("src");
	});

	it("fills provider alt while preserving an empty local caption", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "empty-local-metadata",
			data: {
				title: "Empty metadata",
				hero: { src: mediaId, alt: "", caption: "", meta: { caption: "" } },
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as { hero: ImageValue }).hero;
		expect(hero).toMatchObject({
			id: mediaId,
			provider: "local",
			alt: "Provider alt",
			caption: "",
			meta: { caption: "" },
		});
	});

	it("normalizes a dark variant bare local id while upgrading a legacy URL", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "external-variant",
			data: { title: "Variant", hero: { src: externalUrl, darkVariant: mediaId } },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as { hero: ImageValue }).hero;
		expect(hero).toMatchObject({ provider: "external", id: "", src: externalUrl });
		expect(hero.darkVariant).toMatchObject({
			id: mediaId,
			provider: "local",
			meta: { storageKey },
		});
		expect(hero.darkVariant).not.toBe(mediaId);
	});

	it("drops invalid external metadata", async () => {
		const result = await runtime.handleContentCreate("posts", {
			slug: "invalid-external-metadata",
			data: {
				title: "Invalid metadata",
				hero: { src: externalUrl, alt: null, caption: null, width: "640", meta: "invalid" },
			},
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const hero = (result.data.item.data as { hero: ImageValue }).hero;
		expect(hero).toEqual({ provider: "external", id: "", src: externalUrl });
	});

	it("does not turn a whitespace src into an identity-less media value", async () => {
		const value = { src: "   ", alt: "Whitespace" };
		const result = await runtime.handleContentCreate("posts", {
			slug: "whitespace-src",
			data: { title: "Whitespace", hero: value },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});
});
