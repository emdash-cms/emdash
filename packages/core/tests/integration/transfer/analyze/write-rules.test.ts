import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySeed } from "../../../../src/seed/apply.js";
import { defaultSeed } from "../../../../src/seed/default.js";
import { analyzeImportStep } from "../../../../src/transfer/analyze/step.js";
import { analysisTargetContext } from "../../../../src/transfer/analyze/target.js";
import {
	compareIds,
	type BlockTypeRecord,
	type BlockTypeVersionRecord,
	type BylineFieldRecord,
	type BylineFieldValueRecord,
	type RedirectRecord,
	type SitePackageRecord,
} from "../../../../src/transfer/format/kinds.js";
import type { SiteImportPlan } from "../../../../src/transfer/format/plan.js";
import { TransferStepBudget } from "../../../../src/transfer/ops/budget.js";
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

describeEachDialect("site import analysis: values the site's write paths refuse", (dialect) => {
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

	async function planFor(options: StagePackageOptions): Promise<SiteImportPlan> {
		const staged = await stagePackage(ctx.db, storage, options);
		for (let steps = 1; steps < 10_000; steps++) {
			const result = await analyzeImportStep({
				db: ctx.db,
				storage,
				operationId: staged.operationId,
				budget: new TransferStepBudget(),
				targetContext: TARGET,
			});
			if (result.done) {
				if (!result.plan) throw new Error("no plan");
				return result.plan;
			}
		}
		throw new Error("analysis did not finish");
	}

	function withRedirects(...redirects: Array<Partial<RedirectRecord> & { id: string }>) {
		return {
			mutate: (records: Parameters<NonNullable<StagePackageOptions["mutate"]>>[0]) => {
				const base = records.redirect[0] as RedirectRecord;
				for (const redirect of redirects) {
					records.redirect.push({ ...base, groupName: SENTINEL, ...redirect });
				}
			},
		};
	}

	function update<T extends SitePackageRecord>(
		list: SitePackageRecord[],
		id: string,
		change: (record: T) => T,
	): void {
		const index = list.findIndex((record) => record.id === id);
		if (index === -1) throw new Error(`no record ${id}`);
		list[index] = change(list[index] as T);
	}

	function blockedIds(plan: SiteImportPlan, kind: string): string[] {
		return plan.blockers
			.filter((blocker) => blocker.code === "value_constraint_violation" && blocker.kind === kind)
			.map((blocker) => blocker.id ?? "")
			.toSorted();
	}

	describe("redirects", () => {
		it("blocks pattern redirects the redirects API would refuse, without echoing them", async () => {
			const plan = await planFor(
				withRedirects(
					{ id: `${ids.oldBlogRedirect}1`, source: `/[a][b]/${SENTINEL}`, isPattern: true },
					{ id: `${ids.oldBlogRedirect}2`, source: `/${SENTINEL}/(a|aa)`, isPattern: true },
					{
						id: `${ids.oldBlogRedirect}3`,
						source: `/${SENTINEL}/[slug]`,
						destination: "/new/[slug]",
						isPattern: false,
					},
					{
						id: `${ids.oldBlogRedirect}4`,
						source: `/${SENTINEL}/x/[slug]`,
						destination: "/new/[other]",
						isPattern: true,
					},
				),
			);
			expect(blockedIds(plan, "redirect")).toEqual([
				`${ids.oldBlogRedirect}1`,
				`${ids.oldBlogRedirect}2`,
				`${ids.oldBlogRedirect}3`,
				`${ids.oldBlogRedirect}4`,
			]);
			expect(plan.blockers.find((blocker) => blocker.kind === "redirect")?.detail).toMatchObject({
				path: "records/redirect/000000.ndjson",
			});
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("blocks redirects that leave the site or are not plain site paths", async () => {
			const redirect = (suffix: string, change: Partial<RedirectRecord>) => ({
				id: `${ids.oldBlogRedirect}${suffix}`,
				source: `/${SENTINEL}/${suffix}`,
				destination: "/fine",
				isPattern: false,
				...change,
			});
			const plan = await planFor(
				withRedirects(
					redirect("1", { destination: `https://${SENTINEL}.example/` }),
					redirect("2", { destination: `//${SENTINEL}.example/` }),
					redirect("3", { destination: `/${SENTINEL}\r\nSet-Cookie: x=1` }),
					redirect("4", { destination: `/${SENTINEL}/%2e%2e/admin` }),
					redirect("5", { source: `https://${SENTINEL}.example/` }),
					redirect("6", { destination: "" }),
					redirect("7", { type: 200 }),
					redirect("8", { type: 410, destination: "" }),
				),
			);
			expect(blockedIds(plan, "redirect")).toEqual(
				["1", "2", "3", "4", "5", "6", "7"].map((suffix) => `${ids.oldBlogRedirect}${suffix}`),
			);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("does not run an unvalidated pattern while looking for loops", async () => {
			const started = performance.now();
			const plan = await planFor(
				withRedirects(
					{
						id: `${ids.oldBlogRedirect}1`,
						source: "/start",
						destination: `/${"a".repeat(700)}`,
						isPattern: false,
					},
					{
						id: `${ids.oldBlogRedirect}2`,
						source: "/[p][q][r][s]z",
						destination: "/done",
						isPattern: true,
					},
				),
			);
			expect(performance.now() - started).toBeLessThan(3000);
			expect(blockedIds(plan, "redirect")).toEqual([`${ids.oldBlogRedirect}2`]);
		});
	});

	describe("byline field values", () => {
		type BylineFieldValue = BylineFieldValueRecord["value"];

		function withBylineFields(
			fields: Array<Pick<BylineFieldRecord, "type"> & Partial<BylineFieldRecord> & { id: string }>,
			values: Array<{ fieldId: string; value: unknown; group?: boolean }>,
		) {
			return {
				mutate: (records: Parameters<NonNullable<StagePackageOptions["mutate"]>>[0]) => {
					for (const field of fields) {
						records.byline_field.push({
							...(records.byline_field[0] as BylineFieldRecord),
							slug: `f_${field.id.slice(-2).toLowerCase()}`,
							...field,
						});
					}
					records.byline_field.sort((a, b) => compareIds(a.id, b.id));
					for (const { fieldId, value, group } of values) {
						if (group) {
							records.byline_field_group_value.push({
								kind: "byline_field_group_value",
								id: `${ids.aliceEn}:${fieldId}`,
								bylineGroup: ids.aliceEn,
								fieldId,
								value: value as BylineFieldValue,
							});
						} else {
							records.byline_field_value.push({
								kind: "byline_field_value",
								id: `${ids.aliceEn}:${fieldId}`,
								bylineId: ids.aliceEn,
								fieldId,
								value: value as BylineFieldValue,
							});
						}
					}
					records.byline_field_value.sort((a, b) => compareIds(a.id, b.id));
					records.byline_field_group_value.sort((a, b) => compareIds(a.id, b.id));
				},
			};
		}

		const selectField = `${ids.bylineTwitter}s`;
		const booleanField = `${ids.bylineTwitter}b`;
		const stringField = `${ids.bylineTwitter}t`;

		it("blocks values the byline field write path would refuse, without echoing them", async () => {
			const plan = await planFor(
				withBylineFields(
					[
						{ id: selectField, type: "select", validation: { options: ["red", "blue"] } },
						{ id: booleanField, type: "boolean" },
						{ id: stringField, type: "text" },
					],
					[
						{ fieldId: selectField, value: `green-${SENTINEL}` },
						{ fieldId: booleanField, value: `yes-${SENTINEL}`, group: true },
						{ fieldId: stringField, value: 42 },
					],
				),
			);
			const blocked = plan.blockers
				.filter((blocker) => blocker.code === "value_constraint_violation")
				.map((blocker) => [blocker.kind, blocker.id, blocker.detail?.property]);
			expect(blocked).toEqual(
				expect.arrayContaining([
					["byline_field_value", `${ids.aliceEn}:${selectField}`, "value"],
					["byline_field_group_value", `${ids.aliceEn}:${booleanField}`, "value"],
					["byline_field_value", `${ids.aliceEn}:${stringField}`, "value"],
				]),
			);
			expect(blocked).toHaveLength(3);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("accepts values the byline field write path accepts", async () => {
			const plan = await planFor(
				withBylineFields(
					[
						{ id: selectField, type: "select", validation: { options: ["red", "blue"] } },
						{ id: booleanField, type: "boolean" },
						{ id: stringField, type: "string" },
					],
					[
						{ fieldId: selectField, value: "blue" },
						{ fieldId: booleanField, value: false, group: true },
						{ fieldId: stringField, value: "" },
					],
				),
			);
			expect(plan.blockers).toEqual([]);
		});

		it("blocks a byline field type the site does not know", async () => {
			const plan = await planFor(withBylineFields([{ id: selectField, type: "colour" }], []));
			expect(plan.blockers).toEqual([
				expect.objectContaining({
					code: "field_type_unknown",
					kind: "byline_field",
					id: selectField,
				}),
			]);
		});

		it("blocks a select field with more choices than a site supports", async () => {
			const options = Array.from({ length: 201 }, (_, index) => `choice-${index}`);
			const plan = await planFor(
				withBylineFields([{ id: selectField, type: "select", validation: { options } }], []),
			);
			expect(plan.blockers).toEqual([
				expect.objectContaining({
					code: "value_constraint_violation",
					kind: "byline_field",
					id: selectField,
				}),
			]);
		});
	});

	describe("block types", () => {
		function withBlockTypes(
			types: Array<Partial<BlockTypeRecord> & { id: string; slug: string }>,
			versions: Array<Partial<BlockTypeVersionRecord> & { id: string; blockTypeId: string }>,
		) {
			return {
				mutate: (records: Parameters<NonNullable<StagePackageOptions["mutate"]>>[0]) => {
					for (const type of types) {
						records.block_type.push({
							...(records.block_type[0] as BlockTypeRecord),
							currentVersion: 1,
							...type,
						});
					}
					for (const version of versions) {
						records.block_type_version.push({
							...(records.block_type_version[0] as BlockTypeVersionRecord),
							version: 1,
							...version,
						});
					}
					records.block_type.sort((a, b) => compareIds(a.id, b.id));
					records.block_type_version.sort((a, b) => compareIds(a.id, b.id));
				},
			};
		}

		const typeId = (suffix: string) => `${ids.calloutBlock}${suffix}`;
		const versionId = (suffix: string) => `${ids.calloutV1}${suffix}`;

		it("blocks block types and versions the block type registry would refuse", async () => {
			const plan = await planFor(
				withBlockTypes(
					[
						{ id: typeId("r"), slug: "status" },
						{ id: typeId("l"), slug: "blank_label", label: " " },
						{ id: typeId("s"), slug: "themed", source: SENTINEL },
						{ id: typeId("f"), slug: "bad_fields" },
						{ id: typeId("z"), slug: "version_zero", currentVersion: 0 },
					],
					[
						{ id: versionId("r"), blockTypeId: typeId("r") },
						{ id: versionId("l"), blockTypeId: typeId("l") },
						{ id: versionId("s"), blockTypeId: typeId("s") },
						{
							id: versionId("f"),
							blockTypeId: typeId("f"),
							fields: [{ slug: "colour", label: SENTINEL, type: "colour" }],
						},
						{ id: versionId("z"), blockTypeId: typeId("z"), version: 0 },
					],
				),
			);
			const blocked = plan.blockers
				.filter((blocker) => blocker.code === "value_constraint_violation")
				.map((blocker) => [blocker.kind, blocker.id, blocker.detail?.property]);
			expect(blocked).toEqual(
				expect.arrayContaining([
					["block_type", typeId("r"), "slug"],
					["block_type", typeId("l"), "label"],
					["block_type", typeId("s"), "source"],
					["block_type_version", versionId("f"), "fields"],
					["block_type_version", versionId("z"), "version"],
				]),
			);
			expect(blocked).toHaveLength(5);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("blocks a blocks field or a current version that names nothing in the package", async () => {
			const plan = await planFor({
				mutate: (records) => {
					update(records.field, ids.postBlocks, (field) => ({
						...field,
						validation: { allowedTypes: ["callout", "missing"], retiredTypes: ["quote"] },
					}));
					update(records.block_type, ids.quoteBlock, (type) => ({
						...type,
						currentVersion: 2,
					}));
				},
			});
			expect(
				plan.blockers.map((blocker) => [
					blocker.code,
					blocker.kind,
					blocker.id,
					blocker.detail?.property,
				]),
			).toEqual(
				expect.arrayContaining([
					["dangling_reference", "field", ids.postBlocks, "validation"],
					["dangling_reference", "block_type", ids.quoteBlock, "currentVersion"],
				]),
			);
			expect(plan.blockers).toHaveLength(2);
		});

		it("blocks a repeated block type slug or version", async () => {
			const plan = await planFor(
				withBlockTypes(
					[{ id: typeId("d"), slug: "callout" }],
					[
						{ id: versionId("d"), blockTypeId: typeId("d") },
						{ id: versionId("v"), blockTypeId: ids.calloutBlock, version: 2 },
					],
				),
			);
			expect(
				plan.blockers
					.filter((blocker) => blocker.code === "unique_violation")
					.map((blocker) => [blocker.kind, blocker.detail?.constraint]),
			).toEqual([
				["block_type", "block_type_slug"],
				["block_type_version", "block_type_version"],
			]);
		});

		it("accepts every block type and version in the golden package", async () => {
			const plan = await planFor({});
			expect(plan.blockers).toEqual([]);
			expect(plan.counts).toMatchObject({ block_type: 2, block_type_version: 3 });
		});
	});

	describe("URLs and URL patterns", () => {
		it("blocks URLs and URL patterns the admin API would refuse, without echoing them", async () => {
			const urlField = `${ids.bylineTwitter}u`;
			const plan = await planFor({
				mutate: (records) => {
					update(records.byline, ids.aliceEn, (byline) => ({
						...byline,
						websiteUrl: `javascript:alert("${SENTINEL}")`,
					}));
					records.byline_field.push({
						...(records.byline_field[0] as BylineFieldRecord),
						id: urlField,
						slug: "homepage",
						type: "url",
					});
					records.byline_field.sort((a, b) => compareIds(a.id, b.id));
					records.byline_field_value.push({
						kind: "byline_field_value",
						id: `${ids.aliceEn}:${urlField}`,
						bylineId: ids.aliceEn,
						fieldId: urlField,
						value: `data:text/html,${SENTINEL}`,
					});
					records.byline_field_value.sort((a, b) => compareIds(a.id, b.id));
					records.byline_field_group_value.push({
						kind: "byline_field_group_value",
						id: `${ids.aliceEn}:${urlField}`,
						bylineGroup: ids.aliceEn,
						fieldId: urlField,
						value: `javascript:${SENTINEL}`,
					});
					records.byline_field_group_value.sort((a, b) => compareIds(a.id, b.id));
					update(records.menu_item, ids.teamItem, (item) => ({
						...item,
						customUrl: ` javascript:alert("${SENTINEL}")`,
					}));
					update(records.collection, ids.posts, (collection) => ({
						...collection,
						urlPattern: `/blog/{slug}/${SENTINEL}}`,
					}));
					update(records.seo, `posts:${ids.hello}`, (seo) => ({
						...seo,
						seoCanonical: `javascript:alert("${SENTINEL}")`,
					}));
				},
			});
			const blocked = plan.blockers
				.filter((blocker) => blocker.code === "value_constraint_violation")
				.map((blocker) => [blocker.kind, blocker.id, blocker.detail?.property]);
			expect(blocked).toEqual(
				expect.arrayContaining([
					["collection", ids.posts, "urlPattern"],
					["byline", ids.aliceEn, "websiteUrl"],
					["byline_field_value", `${ids.aliceEn}:${urlField}`, "value"],
					["byline_field_group_value", `${ids.aliceEn}:${urlField}`, "value"],
					["seo", `posts:${ids.hello}`, "seoCanonical"],
					["menu_item", ids.teamItem, "customUrl"],
				]),
			);
			expect(blocked).toHaveLength(6);
			expect(JSON.stringify(plan)).not.toContain(SENTINEL);
		});

		it("accepts the URL shapes the admin API and renderer accept", async () => {
			const urlField = `${ids.bylineTwitter}u`;
			const plan = await planFor({
				mutate: (records) => {
					records.byline_field.push({
						...(records.byline_field[0] as BylineFieldRecord),
						id: urlField,
						slug: "homepage",
						type: "url",
					});
					records.byline_field.sort((a, b) => compareIds(a.id, b.id));
					records.byline_field_value.push({
						kind: "byline_field_value",
						id: `${ids.aliceEn}:${urlField}`,
						bylineId: ids.aliceEn,
						fieldId: urlField,
						value: "",
					});
					records.byline_field_value.sort((a, b) => compareIds(a.id, b.id));
					update(records.menu_item, ids.teamItem, (item) => ({
						...item,
						customUrl: "mailto:team@example.com",
					}));
				},
			});
			expect(plan.blockers).toEqual([]);
		});
	});
});
