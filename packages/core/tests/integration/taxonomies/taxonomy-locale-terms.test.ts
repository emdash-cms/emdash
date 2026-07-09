/**
 * Locale-aware term resolution for content entries (issue #1218).
 *
 * The storage model is correct: `content_taxonomies` stores
 * `entry_id` = the per-locale content row id and `taxonomy_id` = the term's
 * `translation_group` (which spans every locale). Resolving the terms for an
 * entry must therefore scope to the entry's own locale, otherwise EVERY locale
 * variant of the term is returned.
 *
 * The bug was that the admin content-editor terms route
 * (`/content/:collection/:id/terms/:taxonomy`) never passed a locale, so a
 * French post showed both the English and French variants of its tag.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentGet } from "../../../src/api/handlers/content.js";
import {
	handleTermCreate,
	handleTermList,
	type TermWithCount,
} from "../../../src/api/handlers/taxonomies.js";
import {
	GET as getTerms,
	POST as postTerms,
} from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
import { up as up045 } from "../../../src/database/migrations/045_taxonomy_parent_group.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface TermFixture {
	enContentId: string;
	frContentId: string;
	frContentSlug: string;
	enTagId: string;
	frTagId: string;
}

async function seedLocalizedTags(db: Kysely<Database>): Promise<TermFixture> {
	const contentRepo = new ContentRepository(db);
	const taxRepo = new TaxonomyRepository(db);

	// Two content rows: EN + FR, same translation group.
	const enContent = await contentRepo.create({
		type: "post",
		slug: "hello",
		data: { title: "Hello" },
		locale: "en",
	});
	const frContent = await contentRepo.create({
		type: "post",
		slug: "bonjour",
		data: { title: "Bonjour" },
		locale: "fr",
		translationOf: enContent.id,
	});

	// One tag with an EN + FR translation (shared translation_group).
	const enTag = await taxRepo.create({
		name: "tags",
		slug: "news",
		label: "News",
		locale: "en",
	});
	const frTag = await taxRepo.create({
		name: "tags",
		slug: "actualites",
		label: "Actualités",
		locale: "fr",
		translationOf: enTag.id,
	});

	// Attach the tag (by group) to BOTH entries.
	await taxRepo.attachToEntry("post", enContent.id, enTag.id);
	await taxRepo.attachToEntry("post", frContent.id, enTag.id);

	return {
		enContentId: enContent.id,
		frContentId: frContent.id,
		frContentSlug: frContent.slug,
		enTagId: enTag.id,
		frTagId: frTag.id,
	};
}

const adminUser = {
	id: "u-admin",
	email: "a@example.com",
	name: "Admin",
	role: Role.ADMIN as RoleLevel,
};

function buildGetContext(
	db: Kysely<Database>,
	params: { collection: string; id: string; taxonomy: string },
): APIContext {
	const url = new URL(
		`http://localhost/_emdash/api/content/${params.collection}/${params.id}/terms/${params.taxonomy}`,
	);
	return {
		params,
		url,
		request: new Request(url, { headers: { "X-EmDash-Request": "1" } }),
		locals: {
			emdash: {
				db,
				handleContentGet: (collection: string, id: string, locale?: string) =>
					handleContentGet(db, collection, id, locale),
			},
			user: adminUser,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

function buildPostContext(
	db: Kysely<Database>,
	params: { collection: string; id: string; taxonomy: string },
	termIds: string[],
): APIContext {
	const url = new URL(
		`http://localhost/_emdash/api/content/${params.collection}/${params.id}/terms/${params.taxonomy}`,
	);
	return {
		params,
		url,
		request: new Request(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ termIds }),
		}),
		locals: {
			emdash: {
				db,
				handleContentGet: (collection: string, id: string, locale?: string) =>
					handleContentGet(db, collection, id, locale),
			},
			user: adminUser,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

interface TermsResponse {
	data?: { terms?: Array<{ id: string; slug: string; label: string }> };
	error?: { code: string };
}

describeEachDialect("content terms route locale-awareness (#1218)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("repository resolves only the entry-locale variant when locale is given", async () => {
		const fx = await seedLocalizedTags(ctx.db);
		const taxRepo = new TaxonomyRepository(ctx.db);

		const all = await taxRepo.getTermsForEntry("post", fx.frContentId, "tags");
		expect(all).toHaveLength(2); // bug surface: both locales without a filter

		const frOnly = await taxRepo.getTermsForEntry("post", fx.frContentId, "tags", "fr");
		expect(frOnly).toHaveLength(1);
		expect(frOnly[0]!.id).toBe(fx.frTagId);
	});

	it("GET returns only the FR variant for the FR entry", async () => {
		const fx = await seedLocalizedTags(ctx.db);

		const res = await getTerms(
			buildGetContext(ctx.db, { collection: "post", id: fx.frContentId, taxonomy: "tags" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TermsResponse;
		expect(body.error).toBeUndefined();
		const ids = (body.data?.terms ?? []).map((t) => t.id);
		expect(ids).toEqual([fx.frTagId]);
	});

	it("GET returns only the EN variant for the EN entry", async () => {
		const fx = await seedLocalizedTags(ctx.db);

		const res = await getTerms(
			buildGetContext(ctx.db, { collection: "post", id: fx.enContentId, taxonomy: "tags" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TermsResponse;
		const ids = (body.data?.terms ?? []).map((t) => t.id);
		expect(ids).toEqual([fx.enTagId]);
	});

	it("GET by slug returns only the FR variant for the FR entry", async () => {
		const fx = await seedLocalizedTags(ctx.db);

		const res = await getTerms(
			buildGetContext(ctx.db, { collection: "post", id: fx.frContentSlug, taxonomy: "tags" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TermsResponse;
		expect(body.error).toBeUndefined();
		const ids = (body.data?.terms ?? []).map((t) => t.id);
		expect(ids).toEqual([fx.frTagId]);
	});

	it("POST response echoes only the entry-locale variant", async () => {
		const fx = await seedLocalizedTags(ctx.db);

		// Re-set the FR entry's tags via the EN term id (resolved to the group).
		const res = await postTerms(
			buildPostContext(ctx.db, { collection: "post", id: fx.frContentId, taxonomy: "tags" }, [
				fx.enTagId,
			]),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as TermsResponse;
		expect(body.error).toBeUndefined();
		const ids = (body.data?.terms ?? []).map((t) => t.id);
		expect(ids).toEqual([fx.frTagId]);
	});
});

/**
 * Parent links are stored as the parent's translation_group, not a locale-bound
 * row id, so a child stays nested under the parent in every locale (#1347).
 */
async function insertHierarchicalDef(db: Kysely<Database>, name: string): Promise<void> {
	await db
		.insertInto("_emdash_taxonomy_defs")
		.values({
			id: ulid(),
			name,
			label: name,
			label_singular: null,
			hierarchical: 1,
			collections: JSON.stringify([]),
			locale: "en",
			translation_group: ulid(),
		})
		.execute();
}

function findInTree(terms: TermWithCount[], slug: string): TermWithCount | undefined {
	for (const term of terms) {
		if (term.slug === slug) return term;
		const nested = findInTree(term.children, slug);
		if (nested) return nested;
	}
	return undefined;
}

describeEachDialect("taxonomy parent stays nested across locales (#1347)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await insertHierarchicalDef(ctx.db, "categories");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("nests a child under a parent translated AFTER the child", async () => {
		// Child is translated before the parent: the FR parent does not exist
		// when the FR child is created.
		const enParent = await unwrap(
			handleTermCreate(ctx.db, "categories", { slug: "news", label: "News", locale: "en" }),
		);
		const enChild = await unwrap(
			handleTermCreate(ctx.db, "categories", {
				slug: "breaking",
				label: "Breaking",
				locale: "en",
				parentId: enParent.id,
			}),
		);
		await unwrap(
			handleTermCreate(ctx.db, "categories", {
				slug: "actualites",
				label: "Actualités",
				locale: "fr",
				parentId: enParent.id,
				translationOf: enChild.id,
			}),
		);

		// Now translate the parent into FR.
		await unwrap(
			handleTermCreate(ctx.db, "categories", {
				slug: "actus",
				label: "Actus",
				locale: "fr",
				translationOf: enParent.id,
			}),
		);

		const frList = await handleTermList(ctx.db, "categories", { locale: "fr" });
		if (!frList.success) throw new Error(frList.error.message);
		// The FR child must be nested under the FR parent, not flattened to root.
		expect(frList.data.terms.map((t) => t.slug)).toEqual(["actus"]);
		const frParent = frList.data.terms[0]!;
		expect(frParent.children.map((c) => c.slug)).toEqual(["actualites"]);

		// EN tree is unaffected.
		const enList = await handleTermList(ctx.db, "categories", { locale: "en" });
		if (!enList.success) throw new Error(enList.error.message);
		expect(enList.data.terms.map((t) => t.slug)).toEqual(["news"]);
		expect(enList.data.terms[0]!.children.map((c) => c.slug)).toEqual(["breaking"]);
	});

	it("keeps each locale's child under its own parent in an unfiltered list", async () => {
		const enParent = await unwrap(
			handleTermCreate(ctx.db, "categories", { slug: "news", label: "News", locale: "en" }),
		);
		const enChild = await unwrap(
			handleTermCreate(ctx.db, "categories", {
				slug: "breaking",
				label: "Breaking",
				locale: "en",
				parentId: enParent.id,
			}),
		);
		const frParent = await unwrap(
			handleTermCreate(ctx.db, "categories", {
				slug: "actus",
				label: "Actus",
				locale: "fr",
				translationOf: enParent.id,
			}),
		);
		await unwrap(
			handleTermCreate(ctx.db, "categories", {
				slug: "actualites",
				label: "Actualités",
				locale: "fr",
				parentId: frParent.id,
				translationOf: enChild.id,
			}),
		);

		// No locale filter: rows from both locales are returned. Each child must
		// stay under the parent in its own locale, not collapse onto a shared
		// translation_group key.
		const list = await handleTermList(ctx.db, "categories");
		if (!list.success) throw new Error(list.error.message);
		const roots = list.data.terms.toSorted((a, b) => a.slug.localeCompare(b.slug));
		expect(roots.map((t) => t.slug)).toEqual(["actus", "news"]);
		const actus = roots[0]!;
		const news = roots[1]!;
		expect(actus.children.map((c) => c.slug)).toEqual(["actualites"]);
		expect(news.children.map((c) => c.slug)).toEqual(["breaking"]);
	});

	it("rejects a translation parented to its own translation group", async () => {
		const enTerm = await unwrap(
			handleTermCreate(ctx.db, "categories", { slug: "news", label: "News", locale: "en" }),
		);
		// Creating an FR translation of enTerm whose parent is enTerm (same group)
		// is a cross-locale self-parent and must be rejected, not silently stored.
		const res = await handleTermCreate(ctx.db, "categories", {
			slug: "actus",
			label: "Actus",
			locale: "fr",
			parentId: enTerm.id,
			translationOf: enTerm.id,
		});
		expect(res.success).toBe(false);
		if (res.success) throw new Error("expected validation failure");
		expect(res.error.code).toBe("VALIDATION_ERROR");
	});

	it("rejects a parent that belongs to a different taxonomy", async () => {
		await insertHierarchicalDef(ctx.db, "tags");
		const otherParent = await unwrap(
			handleTermCreate(ctx.db, "tags", { slug: "misc", label: "Misc", locale: "en" }),
		);
		const res = await handleTermCreate(ctx.db, "categories", {
			slug: "orphan",
			label: "Orphan",
			locale: "en",
			parentId: otherParent.id,
		});
		expect(res.success).toBe(false);
		if (res.success) throw new Error("expected validation failure");
		expect(res.error.code).toBe("VALIDATION_ERROR");
	});

	it("backfills legacy locale-bound parent_id to the translation_group", async () => {
		// Simulate pre-#1347 rows by writing locale-bound parent ids directly.
		const enParentId = ulid();
		const group = enParentId; // anchor row: translation_group == id
		const frParentId = ulid();
		const enChildId = ulid();
		const childGroup = enChildId;
		const frChildId = ulid();

		await ctx.db
			.insertInto("taxonomies")
			.values([
				{
					id: enParentId,
					name: "categories",
					slug: "news",
					label: "News",
					parent_id: null,
					data: null,
					locale: "en",
					translation_group: group,
				},
				{
					id: frParentId,
					name: "categories",
					slug: "actus",
					label: "Actus",
					parent_id: null,
					data: null,
					locale: "fr",
					translation_group: group,
				},
				{
					id: enChildId,
					name: "categories",
					slug: "breaking",
					label: "Breaking",
					parent_id: enParentId, // legacy: anchor row id (== group)
					data: null,
					locale: "en",
					translation_group: childGroup,
				},
				{
					id: frChildId,
					name: "categories",
					slug: "actualites",
					label: "Actualités",
					parent_id: frParentId, // legacy: cross-locale row id (the bug)
					data: null,
					locale: "fr",
					translation_group: childGroup,
				},
			])
			.execute();

		await up045(ctx.db);

		const repo = new TaxonomyRepository(ctx.db);
		const frChild = await repo.findById(frChildId);
		const enChild = await repo.findById(enChildId);
		// Both children now reference the parent's translation_group.
		expect(frChild!.parentId).toBe(group);
		expect(enChild!.parentId).toBe(group);

		// And the FR tree renders nested rather than flattened.
		const frList = await handleTermList(ctx.db, "categories", { locale: "fr" });
		if (!frList.success) throw new Error(frList.error.message);
		const frParent = findInTree(frList.data.terms, "actus");
		expect(frParent?.children.map((c) => c.slug)).toEqual(["actualites"]);
	});
});

async function unwrap<T>(
	p: Promise<
		| { success: true; data: { term: T } }
		| { success: false; error: { code: string; message: string } }
	>,
): Promise<T> {
	const res = await p;
	if (!res.success) throw new Error(`${res.error.code}: ${res.error.message}`);
	return res.data.term;
}
