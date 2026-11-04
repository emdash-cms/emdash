import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { getEmDashCollection, getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { createPostFixture } from "../utils/fixtures.js";
import {
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

// Route Astro's live-collection API to the real EmDash loader, so the test
// covers the same path a page render takes.
vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../src/loader.js");
	const loader = emdashLoader();
	return {
		getLiveCollection: (_name: string, filter: never) => loader.loadCollection!({ filter }),
		getLiveEntry: async (_name: string, filter: never) => {
			const entry = await loader.loadEntry!({ filter });
			return entry && !("error" in entry) ? { entry, cacheHint: {} } : { entry: undefined };
		},
	};
});

describe("getEmDashCollection draft revisions", () => {
	let ctx: DialectTestContext;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections("sqlite");
		contentRepo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function publishedWithDraft(slug: string, live: string, draft: string) {
		const created = await contentRepo.create(createPostFixture({ slug, data: { title: live } }));
		const published = await contentRepo.publish("post", created.id);
		const revision = await new RevisionRepository(ctx.db).create({
			collection: "post",
			entryId: published.id,
			data: { title: draft },
		});
		await contentRepo.setDraftRevision("post", published.id, revision.id);
		return published;
	}

	function titles(entries: Array<{ id: string; data: unknown }>): Record<string, unknown> {
		return Object.fromEntries(
			entries.map((entry) => [entry.id, (entry.data as { title?: unknown }).title]),
		);
	}

	it("serves every entry's draft in edit mode, like getEmDashEntry", async () => {
		await publishedWithDraft("first", "First live", "First draft");
		await publishedWithDraft("second", "Second live", "Second draft");

		const { list, single } = await runWithContext({ editMode: true, db: ctx.db }, async () => ({
			list: await getEmDashCollection("post"),
			single: await getEmDashEntry("post", "first"),
		}));

		expect(titles(list.entries)).toEqual({ first: "First draft", second: "Second draft" });
		expect(single.entry?.data).toMatchObject({ title: "First draft" });
	});

	it("pages through drafts in edit mode with the row's sort order", async () => {
		await publishedWithDraft("first", "First live", "First draft");
		await publishedWithDraft("second", "Second live", "Second draft");

		const pages = await runWithContext({ editMode: true, db: ctx.db }, async () => {
			const one = await getEmDashCollection("post", { limit: 1, orderBy: { title: "asc" } });
			const two = await getEmDashCollection("post", {
				limit: 1,
				orderBy: { title: "asc" },
				cursor: one.nextCursor,
			});
			return [one, two];
		});

		expect(pages.map((page) => titles(page.entries))).toEqual([
			{ first: "First draft" },
			{ second: "Second draft" },
		]);
	});

	it("serves the draft only for the entry a preview token is for", async () => {
		const first = await publishedWithDraft("first", "First live", "First draft");
		await publishedWithDraft("second", "Second live", "Second draft");

		const list = await runWithContext(
			{ editMode: false, preview: { collection: "post", id: first.id }, db: ctx.db },
			() => getEmDashCollection("post"),
		);

		expect(titles(list.entries)).toEqual({ first: "First draft", second: "Second live" });
	});

	it("serves published data to public requests", async () => {
		await publishedWithDraft("first", "First live", "First draft");

		const list = await runWithContext({ editMode: false, db: ctx.db }, () =>
			getEmDashCollection("post"),
		);

		expect(titles(list.entries)).toEqual({ first: "First live" });
		expect(list.entries[0]?.data).not.toHaveProperty("draftRevisionId");
	});
});
