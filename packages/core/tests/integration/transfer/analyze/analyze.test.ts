import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SchemaRegistry } from "../../../../src/schema/registry.js";
import { applySeed } from "../../../../src/seed/apply.js";
import { defaultSeed } from "../../../../src/seed/default.js";
import {
	analyzeImportStep,
	finalizePlan,
	loadImportPlan,
	type AnalyzeImportStepResult,
} from "../../../../src/transfer/analyze/step.js";
import { analysisTargetContext } from "../../../../src/transfer/analyze/target.js";
import { validateStagedPackage } from "../../../../src/transfer/analyze/validate.js";
import { isTransferError } from "../../../../src/transfer/errors.js";
import { planDigest } from "../../../../src/transfer/format/digest.js";
import type {
	BylineRecord,
	EntryRecord,
	MenuRecord,
	PrincipalRecord,
	SitePackageRecord,
	TermRecord,
} from "../../../../src/transfer/format/kinds.js";
import type { SiteImportPlan } from "../../../../src/transfer/format/plan.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { TransferOperationRepository } from "../../../../src/transfer/ops/operations.js";
import { TransferPackageIndexRepository } from "../../../../src/transfer/ops/package-index.js";
import { StagedPackageReader } from "../../../../src/transfer/staging/package.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { GOLDEN_IDS } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { SENTINEL, stagePackage, type StagePackageOptions } from "./fixture.js";

const ids = GOLDEN_IDS;
const TARGET = analysisTargetContext({
	i18n: { defaultLocale: "en", locales: ["en", "FR"] },
	maxUploadSize: 50 * 1024 * 1024,
	emdashVersion: "0.0.0-test",
});

function codes(list: ReadonlyArray<{ code: string }>): string[] {
	return [...new Set(list.map((item) => item.code))].toSorted();
}

function replace<T extends SitePackageRecord>(
	list: SitePackageRecord[],
	id: string,
	change: (record: T) => SitePackageRecord,
): void {
	const index = list.findIndex((record) => record.id === id);
	if (index === -1) throw new Error(`no record ${id}`);
	list[index] = change(list[index] as T);
}

describeEachDialect("site import analysis", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await applySeed(ctx.db, defaultSeed, { includeContent: false, onConflict: "skip" });
		storage = createMemoryStorage();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function analyze(
		operationId: string,
		options: { budget?: () => TransferStepBudget; target?: typeof TARGET } = {},
	): Promise<AnalyzeImportStepResult & { steps: number }> {
		for (let steps = 1; steps < 10_000; steps++) {
			const result = await analyzeImportStep({
				db: ctx.db,
				storage,
				operationId,
				budget: options.budget?.() ?? new TransferStepBudget(),
				targetContext: options.target ?? TARGET,
			});
			if (result.done) return { ...result, steps };
		}
		throw new Error("analysis did not finish");
	}

	async function planFor(
		options: StagePackageOptions = {},
		target: typeof TARGET = TARGET,
	): Promise<SiteImportPlan> {
		const staged = await stagePackage(ctx.db, storage, options);
		const result = await analyze(staged.operationId, { target });
		if (!result.plan) throw new Error("no plan");
		return result.plan;
	}

	async function addUser(id: string, email: string): Promise<void> {
		await ctx.db
			.insertInto("users")
			.values({
				id,
				email,
				name: null,
				avatar_url: null,
				role: 50,
				email_verified: 1,
				data: null,
			})
			.execute();
	}

	describe("golden package", () => {
		it("analyzes cleanly into a freshly set-up site", async () => {
			await addUser("target_alice", "Alice@Example.COM");
			const staged = await stagePackage(ctx.db, storage);
			const result = await analyze(staged.operationId);
			const plan = result.plan!;

			expect(plan.blockers).toEqual([]);
			expect(result.operation.state).toBe("planned");
			expect(result.operation.planDigest).toBe(result.planDigest);
			expect(result.planDigest).toBe(await planDigest(plan));
			expect(await loadImportPlan(storage, result.operation)).toEqual(plan);

			const expectedCounts = Object.fromEntries(
				Object.entries(staged.manifest.records).map(([kind, summary]) => [kind, summary.count]),
			);
			expect(plan.counts).toEqual(expectedCounts);
			expect(plan.origin).toMatchObject({
				siteId: ids.originSiteId,
				packageId: ids.packageId,
			});
			expect(plan.target.dialect).toBe(dialect);

			expect(plan.principals).toEqual([
				{
					id: ids.alice,
					displayName: "Alice Author",
					email: "alice@example.com",
					references: 8,
					suggestedUserId: "target_alice",
				},
				{ id: ids.bob, displayName: "Bob", references: 5 },
			]);
			expect(plan.decisions).toEqual({
				principalMappings: { [ids.alice]: "target_alice", [ids.bob]: null },
				siteTitle: "package",
				siteTagline: "package",
			});
			expect(plan.settings.title.package).toBe("Golden Site");
			expect(plan.settings.tagline.package).toBe("A package for tests");

			const transformations = new Map(plan.transformations.map((t) => [t.code, t]));
			const scaffold = transformations.get("seeded_scaffold_removed");
			expect(scaffold?.code === "seeded_scaffold_removed" && scaffold.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "collection" }),
					expect.objectContaining({ type: "taxonomy_def" }),
				]),
			);
			expect(transformations.get("principal_mapped")).toEqual({
				code: "principal_mapped",
				count: 8,
			});
			expect(transformations.get("principal_unmapped")).toEqual({
				code: "principal_unmapped",
				count: 5,
			});
			if (dialect === "postgres") {
				expect(transformations.get("search_unsupported")).toEqual({
					code: "search_unsupported",
					kind: "collection",
					ids: [ids.posts],
				});
			} else {
				expect(transformations.has("search_unsupported")).toBe(false);
			}
			expect(transformations.has("redirect_loop_disabled")).toBe(false);
			expect(plan.warnings).toEqual([]);

			const index = new TransferPackageIndexRepository(ctx.db, staged.operationId);
			expect(await index.get("entry", ids.bonjour)).toMatchObject({ groupId: ids.hello });
			expect(await index.get("collection", ids.posts)).toMatchObject({ nameKey: "posts" });
			expect(await index.get("term", ids.worldEn)).toMatchObject({
				depth: 1,
				parentId: ids.newsEn,
			});
			expect(await index.get("comment", ids.nestedReply)).toMatchObject({ depth: 2 });
		});

		it("produces the same plan digest when run in many tiny steps", async () => {
			const first = await stagePackage(ctx.db, storage, { chunkRecords: 2 });
			const whole = await analyze(first.operationId);
			await new TransferOperationRepository(ctx.db).requestCancel(first.operationId);

			const second = await stagePackage(ctx.db, storage, { chunkRecords: 2 });
			const stepped = await analyze(second.operationId, {
				budget: () => new TransferStepBudget({ bytes: 1 }),
			});
			expect(whole.steps).toBe(1);
			expect(stepped.steps).toBeGreaterThan(40);
			expect(stepped.plan?.blockers).toEqual([]);
			expect(stepped.planDigest).toBe(whole.planDigest);
		});

		it("resumes after a step fails midway without changing the plan", async () => {
			const first = await stagePackage(ctx.db, storage, { chunkRecords: 2 });
			const whole = await analyze(first.operationId);
			await new TransferOperationRepository(ctx.db).requestCancel(first.operationId);

			const second = await stagePackage(ctx.db, storage, { chunkRecords: 2 });
			let stateWrites = 0;
			storage.beforeUpload = (key) => {
				if (key.includes("/_analysis/state-") && ++stateWrites % 7 === 0) {
					throw new Error("storage unavailable");
				}
			};
			let failures = 0;
			let result: AnalyzeImportStepResult | null = null;
			for (let step = 0; step < 10_000 && !result?.done; step++) {
				try {
					result = await analyzeImportStep({
						db: ctx.db,
						storage,
						operationId: second.operationId,
						budget: new TransferStepBudget({ bytes: 1 }),
						targetContext: TARGET,
					});
				} catch {
					failures++;
				}
			}
			expect(failures).toBeGreaterThan(3);
			expect(result?.plan?.blockers).toEqual([]);
			expect(result?.planDigest).toBe(whole.planDigest);
		});

		it("returns the stored plan once planned", async () => {
			const staged = await stagePackage(ctx.db, storage);
			const first = await analyze(staged.operationId);
			const again = await analyze(staged.operationId);
			expect(again.steps).toBe(1);
			expect(again.planDigest).toBe(first.planDigest);
		});

		it("honors a cancel requested while the last step stores the plan", async () => {
			const staged = await stagePackage(ctx.db, storage);
			const operations = new TransferOperationRepository(ctx.db);
			const upload = storage.upload.bind(storage);
			storage.upload = async (options) => {
				if (options.key.endsWith("/_plan.json")) {
					const flagged = await operations.requestCancel(staged.operationId);
					expect(flagged.state).not.toBe("cancelled");
				}
				return upload(options);
			};
			const result = await analyze(staged.operationId);
			expect(result.operation.state).toBe("cancelled");
			expect(result.operation.leaseToken).toBeNull();
			expect(result.plan).toBeNull();
			expect((await operations.require(staged.operationId)).state).toBe("cancelled");
		});

		it("disables redirects that form a loop", async () => {
			const plan = await planFor({
				mutate: (records) => {
					const base = records.redirect[0]!;
					records.redirect.push(
						{
							...base,
							id: `${ids.oldBlogRedirect}a`,
							source: "/a",
							destination: "/b",
							isPattern: false,
						},
						{
							...base,
							id: `${ids.oldBlogRedirect}b`,
							source: "/b",
							destination: "/a",
							isPattern: false,
						},
					);
				},
			});
			expect(plan.blockers).toEqual([]);
			expect(plan.transformations).toContainEqual({
				code: "redirect_loop_disabled",
				kind: "redirect",
				ids: [`${ids.oldBlogRedirect}a`, `${ids.oldBlogRedirect}b`],
			});
		});
	});

	describe("the standalone validator", () => {
		it("validates the golden package with the exporter's hook shape", async () => {
			const staged = await stagePackage(ctx.db, storage, { chunkRecords: 3 });
			const result = await validateStagedPackage({
				db: ctx.db,
				reader: new StagedPackageReader(staged.stage),
				operationId: staged.operationId,
				budget: () => new TransferStepBudget({ bytes: 1 }),
			});
			expect(result.done).toBe(true);
			expect(result.blockers).toEqual([]);
			expect(result.warnings).toEqual([]);
		});
	});

	describe("package problems", () => {
		it("blocks a record that fails its schema without echoing its values", async () => {
			const plan = await planFor({
				lines: {
					entry: (lines) =>
						lines.map((line, index) =>
							index === 0
								? line.replace('"kind":"entry"', `"kind":"entry","${SENTINEL}":"${SENTINEL}"`)
								: line,
						),
				},
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "record_invalid",
					kind: "entry",
					detail: { path: "records/entry/000000.ndjson", line: 1 },
				}),
			);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("blocks a line that is not canonical JSON without echoing it", async () => {
			const plan = await planFor({
				lines: { entry: (lines) => [`{"kind": "entry", "x": "${SENTINEL}"`, ...lines.slice(1)] },
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "record_invalid",
					message: "Record is not canonical JSON",
				}),
			);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("blocks an oversized record line", async () => {
			const plan = await planFor({
				mutate: (records) =>
					replace(records.entry, ids.draftPost, (entry) => ({
						...entry,
						fields: { title: SENTINEL.repeat(Math.ceil(1_950_000 / SENTINEL.length)) },
					})),
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "limit_exceeded", kind: "entry" }),
			);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("blocks a staged chunk whose bytes do not match its digest", async () => {
			const staged = await stagePackage(ctx.db, storage);
			const key = staged.stage.keyFor("records/term/000000.ndjson");
			const file = storage.files.get(key)!;
			const tampered = new Uint8Array(file.body);
			tampered[10] = tampered[10] === 0x41 ? 0x42 : 0x41;
			storage.files.set(key, { ...file, body: tampered });
			const result = await analyze(staged.operationId);
			expect(result.plan?.blockers).toContainEqual(
				expect.objectContaining({
					code: "file_mismatch",
					detail: { path: "records/term/000000.ndjson" },
				}),
			);
		});

		it("blocks a declared file that was never uploaded", async () => {
			const plan = await planFor({ notUploaded: ["records/menu/000000.ndjson"] });
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "file_missing",
					detail: { path: "records/menu/000000.ndjson" },
				}),
			);
		});

		it("blocks a media record whose blob is not in the package", async () => {
			const plan = await planFor({ omitBlobs: [ids.inlineMedia] });
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "media_blob_missing", kind: "media", id: ids.inlineMedia }),
			);
		});

		it("blocks a Portable Text image whose media record is absent", async () => {
			const plan = await planFor({
				mutate: (records) => {
					records.media = records.media.filter((record) => record.id !== ids.inlineMedia);
				},
				omitBlobs: [ids.inlineMedia],
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "media_ref_invalid", kind: "entry", id: ids.hello }),
			);
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "media_ref_invalid", kind: "widget", id: ids.promoWidget }),
			);
		});

		it("accepts escaped placeholder text", async () => {
			const escaped = await planFor({
				mutate: (records) =>
					replace<EntryRecord>(records.entry, ids.draftPost, (entry) => ({
						...entry,
						fields: { ...entry.fields, title: "emdash-media::x and emdash-media:::" },
					})),
			});
			expect(escaped.blockers).toEqual([]);
		});

		it("blocks placeholder text that is neither a placeholder nor an escape", async () => {
			const malformed = await planFor({
				mutate: (records) =>
					replace<EntryRecord>(records.entry, ids.draftPost, (entry) => ({
						...entry,
						fields: { ...entry.fields, title: `${SENTINEL} emdash-media:` },
					})),
			});
			expect(malformed.blockers).toEqual([
				expect.objectContaining({ code: "media_ref_invalid", kind: "entry", id: ids.draftPost }),
			]);
			expect(JSON.stringify(malformed)).not.toContain(SENTINEL);
		});

		it("blocks a dangling hard reference without echoing the missing value", async () => {
			const plan = await planFor({
				mutate: (records) =>
					replace(records.entry, ids.draftPost, (entry) => ({
						...entry,
						authorPrincipal: SENTINEL,
					})),
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "dangling_reference",
					kind: "entry",
					id: ids.draftPost,
					detail: expect.objectContaining({ property: "authorPrincipal" }),
				}),
			);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("warns about a dangling soft reference", async () => {
			const plan = await planFor({
				mutate: (records) =>
					replace(records.content_term, `posts:${ids.hello}:${ids.featuredTag}`, (term) => ({
						...term,
						id: `posts:${ids.hello}:missing_term`,
						termGroup: "missing_term",
					})),
			});
			expect(plan.blockers).toEqual([]);
			expect(plan.warnings).toContainEqual(
				expect.objectContaining({
					code: "soft_reference_dangling",
					kind: "content_term",
					detail: expect.objectContaining({ property: "termGroup" }),
				}),
			);
		});

		it("warns about media from external providers", async () => {
			const plan = await planFor({
				mutate: (records) =>
					replace<EntryRecord>(records.entry, ids.draftPost, (entry) => ({
						...entry,
						fields: {
							...entry.fields,
							metadata: { cover: { provider: "cloudinary", id: `x/${SENTINEL}` } },
						},
					})),
			});
			expect(plan.blockers).toEqual([]);
			expect(plan.warnings).toContainEqual(
				expect.objectContaining({
					code: "media_provider_external",
					count: 1,
					detail: { provider: "cloudinary" },
				}),
			);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("blocks a package that requires an unknown feature", async () => {
			const plan = await planFor({
				manifest: (manifest) => ({
					...manifest,
					features: [...manifest.features, "zeppelins"].toSorted(),
					requiredFeatures: [...manifest.requiredFeatures, "zeppelins"].toSorted(),
				}),
			});
			expect(codes(plan.blockers)).toEqual(["unsupported_feature"]);
			expect(plan.origin.packageId).toBe(ids.packageId);
		});

		it("blocks an index entry with an invalid path", async () => {
			const plan = await planFor({
				index: (entries) => [
					...entries,
					{ path: "records/../../etc/passwd", bytes: 1, sha256: "0".repeat(64), records: 1 },
				],
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "package_invalid",
					detail: { path: "index/000000.ndjson" },
				}),
			);
		});

		it("blocks staged files the index does not list", async () => {
			const staged = await stagePackage(ctx.db, storage);
			await ctx.db
				.insertInto("_emdash_transfer_staged_files")
				.values({
					operation_id: staged.operationId,
					path: `media/${"a".repeat(64)}`,
					bytes: 3,
					sha256: "a".repeat(64),
					state: "verified",
					verified_at: null,
					logical_sha256: null,
				})
				.execute();
			const result = await analyze(staged.operationId);
			expect(result.plan?.blockers).toContainEqual(
				expect.objectContaining({
					code: "package_invalid",
					message: "Staged files are not listed in the package index",
					count: 1,
				}),
			);
		});

		it("blocks records out of stream order", async () => {
			const plan = await planFor({ lines: { entry: (lines) => lines.toReversed() } });
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "record_order_invalid", kind: "entry" }),
			);
		});

		it("blocks a tree whose child appears before its parent", async () => {
			const plan = await planFor({
				mutate: (records) => {
					replace(records.term, ids.newsEn, (term) => ({ ...term, parentId: ids.worldEn }));
				},
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "record_order_invalid",
					kind: "term",
					id: ids.newsEn,
				}),
			);
		});

		it("blocks a record that is its own parent", async () => {
			const plan = await planFor({
				mutate: (records) => {
					replace(records.comment, ids.rootComment, (comment) => ({
						...comment,
						parentId: ids.rootComment,
					}));
				},
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "reference_cycle", kind: "comment", id: ids.rootComment }),
			);
		});

		it("blocks a record count that does not match the manifest", async () => {
			const plan = await planFor({
				manifest: (manifest) => ({
					...manifest,
					records: { ...manifest.records, menu: { count: 3, chunks: 1 } },
				}),
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({ code: "record_count_mismatch", kind: "menu" }),
			);
		});
	});

	describe("target problems", () => {
		it("blocks a site that already has user content", async () => {
			await new SchemaRegistry(ctx.db).createCollection({ slug: "products", label: "Products" });
			const plan = await planFor();
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "target_not_empty",
					detail: { reason: "collection_not_seeded", collection: "products" },
				}),
			);
		});

		it("blocks a leftover content table for a package collection", async () => {
			const pages = await ctx.db
				.selectFrom("_emdash_collections")
				.select("id")
				.where("slug", "=", "pages")
				.executeTakeFirstOrThrow();
			await ctx.db.deleteFrom("_emdash_fields").where("collection_id", "=", pages.id).execute();
			await ctx.db.deleteFrom("_emdash_collections").where("id", "=", pages.id).execute();
			await sql`CREATE TABLE ec_legacy (id TEXT PRIMARY KEY, deleted_at TEXT)`.execute(ctx.db);
			const plan = await planFor();
			expect(plan.blockers).toEqual([
				expect.objectContaining({
					code: "target_not_empty",
					detail: { reason: "orphaned_table", table: "ec_pages" },
				}),
			]);
		});

		it("blocks a package locale the site is not configured for", async () => {
			const plan = await planFor(
				{},
				analysisTargetContext({ i18n: { defaultLocale: "en", locales: ["en"] } }),
			);
			expect(plan.blockers).toEqual([
				expect.objectContaining({ code: "locale_not_configured", detail: { locale: "fr" } }),
			]);
		});

		it("blocks media larger than the site accepts", async () => {
			const plan = await planFor({}, { ...TARGET, maxUploadSize: 30 });
			expect(codes(plan.blockers)).toEqual(["media_blob_too_large"]);
		});

		it("checks integer ranges and column types against the target dialect", async () => {
			const plan = await planFor({
				mutate: (records) => {
					replace(records.entry, ids.draftPost, (entry) => ({
						...entry,
						version: 3_000_000_000,
					}));
					replace(records.entry, ids.scheduledPost, (entry) => ({
						...entry,
						fields: { title: 42 as unknown as string },
					}));
				},
			});
			expect(plan.blockers).toContainEqual(
				expect.objectContaining({
					code: "value_constraint_violation",
					id: ids.scheduledPost,
					detail: expect.objectContaining({ field: "title" }),
				}),
			);
			const overflow = expect.objectContaining({
				code: "integer_out_of_range",
				id: ids.draftPost,
				detail: expect.objectContaining({ property: "version" }),
			});
			if (dialect === "postgres") expect(plan.blockers).toContainEqual(overflow);
			else expect(plan.blockers).not.toContainEqual(overflow);
		});

		it("declares float4 rounding on Postgres", async () => {
			const plan = await planFor({
				mutate: (records) =>
					replace(records.entry, ids.bonjour, (entry) => ({
						...entry,
						fields: { ...(entry as { fields: Record<string, unknown> }).fields, rating: 0.1 },
					})),
			});
			const rounded = plan.transformations.find((t) => t.code === "float4_rounded");
			if (dialect === "postgres") expect(rounded).toEqual({ code: "float4_rounded", count: 1 });
			else expect(rounded).toBeUndefined();
		});
	});

	describe("target unique constraints", () => {
		const cases: Array<{
			name: string;
			constraint: string;
			kind: string;
			id: string;
			mutate: (records: Record<string, SitePackageRecord[]>) => void;
		}> = [
			{
				name: "entry slug per collection and locale",
				constraint: "entry_slug_locale",
				kind: "entry",
				id: ids.scheduledPost,
				mutate: (records) =>
					replace<EntryRecord>(records.entry!, ids.scheduledPost, (entry) => ({
						...entry,
						slug: "hello-world",
					})),
			},
			{
				name: "active translation of a group per locale (case-insensitive)",
				constraint: "entry_active_group_locale",
				kind: "entry",
				id: ids.scheduledPost,
				mutate: (records) =>
					replace<EntryRecord>(records.entry!, ids.scheduledPost, (entry) => ({
						...entry,
						translationGroup: ids.hello,
						locale: "FR",
					})),
			},
			{
				name: "term name, slug, and locale",
				constraint: "term_name_slug_locale",
				kind: "term",
				id: ids.worldEn,
				mutate: (records) =>
					replace<TermRecord>(records.term!, ids.worldEn, (term) => ({ ...term, slug: "news" })),
			},
			{
				name: "menu name and locale",
				constraint: "menu_name_locale",
				kind: "menu",
				id: ids.primaryFr,
				mutate: (records) =>
					replace<MenuRecord>(records.menu!, ids.primaryFr, (menu) => ({
						...menu,
						locale: "en",
						translationGroup: ids.primaryFr,
					})),
			},
			{
				name: "byline slug and locale",
				constraint: "byline_slug_locale",
				kind: "byline",
				id: ids.guest,
				mutate: (records) =>
					replace<BylineRecord>(records.byline!, ids.guest, (byline) => ({
						...byline,
						slug: "alice",
					})),
			},
			{
				name: "content reference groups",
				constraint: "content_reference_groups",
				kind: "content_reference",
				id: `${ids.relatedRef}b`,
				mutate: (records) =>
					records.content_reference!.push({
						...records.content_reference![0]!,
						id: `${ids.relatedRef}b`,
					}),
			},
			{
				name: "widget area name",
				constraint: "widget_area_name",
				kind: "widget_area",
				id: `${ids.sidebar}b`,
				mutate: (records) =>
					records.widget_area!.push({ ...records.widget_area![0]!, id: `${ids.sidebar}b` }),
			},
		];

		for (const testCase of cases) {
			it(`blocks duplicates of ${testCase.name}`, async () => {
				const plan = await planFor({ mutate: testCase.mutate, chunkRecords: 1 });
				expect(plan.blockers).toContainEqual(
					expect.objectContaining({
						code: "unique_violation",
						kind: testCase.kind,
						id: testCase.id,
						detail: expect.objectContaining({ constraint: testCase.constraint }),
					}),
				);
			});
		}

		it("lets trashed translations share a group and locale", async () => {
			const plan = await planFor({
				mutate: (records) =>
					replace<EntryRecord>(records.entry, ids.trashedPost, (entry) => ({
						...entry,
						translationGroup: ids.hello,
					})),
			});
			expect(plan.blockers).toEqual([]);
		});
	});

	describe("principals and decisions", () => {
		function withBobByline(records: Record<string, SitePackageRecord[]>): void {
			replace(records.byline!, ids.guest, (byline) => ({ ...byline, userPrincipal: ids.bob }));
		}

		it("blocks two principals with same-locale bylines mapped to one user", async () => {
			await addUser("target_alice", "alice@example.com");
			const staged = await stagePackage(ctx.db, storage, { mutate: withBobByline });
			const analyzed = await analyze(staged.operationId);
			expect(analyzed.plan?.blockers).toEqual([]);

			const { plan, planDigest: digest } = await finalizePlan({
				db: ctx.db,
				storage,
				operationId: staged.operationId,
				decisions: { principalMappings: { [ids.bob]: "target_alice" } },
			});
			expect(plan.decisions.principalMappings).toEqual({
				[ids.alice]: "target_alice",
				[ids.bob]: "target_alice",
			});
			expect(plan.blockers).toEqual([
				expect.objectContaining({
					code: "principal_conflict",
					id: ids.bob,
					detail: { principal: ids.alice, user: "target_alice" },
				}),
			]);
			expect(digest).not.toBe(analyzed.planDigest);
			const operation = await new TransferOperationRepository(ctx.db).require(staged.operationId);
			expect(operation.planDigest).toBe(digest);

			const cleared = await finalizePlan({
				db: ctx.db,
				storage,
				operationId: staged.operationId,
				decisions: { principalMappings: { [ids.bob]: null }, siteTitle: "target" },
			});
			expect(cleared.plan.blockers).toEqual([]);
			expect(cleared.plan.decisions.siteTitle).toBe("target");
			expect(cleared.planDigest).not.toBe(analyzed.planDigest);

			const defaults = await finalizePlan({
				db: ctx.db,
				storage,
				operationId: staged.operationId,
				decisions: {},
			});
			expect(defaults.planDigest).toBe(analyzed.planDigest);
		});

		it("blocks mapping a principal that has two bylines in one locale", async () => {
			await addUser("target_alice", "alice@example.com");
			const staged = await stagePackage(ctx.db, storage, {
				mutate: (records) =>
					replace<BylineRecord>(records.byline, ids.guest, (byline) => ({
						...byline,
						userPrincipal: ids.alice,
					})),
			});
			const analyzed = await analyze(staged.operationId);
			expect(analyzed.plan?.blockers).toEqual([
				expect.objectContaining({
					code: "principal_conflict",
					id: ids.alice,
					detail: { user: "target_alice" },
				}),
			]);
			const unmapped = await finalizePlan({
				db: ctx.db,
				storage,
				operationId: staged.operationId,
				decisions: { principalMappings: { [ids.alice]: null } },
			});
			expect(unmapped.plan.blockers).toEqual([]);
		});

		it("matches principal emails case-insensitively beyond ASCII", async () => {
			await addUser("target_emile", "ÉMILE@Example.com");
			const plan = await planFor({
				mutate: (records) =>
					replace<PrincipalRecord>(records.principal, ids.bob, (principal) => ({
						...principal,
						email: "émile@example.com",
					})),
			});
			expect(plan.principals.find((principal) => principal.id === ids.bob)?.suggestedUserId).toBe(
				"target_emile",
			);
		});

		it("rejects decisions naming unknown principals or users", async () => {
			const staged = await stagePackage(ctx.db, storage);
			await analyze(staged.operationId);
			const codeOf = async (decisions: unknown) => {
				try {
					await finalizePlan({ db: ctx.db, storage, operationId: staged.operationId, decisions });
					return null;
				} catch (error) {
					return isTransferError(error) ? error.code : "other";
				}
			};
			expect(await codeOf({ principalMappings: { nobody: null } })).toBe(
				"TRANSFER_DECISIONS_INVALID",
			);
			expect(await codeOf({ principalMappings: { [ids.bob]: "no_such_user" } })).toBe(
				"TRANSFER_DECISIONS_INVALID",
			);
			expect(await codeOf({ siteTitle: "neither" })).toBe("TRANSFER_DECISIONS_INVALID");
		});
	});
});
