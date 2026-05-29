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
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentGet } from "../../../src/api/handlers/content.js";
import {
	GET as getTerms,
	POST as postTerms,
} from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
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
