/**
 * Slug resolution on the content-taxonomy association endpoint.
 *
 * `content_taxonomies` rows are keyed by the canonical content ULID. The POST
 * handler resolves the URL `id` segment (which may be a slug) to that ULID via
 * `handleContentGet` before writing. The GET handler must perform the same
 * resolution before reading — otherwise a request addressed by slug looks up
 * assignments under the slug, finds none, and returns an empty list even
 * though the term is assigned.
 *
 * Regression test for #1045 (GET did not resolve slug -> canonical ULID).
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	GET as getTerms,
	POST as postTerms,
} from "../../../src/astro/routes/api/content/[collection]/[id]/terms/[taxonomy].js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

type Handlers = ReturnType<typeof handlersFromRuntime>;
type TermsBody = { data: { terms: Array<{ slug: string }> } };

// RoleLevel 50 = ADMIN — satisfies content:read and content:edit_any.
const ADMIN = { id: "user_admin", email: "admin@example.com", name: "Admin", role: 50 as const };

function buildContext(opts: {
	emdash: Handlers;
	params: { collection: string; id: string; taxonomy: string };
	request: Request;
}): APIContext {
	return {
		params: opts.params,
		url: new URL(opts.request.url),
		request: opts.request,
		locals: { emdash: opts.emdash, user: ADMIN },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

describe("content terms endpoint — slug resolution (#1045)", () => {
	let db: Kysely<Database>;
	let emdash: Handlers;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		emdash = handlersFromRuntime(createTestRuntime(db));
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("GET returns assigned terms when the entry is addressed by slug", async () => {
		const taxRepo = new TaxonomyRepository(db);
		const term = await taxRepo.create({ name: "tag", slug: "pakistan", label: "Pakistan" });

		const created = await emdash.handleContentCreate("post", {
			data: { title: "eSIM Pakistan" },
			slug: "esim-pakistan",
		});
		expect(created.success).toBe(true);

		const resolved = await emdash.handleContentGet("post", "esim-pakistan");
		const postId = resolved.data?.item.id;
		if (typeof postId !== "string") throw new Error("expected created post to have an id");

		// Assign the term via POST addressed by slug. POST already resolves the
		// slug to the ULID, so the row lands under `postId`.
		const postRes = await postTerms(
			buildContext({
				emdash,
				params: { collection: "post", id: "esim-pakistan", taxonomy: "tag" },
				request: new Request("http://localhost/_emdash/api/content/post/esim-pakistan/terms/tag", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ termIds: [term.id] }),
				}),
			}),
		);
		expect(postRes.status).toBe(200);

		// Control: GET by canonical ULID resolves trivially and returns the term.
		const byId = await getTerms(
			buildContext({
				emdash,
				params: { collection: "post", id: postId, taxonomy: "tag" },
				request: new Request(`http://localhost/_emdash/api/content/post/${postId}/terms/tag`),
			}),
		);
		expect(byId.status).toBe(200);
		const byIdBody = (await byId.json()) as TermsBody;
		expect(byIdBody.data.terms.map((t) => t.slug)).toEqual(["pakistan"]);

		// Regression: GET by slug must resolve to the same ULID and return the term.
		const bySlug = await getTerms(
			buildContext({
				emdash,
				params: { collection: "post", id: "esim-pakistan", taxonomy: "tag" },
				request: new Request("http://localhost/_emdash/api/content/post/esim-pakistan/terms/tag"),
			}),
		);
		expect(bySlug.status).toBe(200);
		const bySlugBody = (await bySlug.json()) as TermsBody;
		expect(bySlugBody.data.terms.map((t) => t.slug)).toEqual(["pakistan"]);
	});
});
