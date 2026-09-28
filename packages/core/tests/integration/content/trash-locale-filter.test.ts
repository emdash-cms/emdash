import { beforeEach, afterEach, expect, it } from "vitest";

import {
	handleContentCountTrashed,
	handleContentListTrashed,
} from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("trashed content locale scoping", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		repo = new ContentRepository(ctx.db);

		const en = await repo.create({
			type: "posts",
			slug: "hello-en",
			locale: "en",
			data: { title: "Hello" },
		});
		const fr = await repo.create({
			type: "posts",
			slug: "hello-fr",
			locale: "fr",
			translationOf: en.id,
			data: { title: "Bonjour" },
		});
		const de = await repo.create({
			type: "posts",
			slug: "hallo-de",
			locale: "de",
			data: { title: "Hallo" },
		});

		await repo.delete("posts", en.id);
		await repo.delete("posts", fr.id);
		await repo.delete("posts", de.id);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("lists only the trashed entries in the requested locale", async () => {
		const result = await handleContentListTrashed(ctx.db, "posts", { locale: "fr" });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.items.map((item) => item.slug)).toEqual(["hello-fr"]);
	});

	it("lists every locale when no locale is given", async () => {
		const result = await handleContentListTrashed(ctx.db, "posts", {});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(new Set(result.data.items.map((item) => item.slug))).toEqual(
			new Set(["hello-en", "hello-fr", "hallo-de"]),
		);
	});

	it("returns each item's locale so the trash list can display it", async () => {
		const result = await handleContentListTrashed(ctx.db, "posts", { locale: "de" });

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.items[0]?.locale).toBe("de");
	});

	it("counts only the trashed entries in the requested locale", async () => {
		const scoped = await handleContentCountTrashed(ctx.db, "posts", { locale: "en" });
		const all = await handleContentCountTrashed(ctx.db, "posts");

		expect(scoped.success && scoped.data.count).toBe(1);
		expect(all.success && all.data.count).toBe(3);
	});
});
