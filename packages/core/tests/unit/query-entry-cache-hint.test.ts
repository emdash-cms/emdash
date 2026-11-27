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
import { createPostFixture } from "../utils/fixtures.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("getEmDashEntry cache hint", (dialect) => {
	let ctx: DialectTestContext;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		contentRepo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	function read(slug: string, editMode = false, locale?: string) {
		return runWithContext({ db: ctx.db, editMode }, () =>
			getEmDashEntry("post", slug, locale ? { locale } : undefined),
		);
	}

	it("tags a found entry with its id and not the collection", async () => {
		const created = await contentRepo.create(
			createPostFixture({ slug: "found", data: { title: "Found" }, status: "draft" }),
		);
		await contentRepo.publish("post", created.id);

		const result = await read("found");

		expect(result.entry).not.toBeNull();
		expect(result.cacheHint.tags).toEqual([created.id]);
		expect(result.cacheHint.tags).not.toContain("post");
	});

	it("tags a miss with the collection", async () => {
		const result = await read("missing");

		expect(result.entry).toBeNull();
		expect(result.cacheHint.tags).toEqual(["post"]);
	});

	it("tags an unpublished entry's public miss with the collection", async () => {
		await contentRepo.create(
			createPostFixture({ slug: "draft-only", data: { title: "Draft" }, status: "draft" }),
		);

		const result = await read("draft-only");

		expect(result.entry).toBeNull();
		expect(result.cacheHint.tags).toEqual(["post"]);
	});

	it("tags a miss in edit mode with the collection", async () => {
		const result = await read("missing", true);

		expect(result.entry).toBeNull();
		expect(result.cacheHint.tags).toEqual(["post"]);
	});

	it("tags an entry served from a fallback locale with the collection", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const created = await contentRepo.create(
			createPostFixture({ slug: "hello", data: { title: "Hello" }, status: "draft", locale: "en" }),
		);
		await contentRepo.publish("post", created.id);

		const fallback = await read("hello", false, "fr");
		const direct = await read("hello", false, "en");

		expect(fallback.fallbackLocale).toBe("en");
		expect(fallback.cacheHint.tags).toEqual(expect.arrayContaining([created.id, "post"]));
		expect(direct.fallbackLocale).toBeUndefined();
		expect(direct.cacheHint.tags).toEqual([created.id]);
	});

	it("tags an entry stored under a locale alias with the collection", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], localeAliases: { "en-US": "en" } });
		const legacy = await contentRepo.create(
			createPostFixture({
				slug: "hello",
				data: { title: "Legacy" },
				status: "draft",
				locale: "en-US",
			}),
		);
		await contentRepo.publish("post", legacy.id);

		const aliased = await read("hello", false, "en");

		expect(aliased.entry?.data.id).toBe(legacy.id);
		expect(aliased.fallbackLocale).toBeUndefined();
		expect(aliased.cacheHint.tags).toEqual(expect.arrayContaining([legacy.id, "post"]));

		// Legacy data can hold both spellings; the repository refuses to create that state.
		const canonical = await contentRepo.create(
			createPostFixture({
				slug: "hello-canonical",
				data: { title: "Canonical" },
				status: "draft",
				locale: "en",
			}),
		);
		await contentRepo.publish("post", canonical.id);
		await sql`UPDATE ${sql.ref("ec_post")} SET slug = ${"hello"} WHERE id = ${canonical.id} AND locale = ${"en"}`.execute(
			ctx.db,
		);

		const direct = await read("hello", false, "en");

		expect(direct.entry?.data.id).toBe(canonical.id);
		expect(direct.cacheHint.tags).toEqual([canonical.id]);
	});

	it("tags an unscoped hit outside the default locale with the collection", async () => {
		const french = await contentRepo.create(
			createPostFixture({
				slug: "page",
				data: { title: "Bonjour" },
				status: "draft",
				locale: "fr",
			}),
		);
		await contentRepo.publish("post", french.id);
		const english = await contentRepo.create(
			createPostFixture({ slug: "page", data: { title: "Hello" }, status: "draft", locale: "en" }),
		);

		const result = await read("page");

		expect(result.entry?.data.id).toBe(french.id);
		expect(result.cacheHint.tags).toEqual(expect.arrayContaining([french.id, "post"]));

		await contentRepo.publish("post", english.id);
		const after = await read("page");

		expect(after.entry?.data.id).toBe(english.id);
		expect(after.cacheHint.tags).toEqual([english.id]);
	});
});
