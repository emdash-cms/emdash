import { Role } from "@emdash-cms/auth";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	handleContentDuplicateMany,
	handleDuplicateMappingGet,
} from "../../../src/api/handlers/content-duplicate.js";
import { handleTaxonomyCreate } from "../../../src/api/handlers/taxonomies.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = { id: "editor-1", role: Role.EDITOR };
const AUTHOR = { id: "author-1", role: Role.AUTHOR };

// setupForDialectWithCollections registers "post" and "page", each with a
// `title` (string/TEXT) and `content` (portableText/JSON) field.
describeEachDialect("content duplication", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});
	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function content() {
		return new ContentRepository(ctx.db);
	}

	async function countRows(collection: string): Promise<number> {
		const result = await sql<{
			c: number | bigint | string;
		}>`SELECT COUNT(*) AS c FROM ${sql.ref(`ec_${collection}`)}`.execute(ctx.db);
		return Number(result.rows[0]?.c ?? 0);
	}

	it("derives a mapping by slug match and ignores incompatible same-slug pairs", async () => {
		const registry = new SchemaRegistry(ctx.db);
		// `page.summary` is JSON where `post.summary` is TEXT — same slug, no match.
		await registry.createField("post", { slug: "summary", label: "Summary", type: "string" });
		await registry.createField("page", { slug: "summary", label: "Summary", type: "json" });

		const result = await handleDuplicateMappingGet(ctx.db, "post", "page");
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.source).toBe("derived");
		expect(result.data.mapping.title).toBe("title");
		expect(result.data.mapping.content).toBe("content");
		expect(result.data.mapping.summary).toBeNull();

		const summary = result.data.targetCollection.fields.find((f) => f.slug === "summary");
		// The only JSON source field is `content`, so that's the one offered.
		expect(summary?.compatibleSources).toEqual(["content"]);
	});

	it("rejects the request when a required target field has no source assigned", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("page", {
			slug: "subtitle",
			label: "Subtitle",
			type: "string",
			required: true,
		});
		const post = await content().create({ type: "post", slug: "p", data: { title: "P" } });

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			mapping: { title: "title" },
			actor: EDITOR,
		});

		expect(result.success).toBe(false);
		expect(result.error?.code).toBe("VALIDATION_ERROR");
		expect(result.error?.message).toContain("subtitle");
		expect(await countRows("page")).toBe(0);
	});

	it("rejects a mapping that would write an out-of-options select value", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "kind", label: "Kind", type: "string" });
		await registry.createField("page", {
			slug: "kind",
			label: "Kind",
			type: "select",
			validation: { options: ["guide", "reference"] },
		});
		const post = await content().create({
			type: "post",
			slug: "p",
			data: { title: "P", kind: "tutorial" },
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			mapping: { title: "title", kind: "kind" },
			actor: EDITOR,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.results[0]?.status).toBe("failed");
		expect(await countRows("page")).toBe(0);
	});

	it("fails validation when a required target field is mapped to a NULL source", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "subtitle", label: "Subtitle", type: "string" });
		await registry.createField("page", {
			slug: "subtitle",
			label: "Subtitle",
			type: "string",
			required: true,
		});
		// The mapping is complete; the source value simply isn't set.
		const post = await content().create({ type: "post", slug: "p", data: { title: "P" } });

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			mapping: { title: "title", subtitle: "subtitle" },
			actor: EDITOR,
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.results[0]?.status).toBe("failed");
		expect(result.data.results[0]?.error).toContain("subtitle");
		expect(await countRows("page")).toBe(0);
	});

	it("copies as a draft with a fresh slug and a new translation group", async () => {
		const post = await content().create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const targetId = result.data.results[0]?.targetId;
		expect(targetId).toBeDefined();
		const copy = await content().findById("page", targetId!);
		expect(copy?.status).toBe("draft");
		expect(copy?.slug).toBe("hello");
		expect(copy?.data.title).toBe("Hello");
		expect(copy?.locale).toBe(post.locale);
		expect(copy?.translationGroup).not.toBe(post.translationGroup);
		expect(copy?.translationGroup).toBe(copy?.id);
		expect(copy?.publishedAt).toBeNull();
		expect(copy?.authorId).toBe(EDITOR.id);
	});

	it("carries taxonomy terms only when the definition lists the target collection", async () => {
		const shared = await handleTaxonomyCreate(ctx.db, {
			name: "topic",
			label: "Topics",
			collections: ["post", "page"],
		});
		const postOnly = await handleTaxonomyCreate(ctx.db, {
			name: "series",
			label: "Series",
			collections: ["post"],
		});
		expect(shared.success && postOnly.success).toBe(true);

		const taxRepo = new TaxonomyRepository(ctx.db);
		const topic = await taxRepo.create({ name: "topic", slug: "astro", label: "Astro" });
		const series = await taxRepo.create({ name: "series", slug: "basics", label: "Basics" });

		const post = await content().create({ type: "post", slug: "p", data: { title: "P" } });
		await taxRepo.attachToEntry("post", post.id, topic.id);
		await taxRepo.attachToEntry("post", post.id, series.id);

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const targetId = result.data.results[0]?.targetId;
		const carried = await taxRepo.getTermsForEntry("page", targetId!);
		expect(carried.map((term) => term.name)).toEqual(["topic"]);
	});

	it("reports reference edges and leaves inbound edges on the original", async () => {
		const relationRepo = new RelationRepository(ctx.db);
		const relation = await relationRepo.create({
			name: "related",
			parentCollection: "post",
			childCollection: "post",
			parentLabel: "Post",
			childLabel: "Related post",
		});

		const post = await content().create({ type: "post", slug: "p", data: { title: "P" } });
		const other = await content().create({ type: "post", slug: "o", data: { title: "O" } });
		// other -> post, so `post` has one inbound edge and no outbound edges.
		await relationRepo.setChildren(relation.translationGroup, other.translationGroup!, [
			post.translationGroup!,
		]);

		const mapping = await handleDuplicateMappingGet(ctx.db, "post", "page", [post.id]);
		expect(mapping.success).toBe(true);
		if (!mapping.success) return;
		expect(mapping.data.referenceEdges).toEqual({ inbound: 1, outbound: 0 });

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const edges = await ctx.db
			.selectFrom("_emdash_content_references")
			.select(["parent_group", "child_group"])
			.execute();
		expect(edges).toHaveLength(1);
		expect(edges[0]?.child_group).toBe(post.translationGroup);
	});

	it("copies SEO only when both collections have it enabled", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "article", label: "Articles", hasSeo: true });
		await registry.createField("article", { slug: "title", label: "Title", type: "string" });

		const seoRepo = new SeoRepository(ctx.db);
		const post = await content().create({ type: "post", slug: "p", data: { title: "P" } });
		await seoRepo.upsert("post", post.id, {
			title: "Meta",
			description: "Desc",
			canonical: "https://example.com/p",
		});

		// post has no SEO, so nothing carries even though article does.
		const toArticle = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "article",
			actor: EDITOR,
		});
		expect(toArticle.success).toBe(true);
		if (!toArticle.success) return;
		const articleSeo = await seoRepo.get("article", toArticle.data.results[0]!.targetId!);
		expect(articleSeo.title).toBeNull();

		await registry.updateCollection("post", { hasSeo: true });
		const withSeo = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "article",
			actor: EDITOR,
		});
		expect(withSeo.success).toBe(true);
		if (!withSeo.success) return;
		const copiedSeo = await seoRepo.get("article", withSeo.data.results[0]!.targetId!);
		expect(copiedSeo.title).toBe("Meta");
		expect(copiedSeo.description).toBe("Desc");
		// The canonical pointed at the original.
		expect(copiedSeo.canonical).toBeNull();
	});

	it("saves a mapping to options and prefers it over derivation", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "summary", label: "Summary", type: "string" });
		await registry.createField("page", { slug: "subtitle", label: "Subtitle", type: "string" });

		const post = await content().create({
			type: "post",
			slug: "p",
			data: { title: "P", summary: "S" },
		});

		const saved = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			mapping: { title: "title", subtitle: "summary" },
			saveMapping: true,
			actor: EDITOR,
		});
		expect(saved.success).toBe(true);

		const stored = await new OptionsRepository(ctx.db).get("contentmap:post:page");
		expect(stored).toEqual({
			version: 1,
			fields: { title: "title", subtitle: "summary" },
		});

		const mapping = await handleDuplicateMappingGet(ctx.db, "post", "page");
		expect(mapping.success).toBe(true);
		if (!mapping.success) return;
		expect(mapping.data.source).toBe("saved");
		expect(mapping.data.mapping.subtitle).toBe("summary");

		// A later run without an explicit mapping uses the saved one.
		const reused = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "page",
			actor: EDITOR,
		});
		expect(reused.success).toBe(true);
		if (!reused.success) return;
		const copy = await content().findById("page", reused.data.results[0]!.targetId!);
		expect(copy?.data.subtitle).toBe("S");
	});

	it("returns per-item results across a partial failure", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "kind", label: "Kind", type: "string" });
		await registry.createField("page", {
			slug: "kind",
			label: "Kind",
			type: "select",
			validation: { options: ["guide"] },
		});

		const good = await content().create({
			type: "post",
			slug: "good",
			data: { title: "Good", kind: "guide" },
		});
		const bad = await content().create({
			type: "post",
			slug: "bad",
			data: { title: "Bad", kind: "nope" },
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [bad.id, good.id],
			targetCollection: "page",
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.results.map((r) => [r.id, r.status])).toEqual([
			[bad.id, "failed"],
			[good.id, "copied"],
		]);
		expect(await countRows("page")).toBe(1);
	});

	it("rejects trashSource on an item the actor cannot delete, without copying it", async () => {
		const mine = await content().create({
			type: "post",
			slug: "mine",
			data: { title: "Mine" },
			authorId: AUTHOR.id,
		});
		const theirs = await content().create({
			type: "post",
			slug: "theirs",
			data: { title: "Theirs" },
			authorId: "someone-else",
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [mine.id, theirs.id],
			targetCollection: "page",
			trashSource: true,
			actor: AUTHOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.results.map((r) => [r.id, r.status])).toEqual([
			[mine.id, "copied"],
			[theirs.id, "failed"],
		]);
		expect(await countRows("page")).toBe(1);
		expect(await content().findById("post", mine.id)).toBeNull();
		expect(await content().findById("post", theirs.id)).not.toBeNull();
	});

	it("resolves an identity mapping when the target is the source collection", async () => {
		await handleTaxonomyCreate(ctx.db, {
			name: "series",
			label: "Series",
			collections: ["post"],
		});

		const result = await handleDuplicateMappingGet(ctx.db, "post", "post");
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.mapping).toEqual({ title: "title", content: "content" });
		expect(result.data.unmappableRequired).toEqual([]);
		expect(result.data.taxonomies.dropped).toEqual([]);
		expect(result.data.taxonomies.carried.map((tx) => tx.name)).toEqual(["series"]);
	});

	it("duplicates within one collection as a draft copy carrying taxonomy terms", async () => {
		await handleTaxonomyCreate(ctx.db, {
			name: "series",
			label: "Series",
			collections: ["post"],
		});
		const taxRepo = new TaxonomyRepository(ctx.db);
		const series = await taxRepo.create({ name: "series", slug: "basics", label: "Basics" });

		const post = await content().create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
			status: "published",
		});
		await taxRepo.attachToEntry("post", post.id, series.id);

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "post",
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const targetId = result.data.results[0]?.targetId;
		expect(targetId).toBeDefined();
		const copy = await content().findById("post", targetId!);
		expect(copy?.status).toBe("draft");
		expect(copy?.data.title).toBe("Hello (Copy)");
		expect(copy?.slug).not.toBe(post.slug);
		expect(copy?.translationGroup).not.toBe(post.translationGroup);
		expect(await taxRepo.getTermsForEntry("post", targetId!)).toHaveLength(1);
	});

	it("copies a row that predates a newly required field", async () => {
		const post = await content().create({ type: "post", slug: "old", data: { title: "Old" } });
		// The row was valid when it was written; the schema tightened afterwards.
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "subtitle",
			label: "Subtitle",
			type: "string",
			required: true,
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "post",
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.results[0]?.status).toBe("copied");
		expect(await countRows("post")).toBe(2);
	});

	it("suffixes the title of a same-collection copy that drops a field", async () => {
		const post = await content().create({
			type: "post",
			slug: "p",
			data: { title: "P", content: [{ _type: "block", children: [] }] },
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "post",
			mapping: { title: "title", content: null },
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		const targetId = result.data.results[0]?.targetId;
		expect(targetId).toBeDefined();
		const copy = await content().findById("post", targetId!);
		expect(copy?.data.title).toBe("P (Copy)");
		expect(copy?.data.content).toBeFalsy();
	});

	it("validates a same-collection copy that remaps fields", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "note", label: "Note", type: "string" });
		await registry.createField("post", {
			slug: "kind",
			label: "Kind",
			type: "select",
			validation: { options: ["guide", "reference"] },
		});
		const post = await content().create({
			type: "post",
			slug: "p",
			data: { title: "P", note: "tutorial" },
		});

		const result = await handleContentDuplicateMany(ctx.db, "post", {
			ids: [post.id],
			targetCollection: "post",
			mapping: { title: "title", content: "content", note: "note", kind: "note" },
			actor: EDITOR,
		});
		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.results[0]?.status).toBe("failed");
		expect(await countRows("post")).toBe(1);
	});
});
