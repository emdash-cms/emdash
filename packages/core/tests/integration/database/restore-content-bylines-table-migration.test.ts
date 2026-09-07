import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { indexExists, tableExists } from "../../../src/database/dialect-helpers.js";
import * as migration071 from "../../../src/database/migrations/071_restore_content_bylines_table.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import {
	describeEachDialect,
	runMigrationsForDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("restore content bylines table migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createCreditedPost() {
		const content = new ContentRepository(ctx.db);
		const bylines = new BylineRepository(ctx.db);
		const post = await content.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
		});
		const author = await bylines.create({ slug: "ada", displayName: "Ada" });
		await bylines.setContentBylines("post", post.id, [{ bylineId: author.id }]);
		return { post, author };
	}

	async function leaveStagedCopyBehind() {
		await sql`DROP INDEX IF EXISTS idx_content_bylines_content`.execute(ctx.db);
		await sql`DROP INDEX IF EXISTS idx_content_bylines_byline`.execute(ctx.db);
		await sql`ALTER TABLE _emdash_content_bylines RENAME TO _emdash_content_bylines_new`.execute(
			ctx.db,
		);
	}

	it("keeps a healthy table and its credits untouched", async () => {
		const { post, author } = await createCreditedPost();

		await migration071.up(ctx.db);

		expect(await tableExists(ctx.db, "_emdash_content_bylines")).toBe(true);
		expect(await tableExists(ctx.db, "_emdash_content_bylines_new")).toBe(false);
		const credits = await new BylineRepository(ctx.db).getContentBylines("post", post.id);
		expect(credits.map((c) => c.byline.id)).toEqual([author.id]);
	});

	if (dialect === "sqlite") {
		it("renames the staged copy back and restores its indexes", async () => {
			const { post, author } = await createCreditedPost();
			await leaveStagedCopyBehind();

			await migration071.up(ctx.db);

			expect(await tableExists(ctx.db, "_emdash_content_bylines")).toBe(true);
			expect(await tableExists(ctx.db, "_emdash_content_bylines_new")).toBe(false);
			expect(await indexExists(ctx.db, "idx_content_bylines_content")).toBe(true);
			expect(await indexExists(ctx.db, "idx_content_bylines_byline")).toBe(true);
			const credits = await new BylineRepository(ctx.db).getContentBylines("post", post.id);
			expect(credits.map((c) => c.byline.id)).toEqual([author.id]);
		});

		it("completes when re-run after the rename already landed", async () => {
			const { post, author } = await createCreditedPost();
			await leaveStagedCopyBehind();
			await sql`ALTER TABLE _emdash_content_bylines_new RENAME TO _emdash_content_bylines`.execute(
				ctx.db,
			);

			await migration071.up(ctx.db);
			await migration071.up(ctx.db);

			expect(await indexExists(ctx.db, "idx_content_bylines_content")).toBe(true);
			expect(await indexExists(ctx.db, "idx_content_bylines_byline")).toBe(true);
			const credits = await new BylineRepository(ctx.db).getContentBylines("post", post.id);
			expect(credits.map((c) => c.byline.id)).toEqual([author.id]);
		});

		it("recovers through the runner when the rebuild is retried after the drop", async () => {
			const { post, author } = await createCreditedPost();
			await leaveStagedCopyBehind();
			await ctx.db
				.deleteFrom("_emdash_migrations")
				.where("name", ">=", "040_byline_i18n")
				.execute();

			const { applied } = await runMigrationsForDialect(ctx);

			expect(applied).toContain("040_byline_i18n");
			expect(applied).toContain("071_restore_content_bylines_table");
			expect(await tableExists(ctx.db, "_emdash_content_bylines")).toBe(true);
			expect(await tableExists(ctx.db, "_emdash_content_bylines_new")).toBe(false);
			const credits = await new BylineRepository(ctx.db).getContentBylines("post", post.id);
			expect(credits.map((c) => c.byline.id)).toEqual([author.id]);
		});

		it("leaves a stale staged copy alone while the live table exists", async () => {
			const { post, author } = await createCreditedPost();
			await sql`CREATE TABLE _emdash_content_bylines_new AS SELECT * FROM _emdash_content_bylines WHERE 0`.execute(
				ctx.db,
			);

			await migration071.up(ctx.db);

			expect(await tableExists(ctx.db, "_emdash_content_bylines_new")).toBe(true);
			const credits = await new BylineRepository(ctx.db).getContentBylines("post", post.id);
			expect(credits.map((c) => c.byline.id)).toEqual([author.id]);
		});
	}
});
