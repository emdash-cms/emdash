import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentGet,
	handleContentGetIncludingTrashed,
} from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const refuse = { refuseAmbiguousSlug: true };

describeEachDialect("content lookup for writes by slug", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function create(slug: string, locale: string) {
		return repo.create({ type: "post", data: { title: `${slug} ${locale}` }, slug, locale });
	}

	it("refuses a slug shared by more than one locale unless a locale is given", async () => {
		const de = await create("presse", "de");
		const en = await create("presse", "en");

		const ambiguous = await handleContentGet(
			ctx.db,
			"post",
			"presse",
			undefined,
			undefined,
			refuse,
		);
		expect(ambiguous).toMatchObject({ success: false, error: { code: "AMBIGUOUS_LOCALE" } });
		if (!ambiguous.success) expect(ambiguous.error.message).toContain("de, en");

		const scoped = await handleContentGet(ctx.db, "post", "presse", "de", undefined, refuse);
		expect(scoped.success && scoped.data.item.id).toBe(de.id);

		const byId = await handleContentGet(ctx.db, "post", de.id, undefined, undefined, refuse);
		expect(byId.success && byId.data.item.id).toBe(de.id);

		const read = await handleContentGet(ctx.db, "post", "presse");
		expect(read.success && read.data.item.id).toBe(en.id);
	});

	it("resolves a slug that exists in one locale", async () => {
		const de = await create("presse", "de");

		const result = await handleContentGet(ctx.db, "post", "presse", undefined, undefined, refuse);
		expect(result.success && result.data.item.id).toBe(de.id);
	});

	it("ignores trashed rows when resolving a live entry", async () => {
		const de = await create("presse", "de");
		const en = await create("presse", "en");
		await repo.delete("post", en.id);

		const result = await handleContentGet(ctx.db, "post", "presse", undefined, undefined, refuse);
		expect(result.success && result.data.item.id).toBe(de.id);
	});

	it("resolves the trashed entry for a restore when another locale is live", async () => {
		const de = await create("presse", "de");
		await create("presse", "en");
		await repo.delete("post", de.id);

		const result = await handleContentGetIncludingTrashed(
			ctx.db,
			"post",
			"presse",
			undefined,
			refuse,
		);
		expect(result.success && result.data.item.id).toBe(de.id);
	});

	it("refuses a restore by slug when trashed rows share it in more than one locale", async () => {
		const de = await create("presse", "de");
		const en = await create("presse", "en");
		await repo.delete("post", de.id);
		await repo.delete("post", en.id);

		const result = await handleContentGetIncludingTrashed(
			ctx.db,
			"post",
			"presse",
			undefined,
			refuse,
		);
		expect(result).toMatchObject({ success: false, error: { code: "AMBIGUOUS_LOCALE" } });

		const scoped = await handleContentGetIncludingTrashed(ctx.db, "post", "presse", "en", refuse);
		expect(scoped.success && scoped.data.item.id).toBe(en.id);
	});
});
