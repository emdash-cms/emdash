/**
 * Integration tests for the WXR HTTP execute import flow.
 *
 * Covers two data-loss bug fixes:
 *
 *   - #1080: WPML / Polylang translations must each be inserted with their
 *     per-post locale and linked into the same `translation_group`. Before
 *     this fix the whole upload shared one locale and the second translation
 *     hit `UNIQUE(slug, locale)` and was dropped.
 *
 *   - #1061: per-post taxonomy assignments parsed from `<category>` /
 *     `<wp:term>` entries must end up in `taxonomies` and
 *     `content_taxonomies`. Before this fix they were parsed and silently
 *     discarded.
 *
 * `wxr-taxonomies.test.ts` covers the helper module in isolation. This file
 * exercises the wiring inside `execute.ts` -- per-post locale resolution,
 * translation linking, and the interaction between the taxonomy plan + the
 * per-post `attachPostTaxonomies` call.
 */

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { importContent } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import {
	mirrorTermsToLocales,
	preImportWxrTaxonomies,
} from "../../../src/import/wxr-taxonomies.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface Harness {
	db: Kysely<Database>;
	emdash: EmDashHandlers;
	manifest: EmDashManifest;
}

async function setup(): Promise<Harness> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);

	// A single content collection that supports the fields the WXR pipeline
	// emits. Two locales of the same content live as separate rows.
	await registry.createCollection({
		slug: "post",
		label: "Posts",
		labelSingular: "Post",
	});
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });
	await registry.createField("post", {
		slug: "content",
		label: "Content",
		type: "portableText",
	});
	await registry.createField("post", { slug: "excerpt", label: "Excerpt", type: "text" });

	// Update the seeded `category` and `tag` taxonomy defs to point at the
	// singular `post` collection. The migration 006 seed uses `["posts"]`
	// (plural) because that's the conventional EmDash collection slug, but
	// the test DB uses `post` so we widen the def to match.
	await db
		.updateTable("_emdash_taxonomy_defs")
		.set({ collections: JSON.stringify(["post"]) })
		.where("name", "in", ["category", "tag"])
		.execute();

	const runtime = createTestRuntime(db);
	const emdash = handlersFromRuntime(runtime);
	const manifest = await emdash.getManifest();
	return { db, emdash, manifest };
}

/**
 * Drive the same flow as the POST handler in `execute.ts` -- minus the
 * formdata parsing -- so the integration test exercises the real wiring
 * between `preImportWxrTaxonomies`, `mirrorTermsToLocales`, and
 * `importContent`.
 */
async function runImport(
	harness: Harness,
	wxrText: string,
	opts: { locale?: string; skipExisting?: boolean } = {},
) {
	const wxrData = await parseWxrString(wxrText);
	const plan = await preImportWxrTaxonomies(
		harness.db,
		wxrData.posts,
		wxrData.categories,
		wxrData.tags,
		wxrData.terms,
		opts.locale,
	);

	const postLocales = new Set<string>();
	for (const post of wxrData.posts) {
		if (post.locale) postLocales.add(post.locale);
	}
	if (postLocales.size > 0) {
		await mirrorTermsToLocales(harness.db, plan, postLocales, opts.locale);
	}

	const result = await importContent(
		wxrData.posts,
		{
			postTypeMappings: { post: { collection: "post", enabled: true } },
			skipExisting: opts.skipExisting ?? false,
		},
		harness.emdash,
		harness.manifest,
		new Map(),
		opts.locale,
		undefined,
		plan,
	);

	return { wxrData, plan, result };
}

describe("WXR import: WPML translations (#1080)", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await setup();
	});

	afterEach(async () => {
		await teardownTestDatabase(harness.db);
	});

	it("imports each translation under its own locale and links them via translation_group", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[42]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[42]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(2);

		const rows = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id", "slug", "locale", "translation_group"])
			.execute();
		expect(rows).toHaveLength(2);

		const enRow = rows.find((r) => r.locale === "en");
		const arRow = rows.find((r) => r.locale === "ar");
		expect(enRow).toBeDefined();
		expect(arRow).toBeDefined();
		expect(enRow?.slug).toBe("hello");
		expect(arRow?.slug).toBe("hello");

		// Both rows share a translation_group ULID. Without the fix the
		// second row was rejected outright by UNIQUE(slug, locale).
		expect(enRow?.translation_group).toBeDefined();
		expect(enRow?.translation_group).toBe(arRow?.translation_group);
	});

	it("links translations correctly when they arrive in non-canonical order", async () => {
		// Arabic first, English second. The anchor in the EmDash group ends
		// up being the Arabic row, but English still has to join the same
		// translation_group rather than starting a new one. Both rows
		// carry the same taxonomy assignment to verify the inherited /
		// own-attach logic doesn't depend on file order.
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
    </wp:category>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[42]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[42]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(2);

		const rows = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id", "locale", "translation_group"])
			.execute();
		expect(rows).toHaveLength(2);
		const enRow = rows.find((r) => r.locale === "en");
		const arRow = rows.find((r) => r.locale === "ar");
		expect(enRow?.translation_group).toBeDefined();
		expect(enRow?.translation_group).toBe(arRow?.translation_group);

		// Both rows resolve their `news` assignment in their own locale.
		// This is the substantive test of order independence: the per-
		// locale term lookup works regardless of which post arrived first.
		const repo = new TaxonomyRepository(harness.db);
		const enTerms = await repo.getTermsForEntry("post", enRow!.id, "category", "en");
		const arTerms = await repo.getTermsForEntry("post", arRow!.id, "category", "ar");
		expect(enTerms.map((t) => t.slug)).toEqual(["news"]);
		expect(arTerms.map((t) => t.slug)).toEqual(["news"]);
	});

	it("falls back to the upload-wide locale when a post has no WPML/Polylang metadata", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Mono</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>mono</wp:post_name>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "fr" });

		expect(result.imported).toBe(1);
		const rows = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["locale"])
			.execute();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.locale).toBe("fr");
	});

	it("mirrors terms into each translation's locale so per-locale lookups work", async () => {
		// Reproduces adversarial-review HIGH #3: a term created at the
		// upload-wide locale must also exist at every translation's locale
		// (sharing translation_group) for `getTermsForEntry(..., "ar")` to
		// return the assignment on an Arabic translation.
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[patents]]></wp:category_nicename>
      <wp:cat_name><![CDATA[Patents]]></wp:cat_name>
    </wp:category>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="patents"><![CDATA[Patents]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="patents"><![CDATA[Patents]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(2);

		const repo = new TaxonomyRepository(harness.db);

		// English row gets the term in English (the canonical row).
		const enRow = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.where("locale", "=", "en")
			.executeTakeFirstOrThrow();
		const enTerms = await repo.getTermsForEntry("post", enRow.id, "category", "en");
		expect(enTerms.map((t) => t.slug)).toContain("patents");

		// Arabic row resolves to the mirrored Arabic term row, NOT to the
		// English one. Without the mirror pass this would be an empty array.
		const arRow = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.where("locale", "=", "ar")
			.executeTakeFirstOrThrow();
		const arTerms = await repo.getTermsForEntry("post", arRow.id, "category", "ar");
		expect(arTerms).toHaveLength(1);
		expect(arTerms[0]?.slug).toBe("patents");
		expect(arTerms[0]?.locale).toBe("ar");
	});

	it("preserves inherited assignments for taxonomies the translation doesn't override", async () => {
		// Scenario: anchor has category=news AND tag=breaking. Translation
		// has its own category=events but no tags. The translation should
		// land with category=events (overridden) AND tag=breaking
		// (inherited). WPML "Translate Independently" is per-taxonomy --
		// not per-post -- so untouched taxonomies stay inherited.
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
    </wp:category>
    <wp:category>
      <wp:term_id>6</wp:term_id>
      <wp:category_nicename><![CDATA[events]]></wp:category_nicename>
      <wp:cat_name><![CDATA[Events]]></wp:cat_name>
    </wp:category>
    <wp:tag>
      <wp:term_id>100</wp:term_id>
      <wp:tag_slug><![CDATA[breaking]]></wp:tag_slug>
      <wp:tag_name><![CDATA[Breaking]]></wp:tag_name>
    </wp:tag>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <category domain="post_tag" nicename="breaking"><![CDATA[Breaking]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="events"><![CDATA[Events]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });
		expect(result.errors).toEqual([]);

		const repo = new TaxonomyRepository(harness.db);

		const arRow = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.where("locale", "=", "ar")
			.executeTakeFirstOrThrow();

		// Arabic category is the translation's override (`events`), NOT
		// the anchor's `news`.
		const arCategories = await repo.getTermsForEntry("post", arRow.id, "category", "ar");
		expect(arCategories.map((t) => t.slug)).toEqual(["events"]);

		// Arabic tag is INHERITED from the anchor (`breaking`). The
		// translation didn't carry any `<category domain="post_tag">`
		// elements, so its tag taxonomy stayed intact.
		const arTags = await repo.getTermsForEntry("post", arRow.id, "tag", "ar");
		expect(arTags.map((t) => t.slug)).toEqual(["breaking"]);
	});

	it("inherits anchor's full term set when translation has no per-item assignments", async () => {
		// Scenario A: anchor has category=news. Translation has no
		// <category> elements at all. The translation should inherit
		// the anchor's category via `copyEntryTerms`.
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
    </wp:category>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });
		expect(result.errors).toEqual([]);

		const repo = new TaxonomyRepository(harness.db);
		const arRow = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.where("locale", "=", "ar")
			.executeTakeFirstOrThrow();
		const arCategories = await repo.getTermsForEntry("post", arRow.id, "category", "ar");
		expect(arCategories.map((t) => t.slug)).toEqual(["news"]);
	});

	it("attaches different per-translation taxonomy assignments correctly", async () => {
		// WPML lets translators pick different categories per translation.
		// English gets `news`, Arabic gets `events`. The pivot stores both,
		// and per-locale lookups return the right thing for each row.
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
    </wp:category>
    <wp:category>
      <wp:term_id>6</wp:term_id>
      <wp:category_nicename><![CDATA[events]]></wp:category_nicename>
      <wp:cat_name><![CDATA[Events]]></wp:cat_name>
    </wp:category>
    <item>
      <title>Hello</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[en]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
    <item>
      <title>Mərhəba</title>
      <wp:post_id>2</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>hello</wp:post_name>
      <category domain="category" nicename="events"><![CDATA[Events]]></category>
      <wp:postmeta>
        <wp:meta_key>_icl_lang_code</wp:meta_key>
        <wp:meta_value><![CDATA[ar]]></wp:meta_value>
      </wp:postmeta>
      <wp:postmeta>
        <wp:meta_key>_icl_translation_id</wp:meta_key>
        <wp:meta_value><![CDATA[7]]></wp:meta_value>
      </wp:postmeta>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });
		expect(result.errors).toEqual([]);

		const repo = new TaxonomyRepository(harness.db);

		const enRow = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.where("locale", "=", "en")
			.executeTakeFirstOrThrow();
		const enTerms = await repo.getTermsForEntry("post", enRow.id, "category", "ar");
		const enTermSlugs = enTerms.map((t) => t.slug);

		const arRow = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.where("locale", "=", "ar")
			.executeTakeFirstOrThrow();
		const arTerms = await repo.getTermsForEntry("post", arRow.id, "category", "ar");
		const arTermSlugs = arTerms.map((t) => t.slug);

		// English row carries `news`; Arabic row carries `events`. Per-
		// translation assignments must NOT bleed across.
		expect(enTermSlugs).toContain("news");
		expect(enTermSlugs).not.toContain("events");
		expect(arTermSlugs).toContain("events");
		expect(arTermSlugs).not.toContain("news");
	});
});

describe("WXR import: taxonomy ingest (#1061)", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await setup();
	});

	afterEach(async () => {
		await teardownTestDatabase(harness.db);
	});

	it("creates taxonomy terms from <wp:category> / <wp:tag> defs and links per-post assignments", async () => {
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[patents]]></wp:category_nicename>
      <wp:cat_name><![CDATA[Patents]]></wp:cat_name>
    </wp:category>
    <wp:tag>
      <wp:term_id>497</wp:term_id>
      <wp:tag_slug><![CDATA[microwave]]></wp:tag_slug>
      <wp:tag_name><![CDATA[Microwave]]></wp:tag_name>
    </wp:tag>
    <item>
      <title>Filed Patent</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>filed-patent</wp:post_name>
      <category domain="category" nicename="patents"><![CDATA[Patents]]></category>
      <category domain="post_tag" nicename="microwave"><![CDATA[Microwave]]></category>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);

		const repo = new TaxonomyRepository(harness.db);
		const categories = await repo.findByName("category");
		const tags = await repo.findByName("tag");
		expect(categories.some((c) => c.slug === "patents")).toBe(true);
		expect(tags.some((t) => t.slug === "microwave")).toBe(true);

		const post = await harness.db
			.selectFrom("ec_post" as keyof Database)
			.select(["id"])
			.executeTakeFirst();
		expect(post).toBeDefined();
		const assigned = await repo.getTermsForEntry("post", post!.id);
		const assignedSlugs = assigned.map((t) => `${t.name}:${t.slug}`);
		expect(assignedSlugs).toContain("category:patents");
		expect(assignedSlugs).toContain("tag:microwave");
	});

	it("surfaces custom taxonomies in missingTaxonomies when no EmDash def exists", async () => {
		// The helper refuses to auto-create taxonomy defs -- the user
		// controls their schema through the admin. An unknown WP taxonomy
		// is reported but not synthesised.
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:term>
      <wp:term_id>10</wp:term_id>
      <wp:term_taxonomy>genre</wp:term_taxonomy>
      <wp:term_slug><![CDATA[sci-fi]]></wp:term_slug>
      <wp:term_name><![CDATA[Science Fiction]]></wp:term_name>
    </wp:term>
    <item>
      <title>Dune</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>dune</wp:post_name>
      <category domain="genre" nicename="sci-fi"><![CDATA[Science Fiction]]></category>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "en" });

		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		expect(result.taxonomies?.missingTaxonomies).toContain("genre");

		// No `genre` def materialises in the DB -- the user has to create
		// one through the admin first.
		const def = await harness.db
			.selectFrom("_emdash_taxonomy_defs")
			.select(["name"])
			.where("name", "=", "genre")
			.executeTakeFirst();
		expect(def).toBeUndefined();
	});

	it("strips Polylang's `language` customTaxonomy so it isn't attached as a content taxonomy", async () => {
		// Polylang stores the per-post locale as a `language` taxonomy
		// assignment. The parser promotes it to `post.locale`; the helper
		// must NOT also attach it as a content taxonomy (which would either
		// 404 on a missing `language` def or attach a stale signal).
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <item>
      <title>Bonjour</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>bonjour</wp:post_name>
      <category domain="language" nicename="fr"><![CDATA[Français]]></category>
    </item>
  </channel>
</rss>`;

		const { result } = await runImport(harness, wxr, { locale: "fr" });

		expect(result.errors).toEqual([]);
		expect(result.taxonomies?.missingTaxonomies ?? []).not.toContain("language");
		expect(result.taxonomies?.assignments).toBe(0);
	});

	it("reports newly-created and re-used terms separately in result.taxonomies", async () => {
		// First import seeds the `news` category. Second import on the same
		// DB re-uses it. The summary reflects this so the admin UI can
		// distinguish "we filled in your blanks" from "you already had it".
		const wxr = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel>
    <wp:category>
      <wp:term_id>5</wp:term_id>
      <wp:category_nicename><![CDATA[news]]></wp:category_nicename>
      <wp:cat_name><![CDATA[News]]></wp:cat_name>
    </wp:category>
    <item>
      <title>A</title>
      <wp:post_id>1</wp:post_id>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>a</wp:post_name>
      <category domain="category" nicename="news"><![CDATA[News]]></category>
    </item>
  </channel>
</rss>`;

		const { result: first } = await runImport(harness, wxr, { locale: "en" });
		expect(first.taxonomies?.termsCreated.category).toBe(1);
		expect(first.taxonomies?.termsReused.category ?? 0).toBe(0);

		// Second import (different post, same term).
		const second = await runImport(
			harness,
			wxr
				.replace("<wp:post_id>1</wp:post_id>", "<wp:post_id>2</wp:post_id>")
				.replace("<wp:post_name>a</wp:post_name>", "<wp:post_name>b</wp:post_name>"),
			{ locale: "en" },
		);
		expect(second.result.taxonomies?.termsCreated.category ?? 0).toBe(0);
		expect(second.result.taxonomies?.termsReused.category).toBe(1);
	});
});
