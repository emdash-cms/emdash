import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import type { Database } from "../../../src/database/types.js";
import { getEmDashCollection, getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

// query.ts dynamically imports `astro:content`. Mock it so we can hand the
// query layer a controlled raw entry shape and assert that `hydrateEntrySeo`
// runs against the real SeoRepository + DB.
const mockGetLiveEntry = vi.fn();
const mockGetLiveCollection = vi.fn();

vi.mock("astro:content", () => ({
	getLiveEntry: mockGetLiveEntry,
	getLiveCollection: mockGetLiveCollection,
}));

interface SeoFields {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

function readSeo(data: unknown): SeoFields | undefined {
	if (data && typeof data === "object" && "seo" in data) {
		return (data as { seo: SeoFields }).seo;
	}
	return undefined;
}

describe("SEO hydration via query wrappers", () => {
	let db: Kysely<Database>;
	let contentRepo: ContentRepository;
	let seoRepo: SeoRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		contentRepo = new ContentRepository(db);
		seoRepo = new SeoRepository(db);

		// Enable SEO on `post`; leave `page` disabled to test the negative case.
		await db
			.updateTable("_emdash_collections")
			.set({ has_seo: 1 })
			.where("slug", "=", "post")
			.execute();

		// Add a SEO-disabled collection with a different slug to make the test
		// intent obvious — `page` would also work since it defaults to has_seo=0.
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "note",
			label: "Notes",
			labelSingular: "Note",
		});
		await registry.createField("note", { slug: "title", label: "Title", type: "string" });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		mockGetLiveEntry.mockReset();
		mockGetLiveCollection.mockReset();
	});

	function rawEntry(dbId: string, slug: string, extra: Record<string, unknown> = {}) {
		return {
			id: slug,
			data: { id: dbId, slug, status: "published", ...extra },
		};
	}

	describe("getEmDashEntry", () => {
		it("hydrates entry.data.seo from the SeoRepository when has_seo = 1", async () => {
			const post = await contentRepo.create({
				type: "post",
				slug: "hello",
				data: { title: "Hello" },
				status: "published",
			});

			await seoRepo.upsert("post", post.id, {
				title: "Custom SEO Title",
				description: "Custom SEO Description",
				noIndex: true,
			});

			mockGetLiveEntry.mockResolvedValue({
				entry: rawEntry(post.id, "hello", { title: "Hello" }),
				cacheHint: {},
			});

			const result = await runWithContext({ editMode: false, db }, () =>
				getEmDashEntry("post", "hello"),
			);

			expect(result.entry).not.toBeNull();
			const seo = readSeo(result.entry?.data);
			expect(seo).toBeDefined();
			expect(seo?.title).toBe("Custom SEO Title");
			expect(seo?.description).toBe("Custom SEO Description");
			expect(seo?.noIndex).toBe(true);
		});

		it("does not attach entry.data.seo when has_seo = 0", async () => {
			const note = await contentRepo.create({
				type: "note",
				slug: "n1",
				data: { title: "Note 1" },
				status: "published",
			});

			mockGetLiveEntry.mockResolvedValue({
				entry: rawEntry(note.id, "n1", { title: "Note 1" }),
				cacheHint: {},
			});

			const result = await runWithContext({ editMode: false, db }, () =>
				getEmDashEntry("note", "n1"),
			);

			expect(result.entry).not.toBeNull();
			expect(readSeo(result.entry?.data)).toBeUndefined();
		});
	});

	describe("getEmDashCollection", () => {
		it("batch-hydrates seo on every entry, falling back to defaults for entries with no row", async () => {
			const a = await contentRepo.create({
				type: "post",
				slug: "a",
				data: { title: "A" },
				status: "published",
			});
			const b = await contentRepo.create({
				type: "post",
				slug: "b",
				data: { title: "B" },
				status: "published",
			});
			const c = await contentRepo.create({
				type: "post",
				slug: "c",
				data: { title: "C" },
				status: "published",
			});

			await seoRepo.upsert("post", a.id, { title: "SEO A" });
			await seoRepo.upsert("post", c.id, { title: "SEO C" });
			// b intentionally has no SEO row — expect default values.

			mockGetLiveCollection.mockResolvedValue({
				entries: [
					rawEntry(a.id, "a", { title: "A" }),
					rawEntry(b.id, "b", { title: "B" }),
					rawEntry(c.id, "c", { title: "C" }),
				],
				cacheHint: {},
			});

			const result = await runWithContext({ editMode: false, db }, () =>
				getEmDashCollection("post"),
			);

			expect(result.entries).toHaveLength(3);
			const titles = result.entries.map((entry) => readSeo(entry.data)?.title);
			expect(titles).toEqual(["SEO A", null, "SEO C"]);
		});

		it("does not attach seo to any entry when has_seo = 0", async () => {
			const n1 = await contentRepo.create({
				type: "note",
				slug: "n1",
				data: { title: "Note 1" },
				status: "published",
			});
			const n2 = await contentRepo.create({
				type: "note",
				slug: "n2",
				data: { title: "Note 2" },
				status: "published",
			});

			mockGetLiveCollection.mockResolvedValue({
				entries: [rawEntry(n1.id, "n1"), rawEntry(n2.id, "n2")],
				cacheHint: {},
			});

			const result = await runWithContext({ editMode: false, db }, () =>
				getEmDashCollection("note"),
			);

			expect(result.entries).toHaveLength(2);
			for (const entry of result.entries) {
				expect(readSeo(entry.data)).toBeUndefined();
			}
		});
	});
});
