import { afterEach, beforeEach, expect, it } from "vitest";

import type { ExportPackageReader } from "../../../../src/transfer/export/exporter.js";
import {
	verifyImportStep,
	type VerifyImportStepResult,
} from "../../../../src/transfer/export/verify.js";
import {
	chunkLogicalSha256,
	logicalDigest,
	recordSha256,
} from "../../../../src/transfer/format/digest.js";
import { inferredCreditId, RECORD_KINDS } from "../../../../src/transfer/format/kinds.js";
import type { SiteImportPlan } from "../../../../src/transfer/format/plan.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
import { TransferIdentityMapRepository } from "../../../../src/transfer/ops/identity-map.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";
import { fixtureId } from "../../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../../utils/transfer/origin-site.js";
import { runExport } from "./helpers.js";

type Done = Extract<VerifyImportStepResult, { done: true }>;

describeEachDialect("import verification against the origin", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let site: OriginSite;
	let reader: ExportPackageReader;
	let operationId: string;
	let plan: SiteImportPlan;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		storage = createMemoryStorage();
		site = await buildOriginSite(ctx.db, storage);
		// Rows the exporter drops would count as unexpected target rows.
		await ctx.db.deleteFrom("media").where("id", "=", site.ids.pendingMedia).execute();
		await ctx.db
			.deleteFrom("content_taxonomies")
			.where("taxonomy_id", "=", fixtureId(1999))
			.execute();

		const run = await runExport(ctx.db, storage);
		expect(run.result.outcome).toBe("complete");
		reader = run.reader;
		operationId = run.result.operation.id;
		const manifest = await reader.manifest();
		plan = {
			formatVersion: "1",
			packageDigest: await reader.digest(),
			origin: {
				siteId: manifest.originSiteId,
				packageId: manifest.packageId,
				createdAt: manifest.createdAt,
				createdByEmDashVersion: manifest.createdByEmDashVersion,
			},
			target: { siteId: manifest.originSiteId, dialect, emdashVersion: "0.0.0-test" },
			counts: {},
			bytes: { records: 0, media: 0 },
			principals: [],
			settings: { title: {}, tagline: {} },
			decisions: {
				principalMappings: { [site.ids.alice]: site.ids.alice, [site.ids.bob]: site.ids.bob },
				siteTitle: "package",
				siteTagline: "package",
			},
			transformations: [],
			warnings: [],
			blockers: [],
			estimatedSteps: 0,
		};
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function verify(budget: () => TransferStepBudget = () => new TransferStepBudget()) {
		let cursor: unknown = null;
		let steps = 0;
		for (;;) {
			const result = await verifyImportStep({
				db: ctx.db,
				storage,
				operationId,
				reader,
				plan,
				cursor,
				budget: budget(),
			});
			steps++;
			if (result.done) return { result: result as Done, steps };
			cursor = JSON.parse(JSON.stringify(result.cursor));
			if (steps > 10_000) throw new Error("verification did not finish");
		}
	}

	it("verifies an unchanged origin against its own package", async () => {
		const { result } = await verify();
		expect(result.mismatches).toEqual([]);
		expect(result.counts).toMatchObject({
			entry: 6,
			media: 4,
			revision: 3,
			comment: 3,
			setting: 5,
		});

		const manifest = await reader.manifest();
		const chunks: Array<[string, number, string]> = [];
		for (const kind of RECORD_KINDS) {
			if (kind === "principal") continue;
			for (let seq = 0; seq < (manifest.records[kind]?.chunks ?? 0); seq++) {
				const hashes: Array<[string, string]> = [];
				for (const { record } of await reader.readChunk(kind, seq)) {
					hashes.push([record.id, await recordSha256(record)]);
				}
				chunks.push([kind, seq, await chunkLogicalSha256(hashes)]);
			}
		}
		expect(result.logicalDigest).toBe(await logicalDigest(chunks));
	});

	it("reaches the same digest in many small steps", async () => {
		const large = await verify();
		const small = await verify(() => new TransferStepBudget({ bytes: 1 }));
		expect(small.steps).toBeGreaterThan(20);
		expect(small.result).toEqual(large.result);
	});

	it("reports a changed row", async () => {
		await ctx.db
			.updateTable("ec_posts")
			.set({ title: "Tampered" })
			.where("id", "=", site.ids.hello)
			.execute();
		const { result } = await verify();
		expect(result.mismatches).toEqual([{ kind: "entry", id: site.ids.hello, reason: "different" }]);
		expect(result.counts.entry).toBe(5);
	});

	it("reports a missing row and the row count", async () => {
		await ctx.db.deleteFrom("_emdash_widgets").where("id", "=", fixtureId(1322)).execute();
		const { result } = await verify();
		expect(result.mismatches).toEqual([
			{ kind: "widget", id: fixtureId(1322), reason: "missing" },
			{ kind: "widget", id: "*", reason: "row_count expected=2 actual=1" },
		]);
	});

	it("reports an unexpected extra row", async () => {
		await ctx.db
			.insertInto("_emdash_widget_areas")
			.values({ id: fixtureId(7000), name: "footer", label: "Footer" })
			.execute();
		const { result } = await verify();
		expect(result.mismatches).toEqual([
			{ kind: "widget_area", id: "*", reason: "row_count expected=1 actual=2" },
		]);
	});

	it("reports a deleted media object", async () => {
		const logo = site.media.find((item) => item.id === site.ids.logoMedia)!;
		storage.files.delete(logo.storageKey);
		const { result } = await verify();
		expect(result.mismatches).toEqual([
			{ kind: "media", id: site.ids.logoMedia, reason: "blob_missing" },
		]);
	});

	it("reports a media object with one changed byte", async () => {
		const hero = site.media.find((item) => item.id === site.ids.heroMedia)!;
		const stored = storage.files.get(hero.storageKey)!;
		const bytes = new Uint8Array(stored.body);
		bytes[0] = (bytes[0] ?? 0) ^ 1;
		storage.files.set(hero.storageKey, { ...stored, body: bytes });
		const { result } = await verify();
		expect(result.mismatches).toEqual([
			{ kind: "media", id: site.ids.heroMedia, reason: "blob_mismatch" },
		]);
	});

	async function addInferredCredit(bylineId: string): Promise<string> {
		const id = inferredCreditId("posts", site.ids.draftPost);
		await ctx.db
			.insertInto("_emdash_content_bylines")
			.values({
				id,
				collection_slug: "posts",
				content_id: site.ids.draftPost,
				byline_id: bylineId,
				sort_order: 0,
				role_label: null,
			})
			.execute();
		return id;
	}

	it("accepts the inferred credits the importer recorded", async () => {
		const id = await addInferredCredit(site.ids.aliceEn);
		await new TransferIdentityMapRepository(ctx.db, plan.origin.siteId, operationId).put(
			"inferred_credit",
			{ portableId: id, targetId: site.ids.aliceEn },
		);
		const { result } = await verify(() => new TransferStepBudget({ bytes: 1 }));
		expect(result.mismatches).toEqual([]);
	});

	it("reports an inferred credit the importer did not record as an extra row", async () => {
		await addInferredCredit(site.ids.aliceEn);
		const { result } = await verify();
		expect(result.mismatches).toEqual([
			{ kind: "content_byline", id: "*", reason: "row_count expected=2 actual=3" },
		]);
	});

	it("reports an inferred credit that differs from the record", async () => {
		const id = await addInferredCredit(site.ids.guest);
		await new TransferIdentityMapRepository(ctx.db, plan.origin.siteId, operationId).put(
			"inferred_credit",
			{ portableId: id, targetId: site.ids.aliceEn },
		);
		const { result } = await verify();
		expect(result.mismatches).toEqual([
			{ kind: "content_byline", id, reason: "inferred_credit_different" },
		]);
	});

	it("bounds media re-hashing by the bytes streamed, not the size column", async () => {
		await ctx.db.updateTable("media").set({ size: 1 }).execute();
		const lying = await runExport(ctx.db, storage);
		reader = lying.reader;
		operationId = lying.result.operation.id;
		plan = { ...plan, packageDigest: await reader.digest() };
		const keys = new Set(site.media.map((item) => item.storageKey));
		const perStep: number[][] = [];
		let current: number[] = [];
		const download = storage.download.bind(storage);
		storage.download = async (key) => {
			const result = await download(key);
			if (!keys.has(key)) return result;
			let bytes = 0;
			const counted = result.body.pipeThrough(
				new TransformStream<Uint8Array, Uint8Array>({
					transform(chunk, controller) {
						bytes += chunk.byteLength;
						controller.enqueue(chunk);
					},
					flush() {
						current.push(bytes);
					},
				}),
			);
			return { ...result, body: counted };
		};
		let cursor: unknown = null;
		for (;;) {
			const result = await verifyImportStep({
				db: ctx.db,
				storage,
				operationId,
				reader,
				plan,
				cursor,
				budget: new TransferStepBudget({ bytes: 12 }),
			});
			perStep.push(current);
			current = [];
			if (result.done) {
				expect(result.mismatches).toEqual([]);
				break;
			}
			cursor = result.cursor;
		}
		const mediaSteps = perStep.filter((step) => step.length > 0);
		expect(mediaSteps.length).toBeGreaterThan(1);
		for (const step of mediaSteps) {
			const total = step.reduce((sum, bytes) => sum + bytes, 0);
			expect(step.length === 1 || total <= 12, JSON.stringify(step)).toBe(true);
		}
	});

	it("predicts principal mappings from the plan", async () => {
		plan = {
			...plan,
			decisions: { ...plan.decisions, principalMappings: { [site.ids.alice]: site.ids.alice } },
		};
		const { result } = await verify();
		// Bob is unmapped, so every row that names him differs from the prediction.
		expect(result.mismatches.length).toBeGreaterThan(0);
		expect(result.mismatches.every((mismatch) => mismatch.reason === "different")).toBe(true);
		expect(result.mismatches).toContainEqual({
			kind: "entry",
			id: site.ids.bonjour,
			reason: "different",
		});
	});
});
