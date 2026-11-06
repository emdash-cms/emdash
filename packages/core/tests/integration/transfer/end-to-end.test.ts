/**
 * Site transfer qualification: a representative origin site is exported,
 * copied file by file into a fresh target's import staging the way a client
 * uploads it, analyzed, planned with principal decisions, imported, and
 * verified with the real verifier. The target is then read back through the
 * public loader and helpers. Runs across source × target dialects, once with
 * default step budgets and once with a tiny query budget for every phase.
 */

import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { emdashLoader } from "../../../src/loader.js";
import { getMenuWithDb } from "../../../src/menus/index.js";
import { runWithContext } from "../../../src/request-context.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { expandCollectionBlockFields } from "../../../src/schema/block-values.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { defaultSeed } from "../../../src/seed/default.js";
import type { SeedFile } from "../../../src/seed/types.js";
import { getSiteSettingsWithDb } from "../../../src/settings/index.js";
import { finalizePlan } from "../../../src/transfer/analyze/step.js";
import { verifyImportStep } from "../../../src/transfer/export/verify.js";
import { inferredCreditId } from "../../../src/transfer/format/kinds.js";
import { verifyReceiptDigest } from "../../../src/transfer/format/receipt.js";
import { advanceImport, requestImportExecution } from "../../../src/transfer/import/index.js";
import { TransferStepBudget } from "../../../src/transfer/ops/budget.js";
import { stagingPrefix } from "../../../src/transfer/staging/keys.js";
import { StagedPackageReader } from "../../../src/transfer/staging/package.js";
import { readStreamBytes, TransferStage } from "../../../src/transfer/staging/stage.js";
import {
	hasPgTestDatabase,
	setupForDialect,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";
import {
	buildOriginSite,
	LITERAL_PLACEHOLDER_COMMENT,
	type OriginSite,
} from "../../utils/transfer/origin-site.js";
import {
	analyze,
	exportOrigin,
	phase,
	runImport,
	seedTarget,
	TARGET_BOB,
	uploadPackage,
} from "./pipeline.js";

const MEDIA_FILE_URL = /\/_emdash\/api\/media\/file\/([^"\\?#]+)/g;

/** The default seed plus a seeded block type, named by a seeded blocks field, whose slug the package reuses. */
const TARGET_SEED: SeedFile = {
	...defaultSeed,
	blockTypes: [
		{
			slug: "callout",
			label: "Seeded callout",
			currentVersion: 1,
			versions: [{ version: 1, fields: [{ slug: "note", label: "Note", type: "string" }] }],
		},
	],
	collections: defaultSeed.collections?.map((collection) =>
		collection.slug === "posts"
			? {
					...collection,
					fields: [
						...collection.fields,
						{
							slug: "blocks",
							label: "Blocks",
							type: "blocks",
							validation: { allowedTypes: ["callout"] },
						},
					],
				}
			: collection,
	),
};

/**
 * Just above the largest per-unit query estimate of any phase (analysis's
 * record-chunk unit, about 300), so every step does the least work a step
 * can do.
 */
const TINY_QUERY_CEILING = 330;

async function loadEntries(db: Kysely<Database>, type: string, locale?: string) {
	const loader = emdashLoader();
	const result = await runWithContext({ editMode: false, db }, () =>
		loader.loadCollection!({ filter: { type, locale } }),
	);
	if ("error" in result && result.error) throw result.error;
	return "entries" in result ? (result.entries ?? []) : [];
}

async function loadEntry(db: Kysely<Database>, type: string, id: string, locale?: string) {
	const loader = emdashLoader();
	const result = await runWithContext({ editMode: false, db }, () =>
		loader.loadEntry!({ filter: { type, id, locale } }),
	);
	if (result && "error" in result && result.error) throw result.error;
	return result && "data" in result ? result : undefined;
}

const DIALECT_PAIRS: Array<[DialectName, DialectName]> = [
	["sqlite", "sqlite"],
	...(hasPgTestDatabase
		? ([
				["sqlite", "postgres"],
				["postgres", "sqlite"],
				["postgres", "postgres"],
			] as Array<[DialectName, DialectName]>)
		: []),
];

for (const [sourceDialect, targetDialect] of DIALECT_PAIRS) {
	for (const ceiling of [null, TINY_QUERY_CEILING] as const) {
		const budgetLabel = ceiling === null ? "default budget" : `${ceiling}-query steps`;
		describe(`site transfer ${sourceDialect} → ${targetDialect} (${budgetLabel})`, () => {
			let source: DialectTestContext | undefined;
			let target: DialectTestContext | undefined;

			afterEach(async () => {
				setI18nConfig(null);
				await teardownForDialect(source);
				await teardownForDialect(target);
			});

			it("exports, imports, verifies, and serves the site", { timeout: 600_000 }, async () => {
				source = await setupForDialect(sourceDialect);
				target = await setupForDialect(targetDialect);
				const originStorage = createMemoryStorage();
				const targetStorage = createMemoryStorage();
				const site: OriginSite = await buildOriginSite(source.db, originStorage);
				const ids = site.ids;
				await seedTarget(target.db, TARGET_SEED);
				setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

				const exportPhase = phase(source.db, ceiling);
				const exported = await exportOrigin(exportPhase, originStorage);
				const operationId = await uploadPackage(target.db, targetStorage, exported);

				const analysisPhase = phase(target.db, ceiling);
				const analysis = await analyze(analysisPhase, targetStorage, operationId);
				expect(analysis.operation.state).toBe("planned");
				expect(analysis.plan?.blockers).toEqual([]);
				const bobPrincipal = analysis.plan?.principals.find((p) => p.id === ids.bob);
				expect(bobPrincipal?.suggestedUserId).toBe(TARGET_BOB);

				const { plan, planDigest } = await finalizePlan({
					db: target.db,
					storage: targetStorage,
					operationId,
					decisions: { principalMappings: { [ids.alice]: null, [ids.bob]: TARGET_BOB } },
				});
				await requestImportExecution({
					db: target.db,
					operationId,
					packageDigest: plan.packageDigest as `sha256:${string}`,
					planDigest,
				});

				const importPhase = phase(target.db, ceiling);
				const imported = await runImport(importPhase, targetStorage, operationId);
				const operation = imported.operation;
				expect(operation.errorDetail).toBeNull();
				expect(operation.state).toBe("complete");
				const receipt = operation.receipt!;
				expect(await verifyReceiptDigest(receipt)).toBe(true);
				expect(receipt).toMatchObject({
					operationId,
					packageDigest: plan.packageDigest,
					planDigest,
					originSiteId: (await exported.manifest()).originSiteId,
					verification: "verified",
				});
				if (ceiling !== null) {
					expect(exportPhase.steps).toBeGreaterThan(5);
					expect(analysisPhase.steps).toBeGreaterThan(2);
					expect(importPhase.steps).toBeGreaterThan(5);
				}

				const replay = await advanceImport({
					db: target.db,
					storage: targetStorage,
					operationId,
					verify: verifyImportStep,
				});
				expect(replay.operation.receipt).toEqual(receipt);
				let cursor: unknown = null;
				for (;;) {
					const step = await verifyImportStep({
						db: target.db,
						storage: targetStorage,
						operationId,
						reader: new StagedPackageReader(
							new TransferStage(
								targetStorage,
								stagingPrefix("import", operationId, operation.stagingSecret),
							),
						),
						plan,
						cursor,
						budget: new TransferStepBudget(),
					});
					if (!step.done) {
						cursor = step.cursor;
						continue;
					}
					expect(step.mismatches).toEqual([]);
					expect(step.logicalDigest).toBe(receipt.logicalDigest);
					break;
				}

				await expectPublicSite(target.db, targetStorage, site);
				await expectBlockTypes(target.db, source.db, targetStorage, site);
				await expectNoForbiddenStrings(target.db, site);
			});
		});
	}
}

async function expectPublicSite(
	db: Kysely<Database>,
	storage: MemoryStorage,
	site: OriginSite,
): Promise<void> {
	const { ids } = site;
	const keys = new Map(
		(await db.selectFrom("media").select(["id", "storage_key"]).execute()).map((row) => [
			row.id,
			row.storage_key,
		]),
	);
	for (const item of site.media) {
		if (item.status !== "ready") {
			expect(keys.has(item.id)).toBe(false);
			continue;
		}
		const key = keys.get(item.id)!;
		expect(key).not.toBe(item.storageKey);
		const download = await storage.download(key);
		expect(await readStreamBytes(download.body, 1024)).toEqual(item.bytes);
	}

	const enPosts = await loadEntries(db, "posts", "en");
	expect(enPosts.map((entry) => entry.data.id)).toEqual([ids.hello]);
	const frPosts = await loadEntries(db, "posts", "fr");
	expect(frPosts.map((entry) => entry.data.id)).toEqual([ids.bonjour]);
	expect(frPosts[0]?.data.translationGroup ?? frPosts[0]?.data.translation_group).toBeDefined();
	const pages = await loadEntries(db, "pages", "en");
	expect(pages.map((entry) => entry.data.id)).toEqual([ids.about]);

	const hello = await loadEntry(db, "posts", "hello-world", "en");
	expect(hello?.data.id).toBe(ids.hello);
	expect(hello?.data.title).toBe("Hello world");
	const helloJson = JSON.stringify(hello?.data);
	const heroKey = keys.get(ids.heroMedia)!;
	const inlineKey = keys.get(ids.inlineMedia)!;
	expect(helloJson).toContain(`/_emdash/api/media/file/${inlineKey}`);
	expect(helloJson).toContain(heroKey);
	expect(helloJson).not.toContain("emdash-media:");
	expect(helloJson).not.toContain("https://origin-site-url.example");
	for (const match of helloJson.matchAll(MEDIA_FILE_URL)) {
		expect([...keys.values()]).toContain(match[1]);
	}

	expect(await loadEntry(db, "posts", "old-news", "en")).toBeUndefined();
	const hidden = await sql<{ id: string; status: string; deleted_at: string | null }>`
		SELECT id, status, deleted_at FROM ec_posts WHERE id IN (${sql.join([
			ids.draftPost,
			ids.scheduledPost,
			ids.trashedPost,
		])})
	`.execute(db);
	expect(
		Object.fromEntries(hidden.rows.map((row) => [row.id, [row.status, row.deleted_at !== null]])),
	).toEqual({
		[ids.draftPost]: ["draft", false],
		[ids.scheduledPost]: ["scheduled", false],
		[ids.trashedPost]: ["published", true],
	});

	const taxonomies = new TaxonomyRepository(db);
	const helloTerms = await taxonomies.getTermsForEntry("posts", ids.hello, undefined, "en");
	expect(helloTerms.map((term) => term.slug).toSorted()).toEqual(["featured", "news"]);
	const frTerms = await taxonomies.getTermsForEntry("posts", ids.bonjour, "category", "fr");
	expect(frTerms.map((term) => term.slug)).toEqual(["actualites"]);
	const assigned = await db
		.selectFrom("content_taxonomies")
		.select(["entry_id", "taxonomy_id"])
		.orderBy("taxonomy_id")
		.execute();
	expect(assigned).toEqual(
		[
			{ entry_id: ids.hello, taxonomy_id: ids.newsEn },
			{ entry_id: ids.hello, taxonomy_id: ids.featuredTag },
			{ entry_id: ids.draftPost, taxonomy_id: ids.worldEn },
		].toSorted((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1)),
	);

	const { getEntryBylines } = await import("../../../src/bylines/index.js");
	const bylinesFor = (collection: string, entryId: string) =>
		runWithContext({ editMode: false, db }, () =>
			getEntryBylines(collection, entryId, { locale: "en" }),
		);
	expect((await bylinesFor("posts", ids.hello)).map((credit) => credit.byline.id)).toEqual([
		ids.aliceEn,
		ids.guest,
	]);
	const aboutCredits = await bylinesFor("pages", ids.about);
	expect(aboutCredits.map((credit) => [credit.byline.displayName, credit.source])).toEqual([
		["Alice Author", "explicit"],
	]);
	const materialized = await db
		.selectFrom("_emdash_content_bylines")
		.select("id")
		.where("id", "like", "inferred:%")
		.orderBy("id")
		.execute();
	expect(materialized.map((row) => row.id)).toEqual(
		[
			inferredCreditId("pages", ids.about),
			inferredCreditId("posts", ids.draftPost),
			inferredCreditId("posts", ids.trashedPost),
		].toSorted(),
	);
	const bonjourAuthor = await db
		.selectFrom("ec_posts" as "revisions")
		.select(sql<string>`author_id`.as("author_id"))
		.where("id", "=", ids.bonjour)
		.executeTakeFirstOrThrow();
	expect(bonjourAuthor.author_id).toBe(TARGET_BOB);

	const menu = await getMenuWithDb("primary", db, { locale: "en" });
	expect(menu?.items.map((item) => item.label)).toEqual(["Home", "About"]);
	expect(menu?.items[1]?.children?.map((item) => item.label)).toEqual(["Team"]);
	const widgets = await db
		.selectFrom("_emdash_widgets")
		.select(["type", "content"])
		.orderBy("sort_order")
		.execute();
	expect(widgets.map((widget) => widget.type)).toEqual(["content", "menu"]);
	expect(widgets[0]?.content).toContain(`/_emdash/api/media/file/${inlineKey}`);

	const pending = await db
		.selectFrom("_emdash_comments")
		.select(["body", "status"])
		.where("id", "=", ids.pendingComment)
		.executeTakeFirstOrThrow();
	expect(pending).toEqual({ body: LITERAL_PLACEHOLDER_COMMENT, status: "pending" });

	const settings = await getSiteSettingsWithDb(db, storage);
	expect(settings.title).toBe("Origin Site");
	expect(settings.tagline).toBe("Where it all began");
	expect(settings.logo?.mediaId).toBe(ids.logoMedia);
	expect(JSON.stringify(settings.logo)).toContain(keys.get(ids.logoMedia)!);
}

async function expectBlockTypes(
	db: Kysely<Database>,
	origin: Kysely<Database>,
	storage: MemoryStorage,
	site: OriginSite,
): Promise<void> {
	const blockTypes = await new BlockTypeRegistry(db).listBlockTypes();
	expect(blockTypes).toEqual(await new BlockTypeRegistry(origin).listBlockTypes());
	expect(blockTypes.map((type) => [type.slug, type.currentVersion, type.versions.length])).toEqual([
		["callout", 2, 2],
		["quote", 1, 1],
	]);

	const posts = await new SchemaRegistry(db).getCollectionWithFields("posts");
	const expanded = await expandCollectionBlockFields(db, posts!);
	const blocksField = expanded.fields.find((field) => field.slug === "blocks");
	expect(blocksField?.blockTypes?.map((type) => type.slug)).toEqual(["callout", "quote"]);

	const hello = await loadEntry(db, "posts", "hello-world", "en");
	const blocks: unknown = hello?.data.blocks;
	expect(blocks).toMatchObject([
		{ _type: "callout", _version: 2, _key: "c1", heading: "Read this first" },
		{ _type: "callout", _version: 1, _key: "c2", text: "An older callout" },
		{ _type: "quote", _version: 1, _key: "q1", quote: "Retired but kept" },
	]);
	const { storage_key: inlineKey } = await db
		.selectFrom("media")
		.select("storage_key")
		.where("id", "=", site.ids.inlineMedia)
		.executeTakeFirstOrThrow();
	expect(JSON.stringify(blocks)).toContain(`"storageKey":"${inlineKey}"`);
	expect(await storage.exists(inlineKey)).toBe(true);
}

async function expectNoForbiddenStrings(db: Kysely<Database>, site: OriginSite): Promise<void> {
	const options = await db.selectFrom("options").select(["name", "value"]).execute();
	const users = await db.selectFrom("users").selectAll().execute();
	const text = JSON.stringify({ options, users });
	for (const forbidden of site.forbidden) expect(text).not.toContain(forbidden);
	expect(users.map((user) => user.id)).toEqual([TARGET_BOB]);
}
