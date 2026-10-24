/**
 * Byline hydration on the folded fast path, end to end.
 *
 * `loader.ts` folds explicit credits and the author-fallback byline into the
 * content query; `hydrateEntryBylines` in query.ts resolves `data.bylines`
 * from them and loads only the custom-field values. Before, a site with any
 * registered byline custom field, or any entry with an author but no credit,
 * dropped the fold and re-resolved every entry through
 * `getBylinesForEntries`: two to four extra sequential queries per entry or
 * collection read, even for entries that have no byline at all.
 *
 * Each test runs `getEmDashEntry` / `getEmDashCollection` through the real
 * loader and asserts two things: the hydrated credits equal what the query
 * path (`getBylinesForEntries`) returns for the same entries, and the query
 * path was not taken.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resetBylineFieldDefsCacheForTests } from "../../src/bylines/field-defs-cache.js";
import { getBylinesForEntries } from "../../src/bylines/index.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { ContentBylineCredit } from "../../src/database/repositories/types.js";
import { UserRepository } from "../../src/database/repositories/user.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { emdashLoader } from "../../src/loader.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { BylineSchemaRegistry } from "../../src/schema/byline-registry.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveCollection, getLiveEntry } from "astro:content";

describeEachDialect("byline hydration on the fold fast path", (dialect) => {
	let ctx: DialectTestContext;
	// eslint-disable-next-line typescript/no-explicit-any -- schema type vs Database type
	let db: any;
	let bylines: BylineRepository;
	let content: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		bylines = new BylineRepository(db);
		content = new ContentRepository(db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		// Route the Astro live-content API to the real loader, so the fold SQL
		// and the hydration both run.
		const loader = emdashLoader();
		vi.mocked(getLiveEntry).mockImplementation(
			// eslint-disable-next-line typescript/no-explicit-any -- live-content filter shape
			(async (_name: string, filter: any) => {
				// Astro wraps the loader's entry as `{ entry, error, cacheHint }`.
				const result = await loader.loadEntry!({ filter });
				if (!result) return { entry: undefined, error: new Error("not found") };
				if ("error" in result) return { entry: undefined, error: result.error };
				return { entry: result, error: undefined, cacheHint: result.cacheHint ?? {} };
				// eslint-disable-next-line typescript/no-explicit-any -- minimal live-entry shape
			}) as any,
		);
		vi.mocked(getLiveCollection).mockImplementation(
			// eslint-disable-next-line typescript/no-explicit-any -- live-content filter shape
			(async (_name: string, filter: any) => loader.loadCollection!({ filter })) as any,
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setI18nConfig(null);
		resetBylineFieldDefsCacheForTests();
		await teardownForDialect(ctx);
	});

	/** A translatable and a group-shared custom field, so both value tables are read. */
	async function registerCustomFields() {
		const registry = new BylineSchemaRegistry(ctx.db);
		await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
		await registry.createField({
			slug: "twitter",
			label: "Twitter",
			type: "string",
			translatable: false,
		});
		resetBylineFieldDefsCacheForTests();
	}

	async function createUser(email: string) {
		return new UserRepository(db).create({ email, displayName: email, role: "editor" });
	}

	async function createPost(slug: string, opts: { locale?: string; authorId?: string } = {}) {
		const post = await content.create({
			type: "post",
			slug,
			data: { title: slug },
			locale: opts.locale ?? "en",
			authorId: opts.authorId,
		});
		await db
			.updateTable("ec_post")
			.set({ status: "published" })
			.where("id", "=", post.id)
			.execute();
		return content.findById("post", post.id);
	}

	/** What the query path resolves for the same entries. */
	async function queryPath(posts: Array<Awaited<ReturnType<typeof createPost>>>) {
		return runWithContext({ editMode: false, db }, () =>
			getBylinesForEntries(
				"post",
				posts.map((post) => ({
					id: post!.id,
					authorId: post!.authorId ?? null,
					primaryBylineId: post!.primaryBylineId ?? null,
					locale: post!.locale ?? null,
				})),
			),
		);
	}

	/** Spies on the query path's two reads; neither may run on the fold path. */
	function spyOnQueryPath() {
		return [
			vi.spyOn(BylineRepository.prototype, "getContentBylinesMany"),
			vi.spyOn(BylineRepository.prototype, "findByUserIds"),
		];
	}

	async function entryBylines(slug: string, locale = "en") {
		const { entry } = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", slug, { locale }),
		);
		expect(entry).toBeDefined();
		// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
		return (entry!.data as any).bylines as ContentBylineCredit[];
	}

	it("hydrates custom fields onto folded explicit credits without the query path", async () => {
		await registerCustomFields();
		const author = await bylines.create({
			displayName: "Ada Lovelace",
			slug: "ada",
			customFields: { job_title: "Editor", twitter: "@ada" },
		});
		const post = await createPost("explicit");
		await bylines.setContentBylines("post", post!.id, [
			{ bylineId: author.id, roleLabel: "Author" },
		]);
		const expected = (await queryPath([await content.findById("post", post!.id)])).get(post!.id);

		const spies = spyOnQueryPath();
		const credits = await entryBylines("explicit");

		expect(credits[0]?.byline.customFields).toEqual({ job_title: "Editor", twitter: "@ada" });
		expect(credits).toEqual(expected);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("resolves the author fallback from the fold, with custom fields", async () => {
		await registerCustomFields();
		const user = await createUser("fallback@example.com");
		await bylines.create({
			displayName: "Author Byline",
			slug: "author-byline",
			userId: user.id,
			locale: "en",
			customFields: { job_title: "Writer", twitter: "@author" },
		});
		const post = await createPost("fallback", { authorId: user.id });
		const expected = (await queryPath([post])).get(post!.id);

		const spies = spyOnQueryPath();
		const credits = await entryBylines("fallback");

		expect(credits).toHaveLength(1);
		expect(credits[0]?.source).toBe("inferred");
		expect(credits[0]?.byline.customFields).toEqual({ job_title: "Writer", twitter: "@author" });
		expect(credits).toEqual(expected);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("resolves no byline for an author whose byline is in another locale", async () => {
		const user = await createUser("other-locale@example.com");
		await bylines.create({
			displayName: "Auteur",
			slug: "auteur",
			userId: user.id,
			locale: "fr",
		});
		const post = await createPost("other-locale", { authorId: user.id });
		expect((await queryPath([post])).get(post!.id)).toEqual([]);

		const spies = spyOnQueryPath();
		expect(await entryBylines("other-locale")).toEqual([]);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("does not infer from authorId when the entry has explicit credits in another locale", async () => {
		const user = await createUser("sentinel@example.com");
		await bylines.create({ displayName: "Auteur", slug: "auteur", userId: user.id, locale: "fr" });
		const credited = await bylines.create({ displayName: "Marco", slug: "marco", locale: "en" });
		const post = await createPost("sentinel", { locale: "fr", authorId: user.id });
		await bylines.setContentBylines("post", post!.id, [{ bylineId: credited.id }]);
		const refreshed = await content.findById("post", post!.id);
		expect((await queryPath([refreshed])).get(post!.id)).toEqual([]);

		const spies = spyOnQueryPath();
		expect(await entryBylines("sentinel", "fr")).toEqual([]);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("matches aliased locale codes in the fold the way the query path does", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"], localeAliases: { "en-US": "en" } });
		await registerCustomFields();
		const user = await createUser("aliased@example.com");
		// The author has a byline under the configured path and one under its
		// code; the path wins on both paths.
		await bylines.create({
			displayName: "Path Byline",
			slug: "path-byline",
			userId: user.id,
			locale: "en",
			customFields: { job_title: "Writer" },
		});
		await bylines.create({
			displayName: "Code Byline",
			slug: "code-byline",
			userId: user.id,
			locale: "en-US",
		});
		// An explicit credit whose only translation is stamped with the code.
		const credited = await bylines.create({
			displayName: "Coded Credit",
			slug: "coded-credit",
			locale: "en-US",
			customFields: { twitter: "@coded" },
		});
		// Posts stamped with the code, as older versions wrote them.
		const explicit = await createPost("aliased-explicit", { locale: "en-US" });
		await bylines.setContentBylines("post", explicit!.id, [{ bylineId: credited.id }]);
		const posts = [
			await content.findById("post", explicit!.id),
			await createPost("aliased-fallback", { locale: "en-US", authorId: user.id }),
		];
		const expected = await queryPath(posts);
		expect(expected.get(posts[0]!.id)?.[0]?.byline.displayName).toBe("Coded Credit");
		expect(expected.get(posts[1]!.id)?.[0]?.byline.displayName).toBe("Path Byline");

		const spies = spyOnQueryPath();
		const { entries } = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { locale: "en" }),
		);

		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
			const data = entry.data as any;
			expect(data.bylines).toEqual(expected.get(data.id));
		}
		expect(await entryBylines("aliased-fallback")).toEqual(expected.get(posts[1]!.id));
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("skips custom-field hydration for a collection read with no bylines", async () => {
		await registerCustomFields();
		// A byline exists, so the fold's "no bylines anywhere" shortcut is off.
		await bylines.create({ displayName: "Unused", slug: "unused" });
		const user = await createUser("no-byline@example.com");
		await createPost("no-author");
		await createPost("author-without-byline", { authorId: user.id });

		const spies = [
			...spyOnQueryPath(),
			vi.spyOn(BylineRepository.prototype, "hydrateBylineCustomFields"),
		];
		const { entries } = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { locale: "en" }),
		);

		expect(entries).toHaveLength(2);
		for (const entry of entries) {
			// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
			expect((entry.data as any).bylines).toEqual([]);
			// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
			expect((entry.data as any).byline).toBeNull();
		}
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});

	it("hydrates a mixed collection in one custom-field pass, matching the query path", async () => {
		await registerCustomFields();
		const user = await createUser("mixed@example.com");
		await bylines.create({
			displayName: "Fallback",
			slug: "fallback",
			userId: user.id,
			locale: "en",
			customFields: { job_title: "Writer" },
		});
		const credited = await bylines.create({
			displayName: "Credited",
			slug: "credited",
			customFields: { twitter: "@credited" },
		});
		const explicit = await createPost("mixed-explicit", { authorId: user.id });
		await bylines.setContentBylines("post", explicit!.id, [{ bylineId: credited.id }]);
		const posts = [
			await content.findById("post", explicit!.id),
			await createPost("mixed-fallback", { authorId: user.id }),
			await createPost("mixed-none"),
		];
		const expected = await queryPath(posts);

		const spies = spyOnQueryPath();
		const hydrate = vi.spyOn(BylineRepository.prototype, "hydrateBylineCustomFields");
		const { entries } = await runWithContext({ editMode: false, db }, () =>
			getEmDashCollection("post", { locale: "en" }),
		);

		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			// eslint-disable-next-line typescript/no-explicit-any -- hydrated data is dynamically shaped
			const data = entry.data as any;
			expect(data.bylines).toEqual(expected.get(data.id));
		}
		expect(hydrate).toHaveBeenCalledTimes(1);
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	});
});
