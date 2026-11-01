import { LiveEntryNotFoundError } from "astro/content/runtime";
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
import { RevisionRepository } from "../../src/database/repositories/revision.js";
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

describeEachDialect("preview staged slugs", (dialect) => {
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

	async function publishedEntry(slug: string, title: string) {
		const created = await contentRepo.create(
			createPostFixture({ slug, data: { title }, status: "draft" }),
		);
		return contentRepo.publish("post", created.id);
	}

	async function addDraft(entryId: string, data: Record<string, unknown>) {
		const revision = await new RevisionRepository(ctx.db).create({
			collection: "post",
			entryId,
			data,
		});
		await contentRepo.setDraftRevision("post", entryId, revision.id);
	}

	function read(
		id: string,
		preview?: { collection: string; id: string },
		options: { editMode?: boolean; locale?: string } = {},
	) {
		return runWithContext({ db: ctx.db, editMode: options.editMode ?? false, preview }, () =>
			getEmDashEntry("post", id, { locale: options.locale }),
		);
	}

	it("resolves a staged slug to the draft while retaining the old public slug", async () => {
		const row = await publishedEntry("old-slug", "Published");
		await addDraft(row.id, { _slug: "new-slug", title: "Draft" });

		const preview = await read("new-slug", { collection: "post", id: row.id });
		expect(preview.entry).toMatchObject({ data: { slug: "new-slug", title: "Draft" } });
		expect(preview.isPreview).toBe(true);

		const oldSlugPreview = await read("old-slug", { collection: "post", id: row.id });
		expect(oldSlugPreview.entry).toMatchObject({ data: { slug: "new-slug", title: "Draft" } });

		const publicNewSlug = await read("new-slug");
		expect(publicNewSlug.entry).toBeNull();
		const publicOldSlug = await read("old-slug");
		expect(publicOldSlug.entry).toMatchObject({ data: { slug: "old-slug", title: "Published" } });
	});

	it("does not use a preview token to expose another entry or collection", async () => {
		const staged = await publishedEntry("staged-old", "Staged published");
		await addDraft(staged.id, { _slug: "staged-new", title: "Staged draft" });
		const other = await publishedEntry("other-old", "Other published");
		await addDraft(other.id, { _slug: "other-new", title: "Other draft" });

		const missingWithOtherToken = await read("missing", { collection: "post", id: other.id });
		expect(missingWithOtherToken.entry).toBeNull();
		const stagedSlugWithOtherToken = await read("staged-new", {
			collection: "post",
			id: other.id,
		});
		expect(stagedSlugWithOtherToken.entry).toBeNull();

		const wrongCollection = await read("staged-new", { collection: "page", id: staged.id });
		expect(wrongCollection.entry).toBeNull();

		const otherOldWithStagedToken = await read("other-old", { collection: "post", id: staged.id });
		expect(otherOldWithStagedToken.entry).toMatchObject({
			data: { slug: "other-old", title: "Other published" },
		});
	});

	it.each([
		{
			collision: "published",
			create: async (slug: string) => publishedEntry(slug, "Other published"),
		},
		{
			collision: "draft",
			create: async (slug: string) =>
				contentRepo.create(createPostFixture({ slug, data: { title: "Other draft" } })),
		},
	])(
		"prefers the token entry draft when the staged slug collides with a $collision entry",
		async ({ create }) => {
			const staged = await publishedEntry("staged-old", "Staged published");
			await addDraft(staged.id, { _slug: "new-slug", title: "Staged draft" });
			await create("new-slug");

			for (const editMode of [false, true]) {
				const preview = await read("new-slug", { collection: "post", id: staged.id }, { editMode });
				expect(preview.entry).toMatchObject({
					data: { slug: "new-slug", title: "Staged draft" },
				});
				expect(preview.isPreview).toBe(true);
			}
		},
	);

	it("resolves a staged slug for a non-default locale", async () => {
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		const staged = await contentRepo.publish(
			"post",
			(
				await contentRepo.create(
					createPostFixture({ slug: "ancien-slug", locale: "fr", data: { title: "Publié" } }),
				)
			).id,
		);
		await addDraft(staged.id, { _slug: "nouveau-slug", title: "Brouillon" });

		const preview = await read(
			"nouveau-slug",
			{ collection: "post", id: staged.id },
			{ locale: "fr" },
		);
		expect(preview.entry).toMatchObject({ data: { slug: "nouveau-slug", title: "Brouillon" } });
		expect(preview.isPreview).toBe(true);
		expect(preview.fallbackLocale).toBeUndefined();

		const wrongLocale = await read(
			"nouveau-slug",
			{ collection: "post", id: staged.id },
			{ locale: "en" },
		);
		expect(wrongLocale.entry).toBeNull();

		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de"], fallback: { de: "fr" } });
		const fallback = await read(
			"nouveau-slug",
			{ collection: "post", id: staged.id },
			{ locale: "de" },
		);
		expect(fallback.entry).toMatchObject({ data: { slug: "nouveau-slug", title: "Brouillon" } });
		expect(fallback.fallbackLocale).toBe("fr");
	});

	it("does not treat an unstaged slug as a preview route", async () => {
		const row = await publishedEntry("unchanged", "Published");
		const draft = await new RevisionRepository(ctx.db).create({
			collection: "post",
			entryId: row.id,
			data: { title: "Draft without slug" },
		});
		await contentRepo.setDraftRevision("post", row.id, draft.id);

		const preview = await read("unchanged", { collection: "post", id: row.id });
		expect(preview.entry).toMatchObject({
			data: { slug: "unchanged", title: "Draft without slug" },
		});
		expect((await read("missing", { collection: "post", id: row.id })).entry).toBeNull();

		const noDraft = await publishedEntry("no-draft", "No draft");
		const missingWithNoDraftToken = await read("missing", {
			collection: "post",
			id: noDraft.id,
		});
		expect(missingWithNoDraftToken.entry).toBeNull();
	});
});
