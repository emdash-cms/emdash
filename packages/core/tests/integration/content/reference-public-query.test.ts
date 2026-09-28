/**
 * Site code reads an entry's references.
 *
 * `getEmDashEntry(..., { references })` resolves each selected field to real
 * entries — the same shape a direct read of the target collection returns — and
 * `getEmDashReferences` walks past the first page. What these tests pin is the
 * behaviour a template depends on: link order, the locale variant chosen, what
 * an anonymous render is allowed to see, and that a caller who asks for nothing
 * pays for nothing.
 */

import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { getEmDashEntry, getEmDashReferences } from "../../../src/query.js";
import { resolveReferencePages } from "../../../src/references/resolve.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveEntry } from "astro:content";

/** Records the SQL a render issues, so reference resolution's cost is pinned. */
class QueryRecorder implements KyselyPlugin {
	statements: string[] = [];

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.statements.push(args.node.kind);
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

describeEachDialect("public reference queries", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;

		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "pages", label: "Pages", labelSingular: "Page" });
		await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
		await registry.createField("pages", { slug: "featured", label: "Featured", type: "boolean" });
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const relations = new RelationRepository(db);
		await relations.create({
			slug: "posts_related_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Related pages",
		});
		await registry.createField("posts", {
			slug: "related_pages",
			label: "Related pages",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});
		// The inverse: a page lists the posts that point at it.
		await registry.createField("pages", {
			slug: "linking_posts",
			label: "Linking posts",
			type: "reference",
			validation: {
				relation: "posts_related_pages",
				relationSide: "child",
				targetCollection: "posts",
			},
		});

		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.mocked(getLiveEntry).mockReset();
	});

	async function createPage(
		title: string,
		options: { publish?: boolean; featured?: boolean } = {},
	) {
		const slug = title.toLowerCase().replaceAll(" ", "-");
		const result = await handleContentCreate(db, "pages", {
			data: { title, featured: options.featured ?? false },
			slug,
		});
		if (!result.success) throw new Error(`Page setup failed: ${result.error.message}`);
		if (options.publish !== false) {
			const published = await runtime.handleContentPublish("pages", result.data.item.id);
			if (!published.success) throw new Error("Page publish failed");
		}
		return result.data.item;
	}

	async function createPost(title: string, pageIds: string[]) {
		const created = await runtime.handleContentCreate("posts", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			references: { related_pages: pageIds },
		});
		if (!created.success || !created.data) throw new Error("Post setup failed");
		const published = await runtime.handleContentPublish("posts", created.data.item.id);
		if (!published.success) throw new Error("Post publish failed");
		return created.data.item;
	}

	async function groupOf(collection: string, id: string): Promise<string> {
		const item = await new ContentRepository(db).findById(collection, id);
		if (!item?.translationGroup) throw new Error(`${collection}/${id} has no translation group`);
		return item.translationGroup;
	}

	/** Resolve as an anonymous render would, inside a request context bound to the test db. */
	function resolvePublic(
		collection: string,
		entryGroup: string,
		selection: Record<string, true | { limit?: number; cursor?: string }>,
		overrides: { serveDrafts?: boolean; draftRevisionId?: string; locale?: string | null } = {},
	) {
		return runWithContext({ editMode: false, db }, () =>
			resolveReferencePages({
				collection,
				entryGroup,
				locale: overrides.locale === undefined ? "en" : overrides.locale,
				draftRevisionId: overrides.draftRevisionId,
				serveDrafts: overrides.serveDrafts ?? false,
				selection,
			}),
		);
	}

	it("resolves a parent-side field in link order", async () => {
		const first = await createPage("Page One");
		const second = await createPage("Page Two");
		const post = await createPost("Hello", [second.id, first.id]);

		const pages = await resolvePublic("posts", await groupOf("posts", post.id), {
			related_pages: true,
		});

		expect(pages.related_pages?.collection).toBe("pages");
		expect(pages.related_pages?.entries.map((entry) => entry.slug)).toEqual([
			"page-two",
			"page-one",
		]);
	});

	it("gives a referenced entry the same data shape as a direct read", async () => {
		const page = await createPage("Page One", { featured: true });
		const post = await createPost("Hello", [page.id]);

		const pages = await resolvePublic("posts", await groupOf("posts", post.id), {
			related_pages: true,
		});

		const child = pages.related_pages?.entries[0];
		expect(child?.id).toBe("page-one");
		expect(child?.data.slug).toBe("page-one");
		expect(child?.data.title).toBe("Page One");
		// Booleans and dates are mapped, not handed back as raw column values —
		// a referenced entry renders through the same template as a direct one.
		expect(child?.data.featured).toBe(true);
		expect(child?.data.createdAt).toBeInstanceOf(Date);
	});

	it("hides an unpublished target from a public render and shows it to a draft render", async () => {
		const draftPage = await createPage("Page One", { publish: false });
		const post = await createPost("Hello", [draftPage.id]);
		const group = await groupOf("posts", post.id);

		const anonymous = await resolvePublic("posts", group, { related_pages: true });
		expect(anonymous.related_pages?.entries).toEqual([]);

		const preview = await resolvePublic(
			"posts",
			group,
			{ related_pages: true },
			{
				serveDrafts: true,
			},
		);
		expect(preview.related_pages?.entries.map((entry) => entry.slug)).toEqual(["page-one"]);
	});

	it("resolves a child-side field to the entries pointing at it", async () => {
		const page = await createPage("Page One");
		const post = await createPost("Hello", [page.id]);

		const pages = await resolvePublic("pages", await groupOf("pages", page.id), {
			linking_posts: true,
		});

		expect(pages.linking_posts?.collection).toBe("posts");
		expect(pages.linking_posts?.entries.map((entry) => entry.slug)).toEqual([post.slug]);
	});

	it("prefers a staged selection only when the render may see drafts", async () => {
		const published = await createPage("Page One");
		const staged = await createPage("Page Two");
		const post = await createPost("Hello", [published.id]);

		const updated = await runtime.handleContentUpdate("posts", post.id, {
			references: { related_pages: [staged.id] },
		});
		if (!updated.success) throw new Error("Post update failed");

		const row = await new ContentRepository(db).findById("posts", post.id);
		const draftRevisionId = row?.draftRevisionId ?? undefined;
		expect(draftRevisionId).toBeTruthy();
		const group = await groupOf("posts", post.id);

		const anonymous = await resolvePublic(
			"posts",
			group,
			{ related_pages: true },
			{
				draftRevisionId,
			},
		);
		expect(anonymous.related_pages?.entries.map((entry) => entry.slug)).toEqual(["page-one"]);

		const preview = await resolvePublic(
			"posts",
			group,
			{ related_pages: true },
			{
				draftRevisionId,
				serveDrafts: true,
			},
		);
		expect(preview.related_pages?.entries.map((entry) => entry.slug)).toEqual(["page-two"]);
	});

	it("pages a selection and walks it with the cursor it returns", async () => {
		const pageIds: string[] = [];
		for (const title of ["Page One", "Page Two", "Page Three"]) {
			pageIds.push((await createPage(title)).id);
		}
		const post = await createPost("Hello", pageIds);
		const group = await groupOf("posts", post.id);

		const first = await resolvePublic("posts", group, { related_pages: { limit: 2 } });
		expect(first.related_pages?.entries.map((entry) => entry.slug)).toEqual([
			"page-one",
			"page-two",
		]);
		expect(first.related_pages?.nextCursor).toBeTruthy();

		const second = await runWithContext({ editMode: false, db }, () =>
			getEmDashReferences("posts", post.id, "related_pages", {
				limit: 2,
				cursor: first.related_pages!.nextCursor,
			}),
		);
		expect(second.entries.map((entry) => entry.id)).toEqual(["page-three"]);
		expect(second.nextCursor).toBeUndefined();
	});

	it("costs one field-map read, one link read per field, and one read per target collection", async () => {
		const page = await createPage("Page One");
		const post = await createPost("Hello", [page.id]);
		const postGroup = await groupOf("posts", post.id);

		// A second parent-side field on the same collection, pointing at the same
		// target, so the extra cost of a second field is isolated from entry reads.
		await new RelationRepository(db).create({
			slug: "posts_further_pages",
			parentCollection: "posts",
			childCollection: "pages",
			parentLabel: "Posts",
			childLabel: "Further pages",
		});
		await new SchemaRegistry(db).createField("posts", {
			slug: "further_pages",
			label: "Further pages",
			type: "reference",
			validation: {
				relation: "posts_further_pages",
				relationSide: "parent",
				targetCollection: "pages",
			},
		});

		const recorder = new QueryRecorder();
		const counted = db.withPlugin(recorder);

		await runWithContext({ editMode: false, db: counted }, () =>
			resolveReferencePages({
				collection: "posts",
				entryGroup: postGroup,
				locale: "en",
				serveDrafts: false,
				selection: { related_pages: true },
			}),
		);
		const oneField = recorder.statements.length;

		recorder.statements = [];
		await runWithContext({ editMode: false, db: counted }, () =>
			resolveReferencePages({
				collection: "posts",
				entryGroup: postGroup,
				locale: "en",
				serveDrafts: false,
				selection: { related_pages: true, further_pages: true },
			}),
		);
		const twoFields = recorder.statements.length;

		// Field map + one link read + one entry read; the second field adds only
		// its own link read, since both fields share the map and the target read.
		expect({ oneField, twoFields }).toEqual({ oneField: 3, twoFields: 4 });
	});

	it("survives a cursor issued by the other side of the preview boundary", async () => {
		const pages = [await createPage("Page One"), await createPage("Page Two")];
		const third = await createPage("Page Three");
		const post = await createPost(
			"Hello",
			pages.map((page) => page.id),
		);
		const group = await groupOf("posts", post.id);

		// Stage a change so a preview render pages the staged selection.
		await runtime.handleContentUpdate("posts", post.id, {
			references: { related_pages: [pages[0]!.id, pages[1]!.id, third.id] },
		});
		const draftRevisionId = (await new ContentRepository(db).findById("posts", post.id))
			?.draftRevisionId;
		expect(draftRevisionId).toBeTruthy();

		const preview = await resolvePublic(
			"posts",
			group,
			{ related_pages: { limit: 2 } },
			{ serveDrafts: true, draftRevisionId },
		);
		const stagedCursor = preview.related_pages?.nextCursor;
		expect(stagedCursor).toBeTruthy();

		// The draft publishes (or the preview session ends) and the same cursor
		// comes back on a public render, which reads links rather than the draft.
		const promoted = await runtime.handleContentPublish("posts", post.id);
		expect(promoted.success).toBe(true);

		const published = await resolvePublic(
			"posts",
			group,
			{ related_pages: { limit: 2, cursor: stagedCursor } },
			{ serveDrafts: false },
		);
		expect(published.related_pages?.entries.map((entry) => entry.slug)).toEqual(["page-three"]);
	});

	it("returns an empty page for an unknown field", async () => {
		const post = await createPost("Hello", []);
		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashReferences("posts", post.id, "not_a_field"),
		);
		expect(result.entries).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("walks a page of a non-default locale's entry, whose id carries its locale", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		try {
			const page = await createPage("Page One");
			const source = await createPost("Hello", [page.id]);
			const translation = await handleContentCreate(db, "posts", {
				data: { title: "Bonjour" },
				slug: "bonjour",
				locale: "fr",
				translationOf: source.id,
			});
			if (!translation.success) throw new Error("Translation setup failed");
			const published = await runtime.handleContentPublish("posts", translation.data.item.id);
			expect(published.success).toBe(true);

			// The id a referenced entry carries in a prefixed locale, as
			// `entryIdForRow` builds it — what the documented example passes back in.
			const result = await runWithContext({ editMode: false, db }, () =>
				getEmDashReferences("posts", "fr/bonjour", "related_pages"),
			);
			expect(result.entries.map((entry) => entry.data.title)).toEqual(["Page One"]);
		} finally {
			setI18nConfig(null);
		}
	});

	async function translatePage(pageId: string, title: string, locale: string) {
		const result = await handleContentCreate(db, "pages", {
			data: { title },
			slug: title.toLowerCase().replaceAll(" ", "-"),
			locale,
			translationOf: pageId,
		});
		if (!result.success) throw new Error(`Translation setup failed: ${result.error.message}`);
		const published = await runtime.handleContentPublish("pages", result.data.item.id);
		if (!published.success) throw new Error("Translation publish failed");
	}

	it("falls back along the site's locale chain, not to the lowest locale code", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de"], fallback: { fr: "en" } });
		try {
			const page = await createPage("English Page");
			await translatePage(page.id, "Deutsche Seite", "de");
			const post = await createPost("Hello", [page.id]);

			const result = await resolvePublic(
				"posts",
				await groupOf("posts", post.id),
				{ related_pages: true },
				{ locale: "fr" },
			);
			expect(result.related_pages?.entries.map((entry) => entry.data.title)).toEqual([
				"English Page",
			]);
		} finally {
			setI18nConfig(null);
		}
	});

	it("still resolves a target that exists only outside the locale chain", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de"], fallback: { fr: "en" } });
		try {
			const page = await handleContentCreate(db, "pages", {
				data: { title: "Deutsche Seite" },
				slug: "deutsche-seite",
				locale: "de",
			});
			if (!page.success) throw new Error("Page setup failed");
			const published = await runtime.handleContentPublish("pages", page.data.item.id);
			if (!published.success) throw new Error("Page publish failed");
			const post = await createPost("Hello", [page.data.item.id]);

			const result = await resolvePublic(
				"posts",
				await groupOf("posts", post.id),
				{ related_pages: true },
				{ locale: "fr" },
			);
			expect(result.related_pages?.entries.map((entry) => entry.data.title)).toEqual([
				"Deutsche Seite",
			]);
		} finally {
			setI18nConfig(null);
		}
	});

	it("names the rows a standalone page read, so a cached route can tag them", async () => {
		const pages = [await createPage("Page One"), await createPage("Page Two")];
		const post = await createPost(
			"Hello",
			pages.map((page) => page.id),
		);

		const result = await runWithContext({ editMode: false, db }, () =>
			getEmDashReferences("posts", post.id, "related_pages"),
		);

		expect(result.entries).toHaveLength(2);
		expect(result.cacheHint?.tags).toEqual(expect.arrayContaining(pages.map((page) => page.id)));
		// The newest child, so a write to any of them moves the route's header.
		const repo = new ContentRepository(db);
		const stamps = await Promise.all(
			pages.map(async (page) => {
				const row = await repo.findById("pages", page.id);
				return new Date(row!.updatedAt!).getTime();
			}),
		);
		expect(result.cacheHint?.lastModified?.getTime()).toBe(Math.max(...stamps));
	});

	it("attaches the selected fields to a loaded entry and nothing otherwise", async () => {
		const page = await createPage("Page One");
		const post = await createPost("Hello", [page.id]);
		const group = await groupOf("posts", post.id);

		vi.mocked(getLiveEntry).mockResolvedValue({
			entry: {
				id: post.slug,
				data: {
					id: post.id,
					slug: post.slug,
					title: "Hello",
					status: "published",
					locale: "en",
					translationGroup: group,
				},
			},
			cacheHint: {},
		});

		const withRefs = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("posts", post.slug, { references: { related_pages: true } }),
		);
		expect(
			withRefs.entry?.references?.related_pages?.entries.map((entry) => entry.data.title),
		).toEqual(["Page One"]);

		const without = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("posts", post.slug),
		);
		expect(without.entry?.references).toBeUndefined();
	});
});
