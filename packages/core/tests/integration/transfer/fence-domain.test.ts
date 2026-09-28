import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { createContentAccessWithWrite } from "../../../src/plugins/context.js";
import { BlockTypeRegistry } from "../../../src/schema/block-type-registry.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import { inspectPortableDomain } from "../../../src/transfer/domain.js";
import {
	assertSiteWriteAllowed,
	checkSiteWriteFence,
	findSiteWriteFenceError,
	readSiteWriteFence,
	SiteWriteBlockedError,
} from "../../../src/transfer/fence.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { getOrCreateSiteId, SITE_ID_OPTION } from "../../../src/transfer/site-id.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("transfer fence, domain, and site id", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	describe("site write fence", () => {
		async function importInState(state: string, mutationStarted: boolean): Promise<string> {
			const repo = new TransferOperationRepository(ctx.db);
			const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({
					state,
					mutation_started_at: mutationStarted ? "2026-01-01T00:00:00.000Z" : null,
				})
				.where("id", "=", operation.id)
				.execute();
			return operation.id;
		}

		it("checks both fences with exactly one query", async () => {
			let queries = 0;
			const counted = ctx.db.withPlugin({
				transformQuery(args) {
					queries++;
					return args.node;
				},
				async transformResult(args) {
					return args.result;
				},
			});
			expect(await findSiteWriteFenceError(counted)).toBeNull();
			expect(queries).toBe(1);
			await importInState("running", true);
			queries = 0;
			expect(await findSiteWriteFenceError(counted)).toMatchObject({
				code: "TRANSFER_IMPORT_IN_PROGRESS",
			});
			expect(queries).toBe(1);
		});

		it("allows writes when nothing is in progress", async () => {
			expect(await findSiteWriteFenceError(ctx.db)).toBeNull();
			await expect(assertSiteWriteAllowed(ctx.db)).resolves.toBeTypeOf("function");
			expect(await checkSiteWriteFence(ctx.db)).toBeNull();
		});

		it("does not fence an import that has not started writing", async () => {
			await importInState("planned", false);
			expect(await findSiteWriteFenceError(ctx.db)).toBeNull();
		});

		it("fences writes while an import runs or verifies", async () => {
			for (const state of ["running", "verifying"]) {
				const id = await importInState(state, true);
				expect(await findSiteWriteFenceError(ctx.db)).toMatchObject({
					code: "TRANSFER_IMPORT_IN_PROGRESS",
					status: 503,
					operationId: id,
				});
				await ctx.db.deleteFrom("_emdash_transfer_operations").execute();
			}
		});

		it("keeps fencing an incomplete import until it is abandoned", async () => {
			const id = await importInState("failed", true);
			await expect(assertSiteWriteAllowed(ctx.db)).rejects.toBeInstanceOf(SiteWriteBlockedError);
			const response = await checkSiteWriteFence(ctx.db);
			expect(response?.status).toBe(503);
			expect(await response?.json()).toMatchObject({
				error: { code: "TRANSFER_IMPORT_IN_PROGRESS" },
			});
			await new TransferOperationRepository(ctx.db).abandon(id);
			expect(await findSiteWriteFenceError(ctx.db)).toBeNull();
		});

		it("does not fence after a failure before any write", async () => {
			await importInState("failed", false);
			expect(await findSiteWriteFenceError(ctx.db)).toBeNull();
		});

		it("still reports media usage activation", async () => {
			await ctx.db
				.updateTable("_emdash_media_usage_activation")
				.set({ state: "activating" })
				.where("task_key", "=", "incremental_capture")
				.execute();
			expect(await findSiteWriteFenceError(ctx.db)).toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
			});
		});

		it("applies only the fences a scope asks for", async () => {
			await ctx.db
				.updateTable("_emdash_media_usage_activation")
				.set({ state: "activating" })
				.where("task_key", "=", "incremental_capture")
				.execute();
			expect((await readSiteWriteFence(ctx.db, { mediaUsage: false })).error).toBeNull();
			await importInState("running", true);
			expect((await readSiteWriteFence(ctx.db, { transfer: false })).error).toMatchObject({
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
			});
			expect((await readSiteWriteFence(ctx.db, { mediaUsage: false })).error).toMatchObject({
				code: "TRANSFER_IMPORT_IN_PROGRESS",
			});
		});

		it("records guarded writes for running exports only", async () => {
			const repo = new TransferOperationRepository(ctx.db);
			const { operation } = await repo.create({ kind: "export", createdBy: "u1" });
			const epoch = async () =>
				Number(
					(
						await ctx.db
							.selectFrom("_emdash_transfer_operations")
							.select("write_epoch")
							.where("id", "=", operation.id)
							.executeTakeFirstOrThrow()
					).write_epoch,
				);

			expect((await readSiteWriteFence(ctx.db)).exportRunning).toBe(false);
			await (
				await assertSiteWriteAllowed(ctx.db)
			)();
			expect(await checkSiteWriteFence(ctx.db)).toBeNull();
			expect(await epoch()).toBe(0);

			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({ state: "running" })
				.where("id", "=", operation.id)
				.execute();
			expect((await readSiteWriteFence(ctx.db)).exportRunning).toBe(true);
			const recordWrite = await assertSiteWriteAllowed(ctx.db);
			expect(await checkSiteWriteFence(ctx.db)).toBeNull();
			expect(await epoch()).toBe(0);
			await recordWrite();
			expect(await epoch()).toBe(1);
		});

		it("records a plugin content write only once it succeeds", async () => {
			const repo = new TransferOperationRepository(ctx.db);
			const { operation } = await repo.create({ kind: "export", createdBy: "u1" });
			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({ state: "running" })
				.where("id", "=", operation.id)
				.execute();
			await new SchemaRegistry(ctx.db).createCollection({ slug: "posts", label: "Posts" });
			await new SchemaRegistry(ctx.db).createField("posts", {
				slug: "title",
				label: "Title",
				type: "string",
			});
			const content = createContentAccessWithWrite(ctx.db, () => assertSiteWriteAllowed(ctx.db));

			await expect(content.update("posts", "missing", { title: "Nope" })).rejects.toThrow();
			expect((await repo.require(operation.id)).writeEpoch).toBe(0);
			await content.create("posts", { title: "Hello" });
			expect((await repo.require(operation.id)).writeEpoch).toBe(1);
		});
	});

	describe("inspectPortableDomain", () => {
		async function seedDefault(): Promise<void> {
			await applySeed(ctx.db, defaultSeed, { includeContent: false, onConflict: "skip" });
		}

		it("treats a freshly set-up site as empty and lists its seeded scaffold", async () => {
			await seedDefault();
			const result = await inspectPortableDomain(ctx.db);
			expect(result.blockers).toEqual([]);
			expect(result.empty).toBe(true);
			const collections = result.seededScaffold.filter((item) => item.type === "collection");
			expect(
				collections.flatMap((item) => (item.type === "collection" ? [item.slug] : [])).toSorted(),
			).toEqual(["pages", "posts"]);
			const defs = result.seededScaffold.filter((item) => item.type === "taxonomy_def");
			expect(
				defs.flatMap((item) => (item.type === "taxonomy_def" ? [item.name] : [])).toSorted(),
			).toEqual(["category", "tag"]);
		});

		it("treats theme sections, menus, widgets, and unassigned terms as scaffold", async () => {
			await seedDefault();
			await ctx.db
				.insertInto("_emdash_sections")
				.values({ id: "s1", slug: "hero", title: "Hero", content: "[]", source: "theme" })
				.execute();
			await ctx.db
				.insertInto("_emdash_menus")
				.values({ id: "m1", name: "primary", label: "Primary" })
				.execute();
			await ctx.db
				.insertInto("_emdash_menu_items")
				.values({ id: "i1", menu_id: "m1", sort_order: 0, type: "custom", label: "Home" })
				.execute();
			await ctx.db
				.insertInto("_emdash_widget_areas")
				.values({ id: "w1", name: "sidebar", label: "Sidebar" })
				.execute();
			await ctx.db
				.insertInto("_emdash_widgets")
				.values({ id: "wd1", area_id: "w1", sort_order: 0, type: "content" })
				.execute();
			await ctx.db
				.insertInto("taxonomies")
				.values({ id: "t1", name: "tag", slug: "x", label: "X" })
				.execute();
			const result = await inspectPortableDomain(ctx.db);
			expect(result.blockers).toEqual([]);
			expect(result.empty).toBe(true);
			const types = result.seededScaffold.map((item) => `${item.type}:${item.id}`);
			expect(types).toEqual(
				expect.arrayContaining([
					"section:s1",
					"menu:m1",
					"menu_item:i1",
					"widget_area:w1",
					"widget:wd1",
					"term:t1",
				]),
			);
			const position = (key: string) => types.indexOf(key);
			expect(position("term:t1")).toBeLessThan(position("taxonomy_def:taxdef_tag"));
			expect(position("menu_item:i1")).toBeLessThan(position("menu:m1"));
			expect(position("widget:wd1")).toBeLessThan(position("widget_area:w1"));
		});

		it("treats a taxonomy attached only to missing collections as scaffold", async () => {
			await applySeed(
				ctx.db,
				{ ...defaultSeed, collections: defaultSeed.collections?.filter((c) => c.slug === "pages") },
				{ includeContent: false, onConflict: "skip" },
			);
			const result = await inspectPortableDomain(ctx.db);
			expect(result.blockers).toEqual([]);
			expect(result.seededScaffold).toContainEqual(
				expect.objectContaining({ type: "taxonomy_def", name: "category" }),
			);
		});

		it("is not empty once any user content exists", async () => {
			await seedDefault();
			await ctx.db
				.insertInto("ec_posts" as never)
				.values({
					id: "e1",
					slug: "hello",
					status: "draft",
					locale: "en",
					deleted_at: "2026-01-01T00:00:00.000Z",
				} as never)
				.execute();
			const result = await inspectPortableDomain(ctx.db);
			expect(result.empty).toBe(false);
			expect(result.blockers).toContainEqual(
				expect.objectContaining({ code: "collection_has_entries", slug: "posts" }),
			);
		});

		it("is not empty with media, term assignments, user sections, or redirects", async () => {
			const cases: Array<[string, () => Promise<unknown>]> = [
				[
					"media",
					() =>
						ctx.db
							.insertInto("media")
							.values({
								id: "m",
								filename: "a",
								mime_type: "image/png",
								storage_key: "a.png",
								status: "ready",
							})
							.execute(),
				],
				[
					"content_taxonomies",
					() =>
						ctx.db
							.insertInto("content_taxonomies")
							.values({ collection: "posts", entry_id: "e", taxonomy_id: "t" })
							.execute(),
				],
				[
					"_emdash_sections",
					() =>
						ctx.db
							.insertInto("_emdash_sections")
							.values({ id: "s", slug: "mine", title: "Mine", content: "[]", source: "user" })
							.execute(),
				],
				[
					"_emdash_redirects",
					() =>
						ctx.db
							.insertInto("_emdash_redirects")
							.values({
								id: "r",
								source: "/a",
								destination: "/b",
								type: 301,
								is_pattern: 0,
								enabled: 1,
								hits: 0,
								auto: 0,
								config_revision: "0",
								source_guard: 0,
								write_generation: 0,
								created_at: "t",
								updated_at: "t",
							})
							.execute(),
				],
			];
			for (const [table, insert] of cases) {
				await insert();
				const result = await inspectPortableDomain(ctx.db);
				expect(result.empty, table).toBe(false);
				expect(result.blockers, table).toContainEqual({ code: "table_not_empty", table });
				await ctx.db.deleteFrom(table as "media").execute();
			}
		});

		it("is not empty with a collection the user created", async () => {
			await seedDefault();
			await new SchemaRegistry(ctx.db).createCollection({ slug: "products", label: "Products" });
			const result = await inspectPortableDomain(ctx.db);
			expect(result.empty).toBe(false);
			expect(result.blockers).toContainEqual(
				expect.objectContaining({ code: "collection_not_seeded", slug: "products" }),
			);
		});

		it("treats seeded block types as scaffold listed after the collections that use them", async () => {
			await applySeed(
				ctx.db,
				{
					...defaultSeed,
					blockTypes: [
						{
							slug: "callout",
							label: "Callout",
							currentVersion: 1,
							versions: [{ version: 1, fields: [{ slug: "text", label: "Text", type: "string" }] }],
						},
					],
				},
				{ includeContent: false, onConflict: "skip" },
			);
			const result = await inspectPortableDomain(ctx.db);
			expect(result.blockers).toEqual([]);
			expect(result.empty).toBe(true);
			const types = result.seededScaffold.map((item) => item.type);
			expect(result.seededScaffold).toContainEqual(
				expect.objectContaining({ type: "block_type", slug: "callout" }),
			);
			expect(types.indexOf("block_type")).toBeGreaterThan(types.lastIndexOf("collection"));
		});

		it("is not empty with a block type the user created", async () => {
			await seedDefault();
			await new BlockTypeRegistry(ctx.db).createBlockType({
				slug: "callout",
				label: "Callout",
				fields: [{ slug: "text", label: "Text", type: "string" }],
			});
			const result = await inspectPortableDomain(ctx.db);
			expect(result.empty).toBe(false);
			expect(result.blockers).toContainEqual(
				expect.objectContaining({ code: "block_type_not_seeded", slug: "callout" }),
			);
		});

		it("is not empty with a taxonomy attached to a user collection", async () => {
			await new SchemaRegistry(ctx.db).createCollection({ slug: "products", label: "Products" });
			await ctx.db
				.insertInto("_emdash_taxonomy_defs")
				.values({
					id: "brand",
					name: "brand",
					label: "Brands",
					hierarchical: 0,
					collections: JSON.stringify(["products"]),
				})
				.execute();
			const result = await inspectPortableDomain(ctx.db);
			expect(result.blockers).toContainEqual({
				code: "taxonomy_def_not_scaffold",
				id: "brand",
				name: "brand",
			});
		});
	});

	describe("getOrCreateSiteId", () => {
		it("creates the id once and converges under concurrency", async () => {
			const ids = await Promise.all(Array.from({ length: 8 }, () => getOrCreateSiteId(ctx.db)));
			expect(new Set(ids).size).toBe(1);
			expect(await getOrCreateSiteId(ctx.db)).toBe(ids[0]);
			expect(await new OptionsRepository(ctx.db).get(SITE_ID_OPTION)).toBe(ids[0]);
		});
	});
});
