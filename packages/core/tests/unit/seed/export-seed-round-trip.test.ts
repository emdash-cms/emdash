import type { Kysely } from "kysely";
import { sql } from "kysely";
import { ulid } from "ulidx";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { setDefaultDnsResolver } from "../../../src/import/ssrf.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import type { SeedFile } from "../../../src/seed/types.js";
import type { Storage, UploadOptions } from "../../../src/storage/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const MEDIA_BASE_URL = "https://source.example.com";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let previousResolver: ReturnType<typeof setDefaultDnsResolver> | undefined;
beforeAll(() => {
	previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
});
afterAll(() => {
	setDefaultDnsResolver(previousResolver ?? null);
});

function createMemoryStorage(): Storage & { uploads: UploadOptions[] } {
	const uploads: UploadOptions[] = [];
	return {
		uploads,
		async upload(options) {
			uploads.push(options);
		},
		async download(key) {
			const upload = uploads.find((u) => u.key === key);
			if (!upload) throw new Error(`Not found: ${key}`);
			return { body: upload.body, contentType: upload.contentType };
		},
		async delete() {},
		async exists(key) {
			return uploads.some((u) => u.key === key);
		},
		getPublicUrl(key) {
			return `https://storage.example.com/${key}`;
		},
	} as Storage & { uploads: UploadOptions[] };
}

function pngResponse(): Response {
	return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
		status: 200,
		headers: { "content-type": "image/png" },
	});
}

async function applyToFreshDatabase(
	seed: SeedFile,
	run: (restored: Kysely<Database>) => Promise<void>,
): Promise<void> {
	const restored = await setupTestDatabase();
	try {
		await applySeed(restored, structuredClone(seed), {
			includeContent: true,
			storage: createMemoryStorage(),
		});
		await run(restored);
	} finally {
		await teardownTestDatabase(restored);
	}
}

describe("exportSeed → applySeed round trip", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		mockFetch.mockReset();
		mockFetch.mockImplementation(async () => pngResponse());
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("restores sections", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("_emdash_sections")
			.values([
				{
					id: ulid(),
					slug: "hero-banner",
					title: "Hero banner",
					description: "Large intro block",
					keywords: JSON.stringify(["hero", "intro"]),
					content: JSON.stringify([
						{ _type: "block", _key: "a1", children: [{ _type: "span", _key: "s1", text: "Hi" }] },
					]),
					preview_media_id: null,
					source: "user",
					theme_id: null,
					created_at: now,
					updated_at: now,
				},
				{
					id: ulid(),
					slug: "imported-cta",
					title: "Imported CTA",
					description: null,
					keywords: null,
					content: JSON.stringify([]),
					preview_media_id: null,
					source: "import",
					theme_id: null,
					created_at: now,
					updated_at: now,
				},
			])
			.execute();

		const seed = await exportSeed(db);

		await applyToFreshDatabase(seed, async (restored) => {
			const sections = await restored
				.selectFrom("_emdash_sections")
				.select(["slug", "title", "description", "keywords", "content", "source"])
				.orderBy("slug")
				.execute();
			expect(sections).toEqual([
				{
					slug: "hero-banner",
					title: "Hero banner",
					description: "Large intro block",
					keywords: JSON.stringify(["hero", "intro"]),
					content: JSON.stringify([
						{ _type: "block", _key: "a1", children: [{ _type: "span", _key: "s1", text: "Hi" }] },
					]),
					source: "user",
				},
				{
					slug: "imported-cta",
					title: "Imported CTA",
					description: null,
					keywords: null,
					content: "[]",
					source: "import",
				},
			]);
		});
	});

	it("leaves out sections whose slug a seed cannot carry", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("_emdash_sections")
			.values(
				["valid-slug", "wp_block_slug"].map((slug) => ({
					id: ulid(),
					slug,
					title: slug,
					description: null,
					keywords: null,
					content: "[]",
					preview_media_id: null,
					source: "import",
					theme_id: null,
					created_at: now,
					updated_at: now,
				})),
			)
			.execute();

		const warnings: string[] = [];
		const seed = await exportSeed(db, undefined, { warn: (message) => warnings.push(message) });

		expect(seed.sections?.map((s) => s.slug)).toEqual(["valid-slug"]);
		expect(warnings).toEqual([expect.stringContaining('"wp_block_slug"')]);
		await applyToFreshDatabase(seed, async () => {});
	});

	it("exports one redirect per source when older rows share a source", async () => {
		const redirects = new RedirectRepository(db);
		await redirects.create({ source: "/dup", destination: "/current" });
		// Duplicate sources survive only from before the source guard existed;
		// the guard trigger would otherwise claim the uniqueness slot.
		await sql`DROP TRIGGER emdash_redirect_guard_insert`.execute(db);
		const now = new Date().toISOString();
		await db
			.insertInto("_emdash_redirects")
			.values({
				id: ulid(),
				source: "/dup",
				destination: "/stale",
				type: 301,
				is_pattern: 0,
				enabled: 1,
				hits: 0,
				last_hit_at: null,
				group_name: null,
				auto: 0,
				config_revision: ulid(),
				source_guard: 0,
				write_generation: 0,
				created_at: now,
				updated_at: now,
			})
			.execute();

		const warnings: string[] = [];
		const seed = await exportSeed(db, undefined, { warn: (message) => warnings.push(message) });

		expect(seed.redirects).toEqual([{ source: "/dup", destination: "/current", type: 301 }]);
		expect(warnings).toEqual([expect.stringContaining('"/dup"')]);
		await applyToFreshDatabase(seed, async () => {});
	});

	it("restores redirects", async () => {
		const redirects = new RedirectRepository(db);
		await redirects.create({ source: "/old", destination: "/new", type: 302 });
		await redirects.create({
			source: "/legacy/[slug]",
			destination: "/blog/[slug]",
			enabled: false,
			groupName: "migration",
		});

		const seed = await exportSeed(db);

		await applyToFreshDatabase(seed, async (restored) => {
			const rows = await restored
				.selectFrom("_emdash_redirects")
				.select(["source", "destination", "type", "enabled", "group_name", "is_pattern"])
				.orderBy("source")
				.execute();
			expect(rows).toEqual([
				{
					source: "/legacy/[slug]",
					destination: "/blog/[slug]",
					type: 301,
					enabled: 0,
					group_name: "migration",
					is_pattern: 1,
				},
				{
					source: "/old",
					destination: "/new",
					type: 302,
					enabled: 1,
					group_name: null,
					is_pattern: 0,
				},
			]);
		});
	});

	it("leaves out terminal redirects the seed format cannot represent", async () => {
		const redirects = new RedirectRepository(db);
		await redirects.create({ source: "/kept", destination: "/target" });
		await redirects.create({ source: "/gone", destination: "", type: 410 });

		const warnings: string[] = [];
		const seed = await exportSeed(db, undefined, { warn: (message) => warnings.push(message) });

		expect(seed.redirects?.map((r) => r.source)).toEqual(["/kept"]);
		expect(warnings).toEqual([expect.stringContaining('"/gone"')]);
		await applyToFreshDatabase(seed, async () => {});
	});

	it("points menu items at the restored content", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "products", label: "Products" });
		await registry.createField("products", { slug: "title", label: "Title", type: "string" });

		const contentRepo = new ContentRepository(db);
		const about = await contentRepo.create({
			type: "pages",
			slug: "about",
			status: "published",
			data: { title: "About" },
		});
		const widget = await contentRepo.create({
			type: "products",
			slug: "widget",
			status: "published",
			data: { title: "Widget" },
		});

		const menuId = ulid();
		await db
			.insertInto("_emdash_menus")
			.values({ id: menuId, name: "primary", label: "Primary", locale: "en" })
			.execute();
		await db
			.insertInto("_emdash_menu_items")
			.values([
				{
					id: ulid(),
					menu_id: menuId,
					sort_order: 0,
					type: "page",
					reference_collection: "pages",
					reference_id: about.translationGroup ?? about.id,
					label: "About",
					locale: "en",
				},
				{
					id: ulid(),
					menu_id: menuId,
					sort_order: 1,
					type: "collection",
					reference_collection: "products",
					reference_id: widget.translationGroup ?? widget.id,
					label: "Widget",
					locale: "en",
				},
				{
					id: ulid(),
					menu_id: menuId,
					sort_order: 2,
					type: "collection",
					reference_collection: "products",
					reference_id: null,
					label: "All products",
					locale: "en",
				},
			])
			.execute();

		const seed = await exportSeed(db, "all");

		await applyToFreshDatabase(seed, async (restored) => {
			const restoredRepo = new ContentRepository(restored);
			const restoredAbout = await restoredRepo.findBySlug("pages", "about");
			const restoredWidget = await restoredRepo.findBySlug("products", "widget");

			const items = await restored
				.selectFrom("_emdash_menu_items")
				.select(["label", "type", "reference_collection", "reference_id"])
				.orderBy("sort_order")
				.execute();
			expect(items).toEqual([
				{
					label: "About",
					type: "page",
					reference_collection: "pages",
					reference_id: restoredAbout?.translationGroup,
				},
				{
					label: "Widget",
					type: "collection",
					reference_collection: "products",
					reference_id: restoredWidget?.translationGroup,
				},
				{
					label: "All products",
					type: "collection",
					reference_collection: "products",
					reference_id: null,
				},
			]);
		});
	});

	it("points a menu item at the translation group of multi-locale content", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });

		const contentRepo = new ContentRepository(db);
		const about = await contentRepo.create({
			type: "pages",
			slug: "about",
			status: "published",
			locale: "en",
			data: { title: "About" },
		});
		await contentRepo.create({
			type: "pages",
			slug: "a-propos",
			status: "published",
			locale: "fr",
			translationOf: about.id,
			data: { title: "À propos" },
		});

		const menuId = ulid();
		await db
			.insertInto("_emdash_menus")
			.values({ id: menuId, name: "primary", label: "Primary", locale: "fr" })
			.execute();
		await db
			.insertInto("_emdash_menu_items")
			.values({
				id: ulid(),
				menu_id: menuId,
				sort_order: 0,
				type: "page",
				reference_collection: "pages",
				reference_id: about.translationGroup ?? about.id,
				label: "À propos",
				locale: "fr",
			})
			.execute();

		const seed = await exportSeed(db, "all");

		await applyToFreshDatabase(seed, async (restored) => {
			const restoredRepo = new ContentRepository(restored);
			const restoredEn = await restoredRepo.findBySlug("pages", "about", "en");
			const restoredFr = await restoredRepo.findBySlug("pages", "a-propos", "fr");
			expect(restoredFr?.translationGroup).toBe(restoredEn?.translationGroup);

			const item = await restored
				.selectFrom("_emdash_menu_items")
				.select("reference_id")
				.executeTakeFirstOrThrow();
			expect(item.reference_id).toBe(restoredEn?.translationGroup);
		});
	});

	describe("media", () => {
		async function createMediaSite(): Promise<{ storageKey: string }> {
			const registry = new SchemaRegistry(db);
			await registry.createCollection({ slug: "posts", label: "Posts" });
			await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
			await registry.createField("posts", { slug: "cover", label: "Cover", type: "image" });
			await registry.createField("posts", {
				slug: "attachment",
				label: "Attachment",
				type: "file",
			});
			await registry.createField("posts", {
				slug: "slides",
				label: "Slides",
				type: "repeater",
				validation: {
					subFields: [
						{ slug: "caption", label: "Caption", type: "string" },
						{ slug: "photo", label: "Photo", type: "image" },
					],
				},
			});

			const storageKey = `${ulid()}.png`;
			const media = await new MediaRepository(db).create({
				filename: "cover.png",
				mimeType: "image/png",
				storageKey,
				alt: "A cover",
				status: "ready",
			});
			const value = {
				provider: "local",
				id: media.id,
				filename: "cover.png",
				meta: { storageKey },
			};

			await new ContentRepository(db).create({
				type: "posts",
				slug: "hello",
				status: "published",
				data: {
					title: "Hello",
					cover: value,
					attachment: value,
					slides: [{ caption: "First", photo: value }],
				},
			});

			return { storageKey };
		}

		it("emits absolute media URLs when given a base URL", async () => {
			const { storageKey } = await createMediaSite();

			const seed = await exportSeed(db, "all", { mediaBaseUrl: MEDIA_BASE_URL });

			const post = seed.content?.posts?.[0];
			const expected = {
				$media: expect.objectContaining({
					url: `${MEDIA_BASE_URL}/_emdash/api/media/file/${storageKey}`,
					filename: "cover.png",
				}),
			};
			expect(post?.data.cover).toEqual(expected);
			expect(post?.data.attachment).toEqual(expected);
			expect(post?.data.slides).toEqual([{ caption: "First", photo: expected }]);
		});

		it("re-uploads exported media into the restored site", async () => {
			const { storageKey } = await createMediaSite();

			const seed = await exportSeed(db, "all", { mediaBaseUrl: MEDIA_BASE_URL });

			await applyToFreshDatabase(seed, async (restored) => {
				const post = await new ContentRepository(restored).findBySlug("posts", "hello");
				const media = await restored.selectFrom("media").select("id").execute();
				const restoredIds = new Set(media.map((m) => m.id));

				const cover = post?.data.cover as { id?: string } | null;
				const attachment = post?.data.attachment as { id?: string } | null;
				const slides = post?.data.slides as Array<{ photo: { id?: string } | null }>;
				expect(restoredIds.has(cover?.id ?? "")).toBe(true);
				expect(restoredIds.has(attachment?.id ?? "")).toBe(true);
				expect(restoredIds.has(slides[0]?.photo?.id ?? "")).toBe(true);
			});
			expect(mockFetch).toHaveBeenCalledWith(
				`${MEDIA_BASE_URL}/_emdash/api/media/file/${storageKey}`,
				expect.anything(),
			);
		});

		it("warns that site-relative media URLs cannot be imported", async () => {
			const { storageKey } = await createMediaSite();

			const warnings: string[] = [];
			const seed = await exportSeed(db, "all", { warn: (message) => warnings.push(message) });

			expect(seed.content?.posts?.[0]?.data.cover).toMatchObject({
				$media: { url: `/_emdash/api/media/file/${storageKey}` },
			});
			expect(warnings).toEqual([expect.stringContaining("3 media reference(s)")]);
		});

		it("rejects a media base URL that applySeed could not download from", async () => {
			await expect(exportSeed(db, "all", { mediaBaseUrl: "ftp://example.com" })).rejects.toThrow(
				"http or https",
			);
			await expect(exportSeed(db, "all", { mediaBaseUrl: "example.com" })).rejects.toThrow(
				"Invalid media base URL",
			);
		});

		it("accepts a base URL with a path and trailing slash", async () => {
			const { storageKey } = await createMediaSite();

			const seed = await exportSeed(db, "all", { mediaBaseUrl: "https://cdn.example.com/site/" });

			expect(seed.content?.posts?.[0]?.data.cover).toMatchObject({
				$media: { url: `https://cdn.example.com/site/_emdash/api/media/file/${storageKey}` },
			});
		});
	});

	it("keeps scheduled entries unpublished", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const contentRepo = new ContentRepository(db);
		const upcoming = await contentRepo.create({
			type: "posts",
			slug: "upcoming",
			data: { title: "Upcoming" },
		});
		await contentRepo.schedule(
			"posts",
			upcoming.id,
			new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
		);

		const seed = await exportSeed(db, "all");

		await applyToFreshDatabase(seed, async (restored) => {
			const restoredEntry = await new ContentRepository(restored).findBySlug("posts", "upcoming");
			expect(restoredEntry?.status).toBe("draft");
			expect(restoredEntry?.publishedAt).toBeNull();
		});
	});

	it("restores collection display settings and field translatability", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "events",
			label: "Events",
			commentsEnabled: true,
		});
		await registry.createField("events", { slug: "name", label: "Name", type: "string" });
		await registry.createField("events", { slug: "starts_at", label: "Starts", type: "datetime" });
		await registry.createField("events", {
			slug: "venue_code",
			label: "Venue code",
			type: "string",
			translatable: false,
		});
		await registry.updateCollection("events", { titleField: "name", dateField: "starts_at" });

		const seed = await exportSeed(db);

		await applyToFreshDatabase(seed, async (restored) => {
			const restoredRegistry = new SchemaRegistry(restored);
			const collection = await restoredRegistry.getCollection("events");
			expect(collection).toMatchObject({
				commentsEnabled: true,
				titleField: "name",
				dateField: "starts_at",
			});
			const fields = await restoredRegistry.listFields(collection!.id);
			expect(Object.fromEntries(fields.map((field) => [field.slug, field.translatable]))).toEqual({
				name: true,
				starts_at: true,
				venue_code: false,
			});
		});
	});
});
