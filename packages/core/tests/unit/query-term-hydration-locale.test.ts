/**
 * Locale-aware taxonomy term hydration in the public query helpers (#1441).
 *
 * `getEmDashEntry` / `getEmDashCollection` resolve the content row to a locale
 * (explicit option > request context > defaultLocale). Term hydration must use
 * that same resolved locale, otherwise a `fr-fr` entry can come back with the
 * default-locale variants of its taxonomy terms.
 *
 * The bug was that `hydrateEntryTerms()` called `getAllTermsForEntries(type, ids)`
 * with no locale, so term lookup fell back to the request-context / default
 * locale instead of the entry's own locale.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import type { Database } from "../../src/database/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

interface TermFixture {
	enContentId: string;
	frContentId: string;
	frContentSlug: string;
	enTagId: string;
	frTagId: string;
}

/**
 * Seed an EN + FR post (same translation group) and a tag with EN + FR
 * variants, attached to both posts by translation_group.
 */
async function seedLocalizedTags(db: Kysely<Database>): Promise<TermFixture> {
	const contentRepo = new ContentRepository(db);
	const taxRepo = new TaxonomyRepository(db);

	// Two post rows sharing a translation group.
	const enContent = await contentRepo.create({
		type: "post",
		slug: "hello",
		data: { title: "Hello" },
		locale: "en",
	});
	const frContent = await contentRepo.create({
		type: "post",
		slug: "bonjour",
		data: { title: "Bonjour" },
		locale: "fr",
		translationOf: enContent.id,
	});

	// One tag with EN + FR variants (shared translation_group).
	const enTag = await taxRepo.create({ name: "tags", slug: "news", label: "News", locale: "en" });
	const frTag = await taxRepo.create({
		name: "tags",
		slug: "actualites",
		label: "Actualités",
		locale: "fr",
		translationOf: enTag.id,
	});

	// Attach the tag (by group) to both entries.
	await taxRepo.attachToEntry("post", enContent.id, enTag.id);
	await taxRepo.attachToEntry("post", frContent.id, enTag.id);

	return {
		enContentId: enContent.id,
		frContentId: frContent.id,
		frContentSlug: frContent.slug,
		enTagId: enTag.id,
		frTagId: frTag.id,
	};
}

describe("query helpers hydrate terms in the resolved locale (#1441)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		setI18nConfig(null);
		vi.mocked(getLiveCollection).mockReset();
		vi.mocked(getLiveEntry).mockReset();
	});

	it("getEmDashEntry returns the FR term variant for an explicit fr locale", async () => {
		const fx = await seedLocalizedTags(db);

		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: {
				id: fx.frContentSlug,
				data: { id: fx.frContentId, title: "Bonjour", status: "published", locale: "fr" },
			},
			error: undefined,
			cacheHint: {},
		} as any);

		const { entry } = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", fx.frContentSlug, { locale: "fr" }),
		);

		const tags = (entry?.data as any)?.terms?.tags as Array<{ id: string; locale: string }>;
		expect(tags).toHaveLength(1);
		expect(tags[0]!.id).toBe(fx.frTagId);
		expect(tags[0]!.locale).toBe("fr");
	});

	it("getEmDashCollection returns the FR term variant for an explicit fr locale", async () => {
		const fx = await seedLocalizedTags(db);

		vi.mocked(getLiveCollection).mockResolvedValue({
			entries: [
				{
					id: fx.frContentSlug,
					data: { id: fx.frContentId, title: "Bonjour", status: "published", locale: "fr" },
				},
			],
			error: undefined,
			cacheHint: {},
		} as any);

		const { entries } = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { locale: "fr" }),
		);

		const tags = (entries[0]?.data as any)?.terms?.tags as Array<{ id: string; locale: string }>;
		expect(tags).toHaveLength(1);
		expect(tags[0]!.id).toBe(fx.frTagId);
		expect(tags[0]!.locale).toBe("fr");
	});
});
