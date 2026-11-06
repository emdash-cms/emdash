import { afterEach, beforeEach, expect, it } from "vitest";

import { handleTaxonomyGet, handleTaxonomyUpdate } from "../../../src/api/handlers/taxonomies.js";
import * as migration085 from "../../../src/database/migrations/085_taxonomy_def_groups.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	runMigrationsForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("taxonomy definition groups migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("083_block_types");
		if (error) throw error;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("merges drifted definitions of one name into one structure and can restart", async () => {
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values([
				{
					id: "topic-en",
					name: "topic",
					label: "Topics",
					label_singular: null,
					hierarchical: 1,
					collections: JSON.stringify(["post"]),
					locale: "en",
					translation_group: "topic-en",
				},
				// Translated before inheritance existed: structure reset to defaults.
				{
					id: "topic-es",
					name: "topic",
					label: "Temas",
					label_singular: null,
					hierarchical: 0,
					collections: "[]",
					locale: "es",
					translation_group: "topic-en",
				},
				// Created without translationOf, so it started a group of its own.
				{
					id: "topic-fr",
					name: "topic",
					label: "Sujets",
					label_singular: null,
					hierarchical: 0,
					collections: JSON.stringify(["page", "post"]),
					locale: "fr",
					translation_group: "topic-fr",
				},
				{
					id: "genre-en",
					name: "genre",
					label: "Genres",
					label_singular: null,
					hierarchical: 0,
					collections: "not json",
					locale: "en",
					translation_group: null,
				},
			])
			.execute();

		await runMigrationsForDialect(ctx);
		await expect(migration085.up(ctx.db)).resolves.toBeUndefined();

		const groups = await ctx.db
			.selectFrom("_emdash_taxonomy_def_groups")
			.select(["id", "name", "hierarchical", "collections"])
			.where("name", "in", ["topic", "genre"])
			.orderBy("name", "asc")
			.execute();
		expect(groups).toEqual([
			{ id: "genre-en", name: "genre", hierarchical: 0, collections: "[]" },
			{
				id: "topic-en",
				name: "topic",
				hierarchical: 1,
				collections: JSON.stringify(["post", "page"]),
			},
		]);

		const rows = await ctx.db
			.selectFrom("_emdash_taxonomy_defs")
			.select(["id", "translation_group", "hierarchical", "collections"])
			.where("name", "=", "topic")
			.orderBy("id", "asc")
			.execute();
		expect(rows).toEqual(
			["topic-en", "topic-es", "topic-fr"].map((id) => ({
				id,
				translation_group: "topic-en",
				hierarchical: 1,
				collections: JSON.stringify(["post", "page"]),
			})),
		);
	});

	it("gives each name its own group when names share a translation group", async () => {
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values([
				{
					id: "genre-en",
					name: "genre",
					label: "Genres",
					label_singular: null,
					hierarchical: 0,
					collections: JSON.stringify(["post"]),
					locale: "en",
					translation_group: "genre-en",
				},
				// Linked by a seed `translationOf` that named a different taxonomy.
				{
					id: "gattung-de",
					name: "gattung",
					label: "Gattungen",
					label_singular: null,
					hierarchical: 1,
					collections: JSON.stringify(["page"]),
					locale: "de",
					translation_group: "genre-en",
				},
			])
			.execute();

		await runMigrationsForDialect(ctx);
		await expect(migration085.up(ctx.db)).resolves.toBeUndefined();

		const groups = await ctx.db
			.selectFrom("_emdash_taxonomy_def_groups")
			.select(["id", "name", "hierarchical", "collections"])
			.where("name", "in", ["genre", "gattung"])
			.orderBy("name", "asc")
			.execute();
		const [gattung, genre] = groups;
		expect(genre).toEqual({
			id: "genre-en",
			name: "genre",
			hierarchical: 0,
			collections: JSON.stringify(["post"]),
		});
		expect(gattung).toMatchObject({
			name: "gattung",
			hierarchical: 1,
			collections: JSON.stringify(["page"]),
		});
		expect(gattung?.id).not.toBe("genre-en");

		const row = await ctx.db
			.selectFrom("_emdash_taxonomy_defs")
			.select("translation_group")
			.where("id", "=", "gattung-de")
			.executeTakeFirstOrThrow();
		expect(row.translation_group).toBe(gattung?.id);

		const updated = await handleTaxonomyUpdate(ctx.db, "gattung", { hierarchical: false });
		expect(updated.success).toBe(true);
	});

	it("restarts after the groups were written but before the definitions were linked", async () => {
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values([
				{
					id: "genre-en",
					name: "genre",
					label: "Genres",
					label_singular: null,
					hierarchical: 0,
					collections: JSON.stringify(["post"]),
					locale: "en",
					translation_group: "genre-en",
				},
				{
					id: "gattung-de",
					name: "gattung",
					label: "Gattungen",
					label_singular: null,
					hierarchical: 1,
					collections: JSON.stringify(["page"]),
					locale: "de",
					translation_group: "genre-en",
				},
			])
			.execute();
		await runMigrationsForDialect(ctx);
		const group = await ctx.db
			.selectFrom("_emdash_taxonomy_def_groups")
			.select("id")
			.where("name", "=", "gattung")
			.executeTakeFirstOrThrow();
		await ctx.db
			.updateTable("_emdash_taxonomy_defs")
			.set({ translation_group: "genre-en" })
			.where("id", "=", "gattung-de")
			.execute();

		await migration085.up(ctx.db);

		const groups = await ctx.db
			.selectFrom("_emdash_taxonomy_def_groups")
			.select("id")
			.where("name", "=", "gattung")
			.execute();
		expect(groups).toEqual([group]);
		const row = await ctx.db
			.selectFrom("_emdash_taxonomy_defs")
			.select("translation_group")
			.where("id", "=", "gattung-de")
			.executeTakeFirstOrThrow();
		expect(row.translation_group).toBe(group.id);
	});

	it("gives every name a group when there are more names than one insert holds", async () => {
		const names = Array.from({ length: 30 }, (_, i) => `topic_${String(i).padStart(2, "0")}`);
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values(
				names.map((name) => ({
					id: name,
					name,
					label: name,
					label_singular: null,
					hierarchical: 0,
					collections: "[]",
					locale: "en",
					translation_group: name,
				})),
			)
			.execute();

		await runMigrationsForDialect(ctx);

		const groups = await ctx.db
			.selectFrom("_emdash_taxonomy_def_groups")
			.select("name")
			.where("name", "in", names)
			.execute();
		expect(groups).toHaveLength(names.length);
	});

	it("reads a definition written without a group by code that predates it", async () => {
		await runMigrationsForDialect(ctx);
		await ctx.db
			.insertInto("_emdash_taxonomy_defs")
			.values({
				id: "legacy",
				name: "legacy",
				label: "Legacy",
				label_singular: null,
				hierarchical: 1,
				collections: JSON.stringify(["post"]),
				locale: "en",
				translation_group: "legacy",
			})
			.execute();

		const result = await handleTaxonomyGet(ctx.db, "legacy");
		expect(result.success && result.data.taxonomy).toMatchObject({
			name: "legacy",
			hierarchical: true,
		});
	});
});
