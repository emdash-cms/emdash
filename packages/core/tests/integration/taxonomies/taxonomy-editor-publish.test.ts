import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	GET as getTerms,
	POST as postTerms,
} from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("editor taxonomy publication", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function context(entryId: string, termIds?: string[], stage = true): APIContext {
		const url = new URL(`http://localhost/_emdash/api/content/post/${entryId}/terms/tags`);
		return {
			params: { collection: "post", id: entryId, taxonomy: "tags" },
			url,
			request:
				termIds === undefined
					? new Request(url)
					: new Request(url, {
							method: "POST",
							headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
							body: JSON.stringify({ termIds, stage }),
						}),
			locals: {
				user: { id: "editor", role: Role.ADMIN },
				emdash: {
					db: ctx.db,
					handleContentGet: (collection: string, id: string) =>
						createTestRuntime(ctx.db).handleContentGet(collection, id),
				},
			},
		} as unknown as APIContext;
	}

	it("keeps a tag-only edit off the live post until Publish changes", async () => {
		const runtime = createTestRuntime(ctx.db);
		const content = new ContentRepository(ctx.db);
		const taxonomy = new TaxonomyRepository(ctx.db);
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Internship" },
			slug: "internship",
		});
		const entryId = created.data!.item.id;
		await runtime.handleContentPublish("post", entryId);
		const term = await taxonomy.create({ name: "tags", slug: "internship", label: "Internship" });

		const response = await postTerms(context(entryId, [term.id]));
		expect(response.status).toBe(200);
		const staged = await content.findById("post", entryId);
		expect(staged?.draftRevisionId).toBeTruthy();
		expect(await taxonomy.getTermsForEntry("post", entryId, "tags")).toEqual([]);
		const selected = await getTerms(context(entryId));
		expect((await selected.json()).data.terms).toMatchObject([{ id: term.id }]);

		const published = await runtime.handleContentPublish("post", entryId);
		expect(published.success).toBe(true);
		expect(published.data!.item.draftRevisionId).toBeNull();
		expect((await taxonomy.getTermsForEntry("post", entryId, "tags")).map((t) => t.id)).toEqual([
			term.id,
		]);
		const republished = await runtime.handleContentPublish("post", entryId);
		expect(republished.success).toBe(true);
		expect((await taxonomy.getTermsForEntry("post", entryId, "tags")).map((t) => t.id)).toEqual([
			term.id,
		]);
	});

	it("preserves staged tags through a content save and discards them with the draft", async () => {
		const runtime = createTestRuntime(ctx.db);
		const content = new ContentRepository(ctx.db);
		const taxonomy = new TaxonomyRepository(ctx.db);
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Live" },
			slug: "live",
		});
		const entryId = created.data!.item.id;
		await runtime.handleContentPublish("post", entryId);
		const term = await taxonomy.create({ name: "tags", slug: "internship", label: "Internship" });

		const response = await postTerms(context(entryId, [term.id]));
		const revision = (await response.json()).data._rev as string;
		const saved = await runtime.handleContentUpdate("post", entryId, {
			data: { title: "Edited" },
			_rev: revision,
		});
		expect(saved.success).toBe(true);
		await runtime.handleContentDiscardDraft("post", entryId);
		expect((await getTerms(context(entryId))).status).toBe(200);
		expect(await taxonomy.getTermsForEntry("post", entryId, "tags")).toEqual([]);
		expect((await content.findById("post", entryId))?.draftRevisionId).toBeNull();

		await postTerms(context(entryId, [term.id]));
		const updated = await runtime.handleContentUpdate("post", entryId, {
			data: { title: "Edited again" },
		});
		expect(updated.success).toBe(true);
		await runtime.handleContentPublish("post", entryId);
		expect((await taxonomy.getTermsForEntry("post", entryId, "tags")).map((t) => t.id)).toEqual([
			term.id,
		]);
	});

	it("keeps direct API term writes immediate for existing clients", async () => {
		const content = new ContentRepository(ctx.db);
		const taxonomy = new TaxonomyRepository(ctx.db);
		const entry = await content.create({ type: "post", data: { title: "Post" } });
		const term = await taxonomy.create({ name: "tags", slug: "news", label: "News" });
		const response = await postTerms(context(entry.id, [term.id], false));
		expect(response.status).toBe(200);
		expect((await taxonomy.getTermsForEntry("post", entry.id, "tags")).map((t) => t.id)).toEqual([
			term.id,
		]);
	});

	it("publishes tag changes for sibling translations together", async () => {
		const runtime = createTestRuntime(ctx.db);
		const content = new ContentRepository(ctx.db);
		const taxonomy = new TaxonomyRepository(ctx.db);
		const english = await content.create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			locale: "en",
		});
		const french = await content.create({
			type: "post",
			slug: "bonjour",
			data: { title: "Bonjour" },
			locale: "fr",
			translationOf: english.id,
		});
		await runtime.handleContentPublish("post", english.id);
		await runtime.handleContentPublish("post", french.id);
		const englishTag = await taxonomy.create({
			name: "tags",
			slug: "internship",
			label: "Internship",
			locale: "en",
		});
		const frenchTag = await taxonomy.create({
			name: "tags",
			slug: "stage",
			label: "Stage",
			locale: "fr",
			translationOf: englishTag.id,
		});

		const response = await postTerms(context(english.id, [englishTag.id]));
		expect(response.status).toBe(200);
		expect(await taxonomy.getTermsForEntry("post", french.id, "tags", "fr")).toEqual([]);
		await runtime.handleContentPublish("post", english.id);
		expect(
			(await taxonomy.getTermsForEntry("post", french.id, "tags", "fr")).map((t) => t.id),
		).toEqual([frenchTag.id]);
	});
});
