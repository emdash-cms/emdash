import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleTaxonomyCreate,
	handleTaxonomyDelete,
	handleTaxonomyGet,
	handleTaxonomyUpdate,
	handleTermCreate,
} from "../../../src/api/handlers/taxonomies.js";
import {
	DELETE as deleteTaxonomy,
	GET as getTaxonomy,
	PUT as putTaxonomy,
} from "../../../src/astro/routes/api/taxonomies/[name].js";
import { GET as getTranslations } from "../../../src/astro/routes/api/taxonomies/[name]/translations.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const adminUser = { id: "u-admin", email: "a@example.com", name: "Admin", role: Role.ADMIN };
const subscriber = { id: "u-sub", email: "s@example.com", name: "Sub", role: Role.SUBSCRIBER };

function buildContext(
	db: Kysely<DatabaseSchema>,
	name: string,
	options: {
		method?: string;
		search?: string;
		body?: unknown;
		user?: { id: string; role: RoleLevel };
		path?: string;
	} = {},
): APIContext {
	const { method = "GET", search = "", body, user = adminUser, path = "" } = options;
	const url = new URL(`http://localhost/_emdash/api/taxonomies/${name}${path}${search}`);
	return {
		params: { name },
		url,
		request: new Request(url, {
			method,
			headers: { "X-EmDash-Request": "1", "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		locals: { emdash: { db }, user },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

async function readBody<T>(response: Response): Promise<T> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test-local response shape
	return (await response.json()) as T;
}

/** Term slugs left in `taxonomies`, across every locale. */
async function remainingTerms(db: Kysely<DatabaseSchema>, name: string): Promise<string[]> {
	const rows = await db
		.selectFrom("taxonomies")
		.select("slug")
		.where("name", "=", name)
		.orderBy("slug")
		.execute();
	return rows.map((r) => r.slug);
}

async function pivotCount(db: Kysely<DatabaseSchema>): Promise<number> {
	const rows = await db.selectFrom("content_taxonomies").selectAll().execute();
	return rows.length;
}

describeEachDialect("single-taxonomy CRUD", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		const created = await handleTaxonomyCreate(db, {
			name: "genre",
			label: "Genres",
			labelSingular: "Genre",
			hierarchical: true,
			collections: ["post"],
		});
		expect(created.success).toBe(true);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	describe("handleTaxonomyGet", () => {
		it("returns the definition", async () => {
			const result = await handleTaxonomyGet(db, "genre");

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy).toMatchObject({
				name: "genre",
				label: "Genres",
				labelSingular: "Genre",
				hierarchical: true,
				collections: ["post"],
			});
		});

		it("reports NOT_FOUND for an unknown name", async () => {
			const result = await handleTaxonomyGet(db, "nope");

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("NOT_FOUND");
		});

		it("falls back to the default locale when the requested locale has no definition", async () => {
			const source = await handleTaxonomyGet(db, "genre");
			expect(source.success).toBe(true);
			if (!source.success) return;
			await handleTaxonomyCreate(db, {
				name: "genre",
				label: "Géneros",
				locale: "es",
				translationOf: source.data.taxonomy.id,
			});
			setI18nConfig({ defaultLocale: "es", locales: ["en", "es", "fr"] });

			const result = await handleTaxonomyGet(db, "genre", { locale: "fr" });

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy).toMatchObject({ label: "Géneros", locale: "es" });
		});

		it("returns the requested locale's definition", async () => {
			const source = await handleTaxonomyGet(db, "genre");
			expect(source.success).toBe(true);
			if (!source.success) return;
			await handleTaxonomyCreate(db, {
				name: "genre",
				label: "Géneros",
				locale: "es",
				translationOf: source.data.taxonomy.id,
			});

			const result = await handleTaxonomyGet(db, "genre", { locale: "es" });

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy).toMatchObject({ label: "Géneros", locale: "es" });
		});

		it("drops collection references whose collection is gone", async () => {
			await new SchemaRegistry(db).deleteCollection("post");

			const result = await handleTaxonomyGet(db, "genre");

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy.collections).toEqual([]);
		});
	});

	describe("handleTaxonomyUpdate", () => {
		it("updates the fields it is given", async () => {
			const result = await handleTaxonomyUpdate(db, "genre", {
				label: "Kinds",
				labelSingular: "Kind",
				hierarchical: false,
				collections: ["page"],
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy).toMatchObject({
				name: "genre",
				label: "Kinds",
				labelSingular: "Kind",
				hierarchical: false,
				collections: ["page"],
			});

			const reread = await handleTaxonomyGet(db, "genre");
			expect(reread.success && reread.data.taxonomy.label).toBe("Kinds");
		});

		it("leaves omitted fields alone", async () => {
			const result = await handleTaxonomyUpdate(db, "genre", { label: "Kinds" });

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy).toMatchObject({
				label: "Kinds",
				labelSingular: "Genre",
				hierarchical: true,
				collections: ["post"],
			});
		});

		it("clears labelSingular when passed null", async () => {
			const result = await handleTaxonomyUpdate(db, "genre", { labelSingular: null });

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy.labelSingular).toBeUndefined();
		});

		it("rejects unknown collections without writing", async () => {
			const result = await handleTaxonomyUpdate(db, "genre", {
				label: "Kinds",
				collections: ["post", "ghost"],
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
			expect(result.error.message).toContain("ghost");

			const reread = await handleTaxonomyGet(db, "genre");
			expect(reread.success && reread.data.taxonomy.label).toBe("Genres");
		});

		it("writes only the addressed locale's definition", async () => {
			const source = await handleTaxonomyGet(db, "genre");
			expect(source.success).toBe(true);
			if (!source.success) return;
			await handleTaxonomyCreate(db, {
				name: "genre",
				label: "Géneros",
				locale: "es",
				translationOf: source.data.taxonomy.id,
			});

			const result = await handleTaxonomyUpdate(db, "genre", {
				label: "Categorías",
				locale: "es",
			});

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data.taxonomy).toMatchObject({ label: "Categorías", locale: "es" });

			const english = await handleTaxonomyGet(db, "genre", { locale: "en" });
			expect(english.success && english.data.taxonomy.label).toBe("Genres");
		});

		it("does not fall back when the addressed locale has no definition", async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });

			const result = await handleTaxonomyUpdate(db, "genre", {
				label: "Genres français",
				locale: "fr",
			});

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("NOT_FOUND");

			const english = await handleTaxonomyGet(db, "genre", { locale: "en" });
			expect(english.success && english.data.taxonomy.label).toBe("Genres");
		});

		it("reports NOT_FOUND for an unknown name", async () => {
			const result = await handleTaxonomyUpdate(db, "nope", { label: "x" });

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("NOT_FOUND");
		});
	});

	describe("handleTaxonomyDelete", () => {
		beforeEach(async () => {
			await handleTaxonomyCreate(db, { name: "mood", label: "Moods", collections: ["post"] });

			const taxRepo = new TaxonomyRepository(db);
			const contentRepo = new ContentRepository(db);
			const noir = await taxRepo.create({ name: "genre", slug: "noir", label: "Noir" });
			const calm = await taxRepo.create({ name: "mood", slug: "calm", label: "Calm" });
			const entry = await contentRepo.create({
				type: "post",
				slug: "the-big-sleep",
				status: "published",
				data: {},
			});
			await taxRepo.attachToEntry("post", entry.id, noir.id);
			await taxRepo.attachToEntry("post", entry.id, calm.id);
			expect(await pivotCount(db)).toBe(2);
		});

		it("removes the definition, its terms, and their assignments", async () => {
			const result = await handleTaxonomyDelete(db, "genre");

			expect(result.success).toBe(true);
			if (!result.success) return;
			expect(result.data).toEqual({ deleted: true });

			const lookup = await handleTaxonomyGet(db, "genre");
			expect(lookup.success).toBe(false);
			expect(await remainingTerms(db, "genre")).toEqual([]);
			expect(await pivotCount(db)).toBe(1);
		});

		it("leaves other taxonomies untouched", async () => {
			await handleTaxonomyDelete(db, "genre");

			const survivor = await handleTaxonomyGet(db, "mood");
			expect(survivor.success).toBe(true);
			expect(await remainingTerms(db, "mood")).toEqual(["calm"]);
		});

		it("removes every locale of the definition and of its terms", async () => {
			const source = await handleTaxonomyGet(db, "genre");
			expect(source.success).toBe(true);
			if (!source.success) return;
			await handleTaxonomyCreate(db, {
				name: "genre",
				label: "Géneros",
				locale: "es",
				translationOf: source.data.taxonomy.id,
			});
			const spanishTerm = await handleTermCreate(db, "genre", {
				slug: "negro",
				label: "Negro",
				locale: "es",
			});
			expect(spanishTerm.success).toBe(true);

			await handleTaxonomyDelete(db, "genre");

			const defs = await db
				.selectFrom("_emdash_taxonomy_defs")
				.select("id")
				.where("name", "=", "genre")
				.execute();
			expect(defs).toEqual([]);
			expect(await remainingTerms(db, "genre")).toEqual([]);
		});

		it("removes a parent term along with its children", async () => {
			const repo = new TaxonomyRepository(db);
			const parent = await repo.create({ name: "genre", slug: "fiction", label: "Fiction" });
			await repo.create({
				name: "genre",
				slug: "crime",
				label: "Crime",
				parentId: parent.id,
			});

			const result = await handleTaxonomyDelete(db, "genre");

			expect(result.success).toBe(true);
			expect(await remainingTerms(db, "genre")).toEqual([]);
		});

		it("reports NOT_FOUND for an unknown name", async () => {
			const result = await handleTaxonomyDelete(db, "nope");

			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("NOT_FOUND");
			expect(await pivotCount(db)).toBe(2);
		});
	});

	describe("routes", () => {
		it("GET returns the definition", async () => {
			const response = await getTaxonomy(buildContext(db, "genre"));
			const body = await readBody<{ data: { taxonomy: { label: string } } }>(response);

			expect(response.status).toBe(200);
			expect(body.data.taxonomy.label).toBe("Genres");
		});

		it("GET 404s for an unknown taxonomy", async () => {
			const response = await getTaxonomy(buildContext(db, "nope"));

			expect(response.status).toBe(404);
		});

		it("PUT updates the definition", async () => {
			const response = await putTaxonomy(
				buildContext(db, "genre", { method: "PUT", body: { label: "Kinds" } }),
			);
			const body = await readBody<{ data: { taxonomy: { label: string } } }>(response);

			expect(response.status).toBe(200);
			expect(body.data.taxonomy.label).toBe("Kinds");
		});

		it("PUT rejects a body that tries to rename the taxonomy", async () => {
			const response = await putTaxonomy(
				buildContext(db, "genre", { method: "PUT", body: { name: "kinds" } }),
			);

			expect(response.status).toBe(400);
			const reread = await handleTaxonomyGet(db, "genre");
			expect(reread.success).toBe(true);
		});

		it("DELETE removes the definition, its terms, and their assignments", async () => {
			const taxRepo = new TaxonomyRepository(db);
			const contentRepo = new ContentRepository(db);
			const term = await taxRepo.create({ name: "genre", slug: "noir", label: "Noir" });
			const entry = await contentRepo.create({
				type: "post",
				slug: "the-long-goodbye",
				status: "published",
				data: {},
			});
			await taxRepo.attachToEntry("post", entry.id, term.id);

			const response = await deleteTaxonomy(buildContext(db, "genre", { method: "DELETE" }));
			const body = await readBody<{ data: { deleted: boolean } }>(response);

			expect(response.status).toBe(200);
			expect(body.data.deleted).toBe(true);
			expect(await remainingTerms(db, "genre")).toEqual([]);
			expect(await pivotCount(db)).toBe(0);
		});

		it("lists the definition's translations", async () => {
			const source = await handleTaxonomyGet(db, "genre");
			expect(source.success).toBe(true);
			if (!source.success) return;
			await handleTaxonomyCreate(db, {
				name: "genre",
				label: "Géneros",
				locale: "es",
				translationOf: source.data.taxonomy.id,
			});

			const response = await getTranslations(buildContext(db, "genre", { path: "/translations" }));
			const body = await readBody<{
				data: { translations: Array<{ locale: string; label: string }> };
			}>(response);

			expect(response.status).toBe(200);
			expect(body.data.translations.map((t) => t.locale)).toEqual(["en", "es"]);
		});

		it("refuses a writer without taxonomies:manage", async () => {
			const put = await putTaxonomy(
				buildContext(db, "genre", { method: "PUT", body: { label: "Kinds" }, user: subscriber }),
			);
			const del = await deleteTaxonomy(
				buildContext(db, "genre", { method: "DELETE", user: subscriber }),
			);

			expect(put.status).toBe(403);
			expect(del.status).toBe(403);
			const survivor = await handleTaxonomyGet(db, "genre");
			expect(survivor.success && survivor.data.taxonomy.label).toBe("Genres");
		});
	});
});

describe("taxonomy delete with foreign keys enforced", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		const sqlite = new BetterSqlite3(":memory:");
		sqlite.pragma("foreign_keys = ON");
		db = new Kysely<DatabaseSchema>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		await new SchemaRegistry(db).createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
		});
		await handleTaxonomyCreate(db, {
			name: "genre",
			label: "Genres",
			hierarchical: true,
			collections: ["post"],
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("deletes a term tree and its assignments", async () => {
		const taxRepo = new TaxonomyRepository(db);
		const contentRepo = new ContentRepository(db);
		const parent = await taxRepo.create({ name: "genre", slug: "fiction", label: "Fiction" });
		const child = await taxRepo.create({
			name: "genre",
			slug: "crime",
			label: "Crime",
			parentId: parent.id,
		});
		const entry = await contentRepo.create({
			type: "post",
			slug: "the-big-sleep",
			status: "published",
			data: {},
		});
		await taxRepo.attachToEntry("post", entry.id, child.id);

		const result = await handleTaxonomyDelete(db, "genre");

		expect(result.success).toBe(true);
		expect(await remainingTerms(db, "genre")).toEqual([]);
		expect(await pivotCount(db)).toBe(0);
	});
});
