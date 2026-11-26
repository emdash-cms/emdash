import { LiveEntryNotFoundError } from "astro/content/runtime";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../src/loader.js");
	const loader = emdashLoader();
	return {
		getLiveEntry: async (
			_name: string,
			filter: Parameters<NonNullable<typeof loader.loadEntry>>[0]["filter"],
		) => {
			const result = await loader.loadEntry!({ filter });
			if (result === undefined) {
				return {
					entry: undefined,
					error: new LiveEntryNotFoundError(filter.type, filter.id),
				};
			}
			if ("error" in result) return { entry: undefined, error: result.error };
			return { entry: result, error: undefined, cacheHint: result.cacheHint };
		},
	};
});

import { ContentRepository } from "../../src/database/repositories/content.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("getEmDashEntry without a locale", (dialect) => {
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

	async function load(idOrSlug: string) {
		const { entry } = await runWithContext({ editMode: false, db: ctx.db }, () =>
			getEmDashEntry("post", idOrSlug),
		);
		return entry?.data;
	}

	it.each([
		["aa", "draft"],
		["aa", "published"],
		["EN", "draft"],
		["EN", "published"],
	] as const)(
		"returns the default-locale entry when an older %s %s row shares its slug",
		async (locale, status) => {
			const other = await repo.create({
				type: "post",
				data: { title: "Other" },
				slug: "notes",
				locale,
				status,
			});
			await repo.create({
				type: "post",
				data: { title: "Outage notice" },
				slug: "outage-notice",
				status: "published",
			});
			await repo.update("post", other.id, { slug: "outage-notice" });

			expect(await load("outage-notice")).toMatchObject({
				title: "Outage notice",
				locale: "en",
			});
		},
	);

	it("returns the entry with a matching id before one whose slug is that id", async () => {
		const target = await repo.create({
			type: "post",
			data: { title: "Quarterly results" },
			slug: "quarterly-results",
			status: "published",
		});
		await repo.create({
			type: "post",
			data: { title: "Other" },
			slug: target.id,
			status: "published",
		});

		expect(await load(target.id)).toMatchObject({ title: "Quarterly results" });
	});

	it("returns a published entry in another locale over a default-locale draft", async () => {
		await repo.create({
			type: "post",
			data: { title: "Draft" },
			slug: "bonjour",
			status: "draft",
		});
		await repo.create({
			type: "post",
			data: { title: "Bonjour" },
			slug: "bonjour",
			locale: "fr",
			status: "published",
		});

		expect(await load("bonjour")).toMatchObject({ title: "Bonjour", locale: "fr" });
	});

	it("prefers the default locale's configured path over a legacy alias", async () => {
		setI18nConfig({
			defaultLocale: "english",
			locales: ["english", "fr"],
			localeAliases: { en: "english" },
		});
		await repo.create({
			type: "post",
			data: { title: "Legacy" },
			slug: "notice",
			locale: "en",
			status: "published",
		});
		const canonical = await repo.create({
			type: "post",
			data: { title: "Canonical" },
			slug: "notice-canonical",
			locale: "english",
			status: "published",
		});
		await sql`UPDATE ${sql.ref("ec_post")} SET slug = ${"notice"} WHERE id = ${canonical.id}`.execute(
			ctx.db,
		);

		expect(await load("notice")).toMatchObject({ title: "Canonical" });
	});

	it("prefers the configured default locale", async () => {
		setI18nConfig({ defaultLocale: "fr", locales: ["en", "fr"] });
		await repo.create({
			type: "post",
			data: { title: "Hello" },
			slug: "page",
			locale: "en",
			status: "published",
		});
		await repo.create({
			type: "post",
			data: { title: "Bonjour" },
			slug: "page",
			locale: "fr",
			status: "published",
		});

		expect(await load("page")).toMatchObject({ title: "Bonjour", locale: "fr" });
	});
});
