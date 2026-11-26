import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { setI18nConfig } from "../../../../src/i18n/config.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";

describeEachDialect("ContentRepository slug lookup without a locale", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	async function createPair() {
		const en = await repo.create({
			type: "post",
			data: { title: "Press release" },
			slug: "press-release",
			locale: "en",
		});
		const de = await repo.create({
			type: "post",
			data: { title: "Pressemitteilung" },
			slug: "press-release",
			locale: "de",
		});
		return { en, de };
	}

	it("prefers the default locale over a locale code that sorts earlier", async () => {
		const { en } = await createPair();

		expect((await repo.findBySlug("post", "press-release"))?.id).toBe(en.id);
		expect((await repo.findByIdOrSlug("post", "press-release"))?.id).toBe(en.id);
		expect((await repo.findBySlugIncludingTrashed("post", "press-release"))?.id).toBe(en.id);
		expect(
			(await repo.findManyByIdOrSlug("post", ["press-release"])).get("press-release")?.id,
		).toBe(en.id);
	});

	it("prefers the configured default locale", async () => {
		setI18nConfig({ defaultLocale: "de", locales: ["de", "en"] });
		const { de } = await createPair();

		expect((await repo.findBySlug("post", "press-release"))?.id).toBe(de.id);
		expect(
			(await repo.findManyByIdOrSlug("post", ["press-release"])).get("press-release")?.id,
		).toBe(de.id);
	});

	it("does not treat a differently cased locale as the default", async () => {
		const upper = await repo.create({
			type: "post",
			data: { title: "Upper" },
			slug: "notice",
			locale: "EN",
		});
		const en = await repo.create({
			type: "post",
			data: { title: "Notice" },
			slug: "notice",
			locale: "en",
		});

		expect(upper.locale).toBe("EN");
		expect((await repo.findBySlug("post", "notice"))?.id).toBe(en.id);
	});

	it("prefers a trashed row when trashed rows are included", async () => {
		const { en, de } = await createPair();
		await repo.delete("post", de.id);

		expect((await repo.findBySlugIncludingTrashed("post", "press-release"))?.id).toBe(de.id);
		expect((await repo.findBySlug("post", "press-release"))?.id).toBe(en.id);
	});

	it("prefers the default locale's configured path over a legacy alias", async () => {
		setI18nConfig({
			defaultLocale: "english",
			locales: ["english", "fr"],
			localeAliases: { en: "english" },
		});
		const legacy = await repo.create({
			type: "post",
			data: { title: "Legacy" },
			slug: "notice",
			locale: "en",
		});
		const canonical = await repo.create({
			type: "post",
			data: { title: "Canonical" },
			slug: "notice-canonical",
			locale: "english",
		});
		await sql`UPDATE ${sql.ref("ec_post")} SET slug = ${"notice"} WHERE id = ${canonical.id}`.execute(
			ctx.db,
		);

		expect(legacy.locale).toBe("en");
		expect((await repo.findBySlug("post", "notice"))?.id).toBe(canonical.id);
		expect((await repo.findManyByIdOrSlug("post", ["notice"])).get("notice")?.id).toBe(
			canonical.id,
		);
	});

	it("still finds a slug that exists only in another locale", async () => {
		const fr = await repo.create({
			type: "post",
			data: { title: "Bonjour" },
			slug: "bonjour",
			locale: "fr",
		});

		expect((await repo.findBySlug("post", "bonjour"))?.id).toBe(fr.id);
	});
});
