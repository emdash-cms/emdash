import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { rewriteUrls } from "../../../src/astro/routes/api/import/wordpress/rewrite-urls.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("WordPress URL rewriting", (dialect) => {
	let ctx: DialectTestContext;
	const oldUrl = "https://wordpress.example/wp-content/uploads/hero.jpg";
	const newUrl = "/_emdash/api/media/file/imported/hero.jpg";
	const urlMap = { [oldUrl]: newUrl };
	const media = { provider: "external", id: "", src: oldUrl };
	const blocks = [
		{ _type: "image", asset: { url: `${oldUrl}?w=200` } },
		{ _type: "gallery", images: [{ _type: "image", asset: { url: oldUrl } }] },
	];

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "body", label: "Body", type: "portableText" });
		await registry.createField("posts", { slug: "hero", label: "Hero", type: "image" });
		await registry.createField("posts", { slug: "attachment", label: "Attachment", type: "file" });
		await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "text" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function decode(value: unknown): unknown {
		return typeof value === "string" ? JSON.parse(value) : value;
	}

	async function insertEntry(id = "entry") {
		await sql`INSERT INTO ec_posts (id, slug, body, hero, attachment, excerpt)
			VALUES (${id}, ${id}, ${JSON.stringify(blocks)}, ${JSON.stringify(media)},
				${JSON.stringify(media)}, ${`Image: ${oldUrl}`})`.execute(ctx.db);
	}

	async function expectRewritten() {
		const result = await rewriteUrls(ctx.db, urlMap, () => undefined);
		expect(result).toEqual({
			updated: 1,
			byCollection: { posts: 1 },
			urlsRewritten: 5,
			errors: [],
		});
		const { rows } = await sql<
			Record<string, unknown>
		>`SELECT * FROM ec_posts WHERE id = 'entry'`.execute(ctx.db);
		expect(decode(rows[0].body)).toEqual([
			{ _type: "image", asset: { url: newUrl, _ref: newUrl } },
			{ _type: "gallery", images: [{ _type: "image", asset: { url: newUrl, _ref: newUrl } }] },
		]);
		expect(decode(rows[0].hero)).toEqual({ ...media, src: newUrl });
		expect(decode(rows[0].attachment)).toEqual({ ...media, src: newUrl });
		expect(rows[0].excerpt).toBe(`Image: ${newUrl}`);
		expect(await rewriteUrls(ctx.db, urlMap, () => undefined)).toEqual({
			updated: 0,
			byCollection: {},
			urlsRewritten: 0,
			errors: [],
		});
	}

	it("rewrites inline, nested, featured and file URLs and counts them once", async () => {
		await insertEntry();
		await expectRewritten();
	});

	if (dialect === "postgres") {
		it("also rewrites media fields stored in JSON columns", async () => {
			await sql`ALTER TABLE ec_posts ALTER COLUMN hero TYPE json USING hero::json`.execute(ctx.db);
			await sql`ALTER TABLE ec_posts ALTER COLUMN attachment TYPE json USING attachment::json`.execute(
				ctx.db,
			);
			await insertEntry();
			await expectRewritten();
		});
	}

	it("leaves null, non-array, unmatched and deleted content untouched", async () => {
		await sql`INSERT INTO ec_posts (id, slug, body, hero, attachment)
			VALUES ('nulls', 'nulls', NULL, NULL, NULL),
				('nonarray', 'nonarray', ${JSON.stringify({ url: oldUrl })}, ${JSON.stringify({ provider: "local", id: "unmatched" })}, NULL)`.execute(
			ctx.db,
		);
		await insertEntry("deleted");
		await sql`UPDATE ec_posts SET deleted_at = '2026-01-01T00:00:00Z' WHERE id = 'deleted'`.execute(
			ctx.db,
		);
		const before = await sql`SELECT * FROM ec_posts ORDER BY id`.execute(ctx.db);
		expect(await rewriteUrls(ctx.db, urlMap, () => undefined)).toEqual({
			updated: 0,
			byCollection: {},
			urlsRewritten: 0,
			errors: [],
		});
		expect((await sql`SELECT * FROM ec_posts ORDER BY id`.execute(ctx.db)).rows).toEqual(
			before.rows,
		);
	});

	if (dialect === "sqlite") {
		it("keeps the string fallback for malformed Portable Text and legacy bare media URLs", async () => {
			await sql`INSERT INTO ec_posts (id, slug, body, hero)
				VALUES ('legacy', 'legacy', ${`<img src="${oldUrl}">`}, ${oldUrl})`.execute(ctx.db);
			const result = await rewriteUrls(ctx.db, urlMap, () => undefined);
			expect(result.updated).toBe(1);
			expect(result.urlsRewritten).toBe(2);
			expect(result.errors).toEqual([]);
			const { rows } = await sql<{
				body: string;
				hero: string;
			}>`SELECT body, hero FROM ec_posts WHERE id = 'legacy'`.execute(ctx.db);
			expect(rows[0].body).toBe(`<img src="${newUrl}">`);
			expect(decode(rows[0].hero)).toEqual({ ...media, src: newUrl });
		});
	}
});
