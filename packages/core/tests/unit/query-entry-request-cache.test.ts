import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import { RelationRepository } from "../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { emdashLoader } from "../../src/loader.js";
import { getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { createPostFixture } from "../utils/fixtures.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

vi.mock("astro:content", () => ({ getLiveEntry: vi.fn() }));

import { getLiveEntry } from "astro:content";

type Entry = { data: { title?: string; locale?: string; draftRevisionId?: string } };

function countQueries(db: DialectTestContext["db"]): {
	db: DialectTestContext["db"];
	get: () => number;
} {
	let count = 0;
	const counted = db.withPlugin({
		transformQuery(args) {
			count += 1;
			return args.node;
		},
		async transformResult(args) {
			return args.result;
		},
	});
	return { db: counted, get: () => count };
}

describeEachDialect("getEmDashEntry request cache", (dialect) => {
	let ctx: DialectTestContext;
	let content: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		content = new ContentRepository(ctx.db);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const loader = emdashLoader();
		vi.mocked(getLiveEntry).mockImplementation(async (_name, filter) => {
			const entry = await loader.loadEntry!({ filter });
			if (entry && "error" in entry) return { entry: undefined, error: entry.error };
			return { entry: entry ?? undefined, cacheHint: entry?.cacheHint ?? {} };
		});
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	async function published(slug: string, label: string, locale = "en") {
		const created = await content.create(
			createPostFixture({ slug, locale, data: { title: label }, status: "draft" }),
		);
		return content.publish("post", created.id);
	}

	function title(result: { entry: Entry | null }) {
		return result.entry?.data.title;
	}

	it("does no additional work for sequential identical reads", async () => {
		await published("cached-entry", "Cached");
		const counted = countQueries(ctx.db);

		const results = await runWithContext({ db: counted.db, editMode: false }, async () => {
			const first = await getEmDashEntry("post", "cached-entry");
			const beforeSecond = counted.get();
			const second = await getEmDashEntry("post", "cached-entry");
			return { first, second, additional: counted.get() - beforeSecond };
		});

		expect(title(results.first)).toBe("Cached");
		expect(title(results.second)).toBe("Cached");
		expect(results.additional).toBe(0);
	});

	it("shares one loader query between concurrent duplicate reads", async () => {
		await published("single-entry", "Single");
		await published("concurrent-entry", "Concurrent");
		await runWithContext({ db: ctx.db, editMode: false }, () =>
			getEmDashEntry("post", "single-entry"),
		);
		const single = countQueries(ctx.db);
		const one = await runWithContext({ db: single.db, editMode: false }, () =>
			getEmDashEntry("post", "single-entry"),
		);
		const singleQueries = single.get();

		const counted = countQueries(ctx.db);
		const results = await runWithContext({ db: counted.db, editMode: false }, () =>
			Promise.all([
				getEmDashEntry("post", "concurrent-entry"),
				getEmDashEntry("post", "concurrent-entry"),
			]),
		);

		expect(title(one)).toBe("Single");
		expect(results.map(title)).toEqual(["Concurrent", "Concurrent"]);
		expect(singleQueries).toBeGreaterThan(0);
		expect(counted.get()).toBe(singleQueries);
	});

	it("keeps different ids and locales separate", async () => {
		await published("same-slug", "English", "en");
		await published("same-slug", "Français", "fr");
		await published("other-slug", "Other", "en");

		const results = await runWithContext({ db: ctx.db, editMode: false }, async () => [
			await getEmDashEntry("post", "same-slug", { locale: "en" }),
			await getEmDashEntry("post", "same-slug", { locale: "fr" }),
			await getEmDashEntry("post", "other-slug", { locale: "en" }),
		]);
		expect(results.map(title)).toEqual(["English", "Français", "Other"]);
	});

	it.each(["edit", "preview"])("deduplicates %s reads without losing draft data", async (mode) => {
		const live = await published("draft-entry", "Live");
		const revision = await new RevisionRepository(ctx.db).create({
			collection: "post",
			entryId: live.id,
			data: { title: "Draft" },
		});
		await content.setDraftRevision("post", live.id, revision.id);
		const counted = countQueries(ctx.db);

		const result = await runWithContext(
			{
				db: counted.db,
				editMode: mode === "edit",
				preview: mode === "preview" ? { collection: "post", id: live.id } : undefined,
			},
			async () => {
				const first = await getEmDashEntry("post", "draft-entry");
				const beforeSecond = counted.get();
				const second = await getEmDashEntry("post", "draft-entry");
				return { first, second, additional: counted.get() - beforeSecond };
			},
		);

		expect(title(result.first)).toBe("Draft");
		expect(title(result.second)).toBe("Draft");
		expect(result.first.entry?.data.draftRevisionId).toBe(revision.id);
		expect(result.additional).toBe(0);
		const publicResult = await runWithContext({ db: ctx.db, editMode: false }, () =>
			getEmDashEntry("post", "draft-entry"),
		);
		expect(title(publicResult)).toBe("Live");
		expect(publicResult.isPreview).toBe(false);
	});

	it("retries after a rejected read", async () => {
		await published("retry", "Recovered");
		vi.mocked(getLiveEntry).mockRejectedValueOnce(new Error("Temporary failure"));
		await runWithContext({ db: ctx.db, editMode: false }, async () => {
			await expect(getEmDashEntry("post", "retry")).rejects.toThrow("Temporary failure");
			expect(title(await getEmDashEntry("post", "retry"))).toBe("Recovered");
		});
	});

	it("reads again in a fresh request", async () => {
		await published("fresh", "Before");
		const read = () =>
			runWithContext({ db: ctx.db, editMode: false }, () => getEmDashEntry("post", "fresh"));
		expect(title(await read())).toBe("Before");
		await ctx.db
			.updateTable("ec_post")
			.set({ title: "After" })
			.where("slug", "=", "fresh")
			.execute();
		expect(title(await read())).toBe("After");
	});

	it("shares equivalent context and explicit locale reads", async () => {
		await published("localized", "English");
		const counted = countQueries(ctx.db);
		await runWithContext({ db: counted.db, editMode: false, locale: "en" }, async () => {
			expect(title(await getEmDashEntry("post", "localized"))).toBe("English");
			const before = counted.get();
			expect(title(await getEmDashEntry("post", "localized", { locale: "en" }))).toBe("English");
			expect(counted.get()).toBe(before);
		});
	});

	it("separates collections and reference pages while canonicalizing selection keys", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await new RelationRepository(ctx.db).create({
			slug: "post_related_pages",
			parentCollection: "post",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Pages",
		});
		await registry.createField("post", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: "post_related_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});
		const parent = await published("same", "Post");
		for (const slug of ["same", "second"]) {
			const page = await content.create({ type: "pages", slug, data: { title: slug } });
			await content.publish("pages", page.id);
			await new RelationRepository(ctx.db).addReference(
				"post_related_pages",
				parent.translationGroup!,
				page.translationGroup!,
			);
		}
		const counted = countQueries(ctx.db);
		await runWithContext({ db: counted.db, editMode: false }, async () => {
			expect(title(await getEmDashEntry("post", "same"))).toBe("Post");
			expect(title(await getEmDashEntry("pages", "same"))).toBe("same");
			const narrow = await getEmDashEntry("post", "same", {
				references: { related_pages: { limit: 1 }, missing: true },
			});
			expect(narrow.entry?.references?.related_pages.entries).toHaveLength(1);
			const wide = await getEmDashEntry("post", "same", {
				references: { related_pages: { limit: 2 }, missing: true },
			});
			expect(wide.entry?.references?.related_pages.entries).toHaveLength(2);
			const before = counted.get();
			const reordered = await getEmDashEntry("post", "same", {
				references: { missing: true, related_pages: { limit: 2 } },
			});
			expect(reordered.entry?.references?.related_pages.entries).toHaveLength(2);
			expect(counted.get()).toBe(before);
		});
	});
});
