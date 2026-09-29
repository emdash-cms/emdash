import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { BylineRepository } from "../../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../../src/database/repositories/revision.js";
import { TaxonomyRepository } from "../../../../src/database/repositories/taxonomy.js";
import { getMenuWithDb } from "../../../../src/menus/index.js";
import { fingerprintBlockFields } from "../../../../src/schema/block-type-contract.js";
import { BlockTypeRegistry } from "../../../../src/schema/block-type-registry.js";
import type { BlockFieldDefinition } from "../../../../src/schema/block-types.js";
import { expandCollectionBlockFields } from "../../../../src/schema/block-values.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { verifyImportStep } from "../../../../src/transfer/export/verify.js";
import { inferredCreditId } from "../../../../src/transfer/format/kinds.js";
import { verifyReceiptDigest } from "../../../../src/transfer/format/receipt.js";
import { advanceImport, INFERRED_CREDIT_ENTITY } from "../../../../src/transfer/import/index.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { GOLDEN_IDS, GOLDEN_MEDIA_BYTES } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { expectTargetMatchesGolden, mediaKeys } from "./expectations.js";
import { driveImport, seedTarget, stageGoldenImport, TARGET_USER, verifyOk } from "./harness.js";

const ids = GOLDEN_IDS;

describeEachDialect("site import of the golden package", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		await seedTarget(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("writes every record verbatim and completes with a sealed receipt", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const results = await driveImport(ctx.db, storage, staged.operationId);
		const operation = results.at(-1)!.operation;

		expect(operation.errorDetail).toBeNull();
		expect(operation.state).toBe("complete");
		expect(operation.errorCode).toBeNull();
		expect(operation.receipt).not.toBeNull();
		expect(await verifyReceiptDigest(operation.receipt!)).toBe(true);
		expect(operation.receipt).toMatchObject({
			operationId: staged.operationId,
			packageDigest: staged.packageDigest,
			planDigest: staged.planDigest,
			originSiteId: ids.originSiteId,
			verification: "verified",
		});

		const inferred = await expectTargetMatchesGolden(ctx.db, staged.golden, staged.plan);
		expect(inferred.map((row) => String(row.id)).toSorted()).toEqual(
			[
				inferredCreditId("pages", ids.about),
				inferredCreditId("posts", ids.draftPost),
				inferredCreditId("posts", ids.trashedPost),
			].toSorted(),
		);
		for (const credit of inferred) {
			expect(credit).toMatchObject({ bylineGroup: ids.aliceEn, sortOrder: 0 });
		}
		const declared = await ctx.db
			.selectFrom("_emdash_transfer_identity_map")
			.select(["portable_id", "target_id"])
			.where("operation_id", "=", staged.operationId)
			.where("entity_kind", "=", INFERRED_CREDIT_ENTITY)
			.execute();
		expect(declared.map((row) => row.portable_id).toSorted()).toEqual(
			inferred.map((row) => String(row.id)).toSorted(),
		);
	});

	it("passes the real verifier", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const results = await driveImport(ctx.db, storage, staged.operationId, {
			verify: verifyImportStep,
		});
		const operation = results.at(-1)!.operation;
		expect(operation.errorDetail).toBeNull();
		expect(operation.state).toBe("complete");
	});

	it("removes the seeded scaffold and leaves foreign keys valid", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		await driveImport(ctx.db, storage, staged.operationId);

		const collections = await ctx.db.selectFrom("_emdash_collections").select("id").execute();
		expect(collections.map((row) => row.id).toSorted()).toEqual([ids.posts, ids.pages].toSorted());
		const defs = await ctx.db.selectFrom("_emdash_taxonomy_defs").select("id").execute();
		expect(defs.map((row) => row.id).toSorted()).toEqual(
			[ids.categoryEn, ids.categoryFr, ids.tagEn].toSorted(),
		);
		if (dialect === "sqlite") {
			const violations = await sql`PRAGMA foreign_key_check`.execute(ctx.db);
			expect(violations.rows).toEqual([]);
		}
	});

	it("writes block types the registry reads, with fingerprints derived from their fields", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		await driveImport(ctx.db, storage, staged.operationId);

		const blockTypes = await new BlockTypeRegistry(ctx.db).listBlockTypes();
		expect(blockTypes.map((type) => [type.id, type.slug, type.currentVersion])).toEqual([
			[ids.calloutBlock, "callout", 2],
			[ids.quoteBlock, "quote", 1],
		]);
		for (const record of staged.golden.records.block_type_version) {
			if (record.kind !== "block_type_version") continue;
			const stored = blockTypes
				.flatMap((type) => type.versions)
				.find((version) => version.id === record.id);
			expect(stored?.fingerprint).toBe(
				await fingerprintBlockFields(record.fields as unknown as BlockFieldDefinition[]),
			);
		}

		const posts = await new SchemaRegistry(ctx.db).getCollectionWithFields("posts");
		const expanded = await expandCollectionBlockFields(ctx.db, posts!);
		expect(
			expanded.fields.find((field) => field.slug === "blocks")?.blockTypes?.map((t) => t.slug),
		).toEqual(["callout", "quote"]);
	});

	it("serves imported content through the normal repositories", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		await driveImport(ctx.db, storage, staged.operationId);
		const keys = await mediaKeys(ctx.db);
		const heroKey = keys.get(ids.heroMedia)!;

		const content = new ContentRepository(ctx.db);
		const hello = await content.findBySlug("posts", "hello-world", "en");
		expect(hello).toMatchObject({
			id: ids.hello,
			status: "published",
			authorId: null,
			liveRevisionId: ids.helloLive,
			draftRevisionId: ids.helloDraft,
			translationGroup: ids.hello,
		});
		const translations = await content.findTranslations("posts", ids.hello);
		expect(translations.map((item) => item.id).toSorted()).toEqual(
			[ids.hello, ids.bonjour].toSorted(),
		);
		const bonjour = translations.find((item) => item.id === ids.bonjour);
		expect(bonjour?.authorId).toBe(TARGET_USER);

		const live = await new RevisionRepository(ctx.db).findById(ids.helloLive);
		expect(JSON.stringify(live?.data)).toContain(`/_emdash/api/media/file/${heroKey}`);
		expect(JSON.stringify(live?.data)).not.toContain("emdash-media:");
		expect(hello?.data.featured_image).toBeDefined();

		const terms = await new TaxonomyRepository(ctx.db).getTermsForEntry(
			"posts",
			ids.hello,
			undefined,
			"en",
		);
		expect(terms.map((term) => term.slug).toSorted()).toEqual(["featured", "news"]);
		const frTerms = await new TaxonomyRepository(ctx.db).getTermsForEntry(
			"posts",
			ids.bonjour,
			"category",
			"fr",
		);
		expect(frTerms.map((term) => term.slug)).toEqual(["actualites"]);

		const bylines = new BylineRepository(ctx.db);
		const helloCredits = await bylines.getContentBylines("posts", ids.hello, { locale: "en" });
		expect(helloCredits.map((credit) => credit.byline.id)).toEqual([ids.aliceEn, ids.guest]);
		const draftCredits = await bylines.getContentBylines("posts", ids.draftPost, { locale: "en" });
		expect(draftCredits.map((credit) => credit.byline.displayName)).toEqual(["Alice Author"]);

		const menu = await getMenuWithDb("primary", ctx.db, { locale: "en" });
		expect(menu?.items.map((item) => item.label)).toEqual(["Home", "About"]);
		expect(menu?.items[1]?.children?.map((item) => item.label)).toEqual(["Team"]);

		const widgets = await ctx.db
			.selectFrom("_emdash_widgets")
			.select(["id", "content"])
			.where("area_id", "=", ids.sidebar)
			.orderBy("sort_order")
			.execute();
		expect(widgets.map((widget) => widget.id)).toEqual([ids.promoWidget, ids.menuWidget]);
		expect(widgets[0]?.content).toContain(keys.get(ids.inlineMedia)!);

		const title = await ctx.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", "site:title")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(title.value)).toBe("Golden Site");
		const pronouns = await ctx.db
			.selectFrom("_emdash_byline_field_values")
			.select("value")
			.where("byline_id", "=", ids.aliceEn)
			.executeTakeFirstOrThrow();
		expect(JSON.parse(pronouns.value ?? "null")).toBe("she/her");

		for (const [mediaId, bytes] of Object.entries(GOLDEN_MEDIA_BYTES)) {
			const key = keys.get(mediaId)!;
			expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.[a-z]+$/);
			const download = await storage.download(key);
			expect(new Uint8Array(await new Response(download.body).arrayBuffer())).toEqual(bytes);
		}
		expect(keys.get(ids.heroMedia)).not.toBe(keys.get(ids.avatarMedia));
		const hero = await ctx.db
			.selectFrom("media")
			.select(["status", "content_hash"])
			.where("id", "=", ids.heroMedia)
			.executeTakeFirstOrThrow();
		expect(hero.status).toBe("ready");
		expect(hero.content_hash).toMatch(/^sha1:[0-9a-f]{40}$/);
		const attempts = await ctx.db.selectFrom("_emdash_media_upload_attempts").selectAll().execute();
		expect(attempts).toEqual([]);
	});

	it("builds the search index on SQLite and declares it unsupported on Postgres", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		await driveImport(ctx.db, storage, staged.operationId);
		const row = await ctx.db
			.selectFrom("_emdash_collections")
			.select("search_config")
			.where("id", "=", ids.posts)
			.executeTakeFirstOrThrow();
		const config = JSON.parse(row.search_config ?? "null");
		if (dialect === "sqlite") {
			expect(config).toEqual({ enabled: true, weights: { title: 10 } });
			const hits = await sql<{ id: string }>`
				SELECT id FROM _emdash_fts_posts WHERE _emdash_fts_posts MATCH ${"hello"}
			`.execute(ctx.db);
			expect(hits.rows.map((hit) => hit.id)).toContain(ids.hello);
			const trashed = await sql<{ id: string }>`
				SELECT id FROM _emdash_fts_posts WHERE id = ${ids.trashedPost}
			`.execute(ctx.db);
			expect(trashed.rows).toEqual([]);
		} else {
			expect(config).toEqual({ enabled: false, weights: { title: 10 } });
		}
	});

	it("keeps the target title when the plan decides so", async () => {
		await ctx.db
			.insertInto("options")
			.values({ name: "site:title", value: JSON.stringify("Target Title"), revision: "r1" })
			.onConflict((conflict) =>
				conflict.column("name").doUpdateSet({ value: JSON.stringify("Target Title") }),
			)
			.execute();
		const staged = await stageGoldenImport(ctx.db, storage, dialect, { siteTitle: "target" });
		await driveImport(ctx.db, storage, staged.operationId);
		const values = await ctx.db
			.selectFrom("options")
			.select(["name", "value"])
			.where("name", "in", ["site:title", "emdash:site_title", "site:tagline"])
			.execute();
		const byName = Object.fromEntries(values.map((row) => [row.name, JSON.parse(row.value)]));
		expect(byName["site:title"]).toBe("Target Title");
		expect(byName["emdash:site_title"]).toBeUndefined();
		expect(byName["site:tagline"]).toBe("A package for tests");
	});

	it("treats advancing a completed import as a no-op that returns the same receipt", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const first = (await driveImport(ctx.db, storage, staged.operationId)).at(-1)!;
		const again = await advanceImport({
			db: ctx.db,
			storage,
			operationId: staged.operationId,
			verify: verifyOk,
		});
		expect(again.nextRequestInMs).toBeNull();
		expect(again.operation.state).toBe("complete");
		expect(again.operation.receipt).toEqual(first.operation.receipt);
	});

	it("fails with the mismatches and no receipt when verification disagrees", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const results = await driveImport(ctx.db, storage, staged.operationId, {
			verify: async () => ({
				done: true,
				logicalDigest: `sha256:${"0".repeat(64)}`,
				counts: {},
				mismatches: [{ kind: "entry", id: ids.hello, reason: "hash" }],
			}),
		});
		const operation = results.at(-1)!.operation;
		expect(operation.state).toBe("failed");
		expect(operation.errorCode).toBe("TRANSFER_VERIFICATION_FAILED");
		expect(operation.errorDetail).toMatchObject({
			mismatches: 1,
			mismatch_0: `entry:${ids.hello}:hash`,
		});
		expect(operation.receipt).toBeNull();
	});

	it("resumes a verifier that needs several steps", async () => {
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const seen: unknown[] = [];
		const results = await driveImport(ctx.db, storage, staged.operationId, {
			verify: async (input) => {
				seen.push(input.cursor);
				if (input.cursor === null) return { done: false, cursor: { phase: 1 } };
				return verifyOk(input);
			},
		});
		expect(seen).toEqual([null, { phase: 1 }]);
		expect(results.at(-1)!.operation.state).toBe("complete");
	});
});
