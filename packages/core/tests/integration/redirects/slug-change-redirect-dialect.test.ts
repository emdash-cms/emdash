import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentCreate,
	handleContentPublish,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

describeEachDialect("published slug-change redirects", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- dialect test contexts use the same migrated Database schema
		db = ctx.db as unknown as Kysely<Database>;
		const schema = new SchemaRegistry(db);
		await schema.createCollection({
			slug: "posts",
			label: "Posts",
			urlPattern: "/blog/{slug}",
		});
		await schema.createField("posts", { slug: "title", label: "Title", type: "string" });
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createShadowingAutoRedirect(): Promise<RedirectRepository> {
		const entry = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "published",
			data: { title: "A" },
		});
		await handleContentUpdate(db, "posts", entry.id, { slug: "b" });
		await new ContentRepository(db).delete("posts", entry.id);
		return new RedirectRepository(db);
	}

	async function blockAutoRedirectDeletes(): Promise<void> {
		const triggerName = "block_slug_shadow_redirect_delete";
		if (dialect === "postgres") {
			await sql`
				CREATE OR REPLACE FUNCTION block_slug_shadow_redirect_delete() RETURNS trigger AS $$
				BEGIN
					IF OLD.source = '/blog/a' AND OLD.auto = 1 THEN
						RAISE EXCEPTION 'slug shadow redirect delete blocked';
					END IF;
					RETURN OLD;
				END;
				$$ LANGUAGE plpgsql
			`.execute(db);
			await sql`
				CREATE TRIGGER ${sql.ref(triggerName)}
				BEFORE DELETE ON _emdash_redirects
				FOR EACH ROW EXECUTE FUNCTION block_slug_shadow_redirect_delete()
			`.execute(db);
		} else {
			await sql`
				CREATE TRIGGER ${sql.ref(triggerName)}
				BEFORE DELETE ON _emdash_redirects
				WHEN OLD.source = '/blog/a' AND OLD.auto = 1
				BEGIN
					SELECT RAISE(ABORT, 'slug shadow redirect delete blocked');
				END
			`.execute(db);
		}
	}

	it("creates an automatic redirect inside the content update transaction", async () => {
		const entry = await new ContentRepository(db).create({
			type: "posts",
			slug: "old-title",
			status: "published",
			data: { title: "Old title" },
		});

		await expect(
			handleContentUpdate(db, "posts", entry.id, { slug: "new-title" }),
		).resolves.toMatchObject({ success: true });
		await expect(
			db.selectFrom("_emdash_redirects").select(["source", "destination", "auto"]).execute(),
		).resolves.toEqual([
			expect.objectContaining({
				source: "/blog/old-title",
				destination: "/blog/new-title",
				auto: 1,
			}),
		]);
	});

	it("removes a redirect from the new URL before collapsing chains", async () => {
		const entry = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "published",
			data: { title: "A" },
		});
		const redirects = new RedirectRepository(db);
		await redirects.create({ source: "/blog/b", destination: "/promo" });
		await redirects.create({ source: "/promo", destination: "/blog/a" });

		await expect(handleContentUpdate(db, "posts", entry.id, { slug: "b" })).resolves.toMatchObject({
			success: true,
		});
		await expect(
			db
				.selectFrom("_emdash_redirects")
				.select(["source", "destination", "auto"])
				.orderBy("source")
				.execute(),
		).resolves.toEqual([
			expect.objectContaining({ source: "/blog/a", destination: "/blog/b", auto: 1 }),
			expect.objectContaining({ source: "/promo", destination: "/blog/b" }),
		]);
	});

	it("removes the auto-redirect from the URL a new entry is published at", async () => {
		const redirects = new RedirectRepository(db);
		const entry = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "published",
			data: { title: "A" },
		});
		await handleContentUpdate(db, "posts", entry.id, { slug: "b" });
		await new ContentRepository(db).delete("posts", entry.id);

		await expect(
			handleContentCreate(db, "posts", {
				slug: "a",
				status: "published",
				data: { title: "New A" },
			}),
		).resolves.toMatchObject({ success: true });

		await expect(redirects.findBySource("/blog/a")).resolves.toBeNull();
		await expect(
			db.selectFrom("_emdash_redirects").select(["source", "destination", "auto"]).execute(),
		).resolves.toEqual([]);
	});

	it("removes the auto-redirect when a new entry is created as published", async () => {
		const redirects = new RedirectRepository(db);
		const entry = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "published",
			data: { title: "A" },
		});
		await handleContentUpdate(db, "posts", entry.id, { slug: "b" });

		await expect(
			handleContentCreate(db, "posts", {
				slug: "a",
				status: "published",
				data: { title: "New A" },
			}),
		).resolves.toMatchObject({ success: true });

		await expect(redirects.findBySource("/blog/a")).resolves.toBeNull();
	});

	it("removes the auto-redirect when a draft is published at its source URL", async () => {
		const redirects = await createShadowingAutoRedirect();
		const draft = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "draft",
			data: { title: "Draft A" },
		});
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({ auto: true });

		await expect(handleContentPublish(db, "posts", draft.id)).resolves.toMatchObject({
			success: true,
		});
		await expect(redirects.findBySource("/blog/a")).resolves.toBeNull();
	});

	it("preserves a manual redirect when publishing at its source URL", async () => {
		const redirects = new RedirectRepository(db);
		await redirects.create({ source: "/blog/a", destination: "/manual" });

		await expect(
			handleContentCreate(db, "posts", {
				slug: "a",
				status: "published",
				data: { title: "A" },
			}),
		).resolves.toMatchObject({ success: true });
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({
			destination: "/manual",
			auto: false,
		});
	});

	it("does not remove an auto-redirect for non-published create or update", async () => {
		const redirects = await createShadowingAutoRedirect();
		const result = await handleContentCreate(db, "posts", {
			slug: "a",
			status: "draft",
			data: { title: "Draft A" },
		});
		expect(result.success).toBe(true);
		if (!result.success) return;
		const created = result.data.item;
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({ auto: true });

		await expect(
			handleContentUpdate(db, "posts", created.id, { data: { title: "Updated draft A" } }),
		).resolves.toMatchObject({ success: true });
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({ auto: true });
	});

	it("rolls back a published create when removing its shadowing redirect fails", async () => {
		const redirects = await createShadowingAutoRedirect();
		await blockAutoRedirectDeletes();

		await expect(
			handleContentCreate(db, "posts", {
				slug: "a",
				status: "published",
				data: { title: "New A" },
			}),
		).resolves.toMatchObject({ success: false });
		await expect(
			db.selectFrom("ec_posts").select("id").where("slug", "=", "a").execute(),
		).resolves.toEqual([]);
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({ auto: true });
	});

	it("rolls back an update-to-publish when removing its shadowing redirect fails", async () => {
		const redirects = await createShadowingAutoRedirect();
		const draft = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "draft",
			data: { title: "Draft A" },
		});
		await blockAutoRedirectDeletes();

		await expect(
			handleContentUpdate(db, "posts", draft.id, { status: "published" }),
		).resolves.toMatchObject({
			success: false,
		});
		await expect(new ContentRepository(db).findById("posts", draft.id)).resolves.toMatchObject({
			status: "draft",
		});
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({ auto: true });
	});

	it("rolls back a publish when removing its shadowing redirect fails", async () => {
		const redirects = await createShadowingAutoRedirect();
		const draft = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "draft",
			data: { title: "Draft A" },
		});
		await blockAutoRedirectDeletes();

		await expect(handleContentPublish(db, "posts", draft.id)).resolves.toMatchObject({
			success: false,
		});
		await expect(new ContentRepository(db).findById("posts", draft.id)).resolves.toMatchObject({
			status: "draft",
		});
		await expect(redirects.findBySource("/blog/a")).resolves.toMatchObject({ auto: true });
	});

	it("removes the auto-redirect when an update publishes a new entry", async () => {
		const redirects = new RedirectRepository(db);
		const entry = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "published",
			data: { title: "A" },
		});
		await handleContentUpdate(db, "posts", entry.id, { slug: "b" });
		const newEntry = await new ContentRepository(db).create({
			type: "posts",
			slug: "a",
			status: "draft",
			data: { title: "New A" },
		});

		await expect(
			handleContentUpdate(db, "posts", newEntry.id, { status: "published" }),
		).resolves.toMatchObject({
			success: true,
		});

		await expect(redirects.findBySource("/blog/a")).resolves.toBeNull();
	});
});
