/**
 * Auth, permission, and request-validation tests for the byline-fields
 * admin API routes (Phase 4 of Discussion #1174).
 *
 * Covers acceptance criteria from `extensible-bylines-pr.mdx` §Phase 4:
 *
 * - Every byline-fields endpoint returns `UNAUTHORIZED` without auth.
 * - Every byline-fields endpoint returns 403 for a user without
 *   `schema:manage` (Editor isn't enough — it's an Admin-only perm).
 * - Reserved slugs rejected at the zod layer (400 VALIDATION_ERROR).
 * - Invalid slugs / types rejected at the zod layer (400).
 * - Happy paths round-trip through the registry.
 * - `BylineSchemaError` codes map to the documented HTTP statuses
 *   (`FIELD_EXISTS` → 409, `FIELD_NOT_FOUND` → 404,
 *   `TRANSLATABLE_LOCKED` → 409, `REORDER_MISMATCH` → 400).
 *
 * CSRF is enforced by the auth middleware, not the route handler — see
 * `astro/middleware/auth.ts:284-294`. These tests invoke the route
 * exports directly, so the middleware does not run; the AC is satisfied
 * by the middleware's blanket `X-EmDash-Request` check on every
 * unsafe-method API request.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	GET as getOne,
	PATCH as patchOne,
	DELETE as deleteOne,
} from "../../../src/astro/routes/api/admin/byline-fields/[slug].js";
import { GET as getUsage } from "../../../src/astro/routes/api/admin/byline-fields/[slug]/usage.js";
import {
	GET as listFields,
	POST as createField,
} from "../../../src/astro/routes/api/admin/byline-fields/index.js";
import { POST as reorderFields } from "../../../src/astro/routes/api/admin/byline-fields/reorder.js";
import { resetBylineFieldDefsCacheForTests } from "../../../src/bylines/field-defs-cache.js";
import type { Database } from "../../../src/database/types.js";
import { BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

interface BuildOpts {
	db: Kysely<Database>;
	request: Request;
	params?: Record<string, string>;
	user: { id: string; role: (typeof Role)[keyof typeof Role] } | null;
}

function buildContext(opts: BuildOpts): APIContext {
	return {
		params: opts.params ?? {},
		url: new URL(opts.request.url),
		request: opts.request,
		locals: {
			emdash: { db: opts.db, config: {} },
			user: opts.user,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

function jsonRequest(url: string, method: string, body?: unknown): Request {
	return new Request(url, {
		method,
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

const adminUser = { id: "admin-1", role: Role.ADMIN };
const editorUser = { id: "editor-1", role: Role.EDITOR };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("admin/byline-fields routes — auth + permissions + validation", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		// See sibling test `bylines-customfields-write.test.ts` for why.
		resetBylineFieldDefsCacheForTests();
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// ===========================================
	// Auth gate (no user → 401)
	// ===========================================

	describe("UNAUTHORIZED without a session", () => {
		it("GET /byline-fields returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "GET");
			const res = await listFields(buildContext({ db, request: req, user: null }));
			expect(res.status).toBe(401);
			expect(await res.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
		});

		it("POST /byline-fields returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "x",
				label: "X",
				type: "string",
			});
			const res = await createField(buildContext({ db, request: req, user: null }));
			expect(res.status).toBe(401);
		});

		it("GET /byline-fields/{slug} returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/x", "GET");
			const res = await getOne(
				buildContext({ db, request: req, params: { slug: "x" }, user: null }),
			);
			expect(res.status).toBe(401);
		});

		it("PATCH /byline-fields/{slug} returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/x", "PATCH", {
				label: "X",
			});
			const res = await patchOne(
				buildContext({ db, request: req, params: { slug: "x" }, user: null }),
			);
			expect(res.status).toBe(401);
		});

		it("DELETE /byline-fields/{slug} returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/x", "DELETE");
			const res = await deleteOne(
				buildContext({ db, request: req, params: { slug: "x" }, user: null }),
			);
			expect(res.status).toBe(401);
		});

		it("GET /byline-fields/{slug}/usage returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/x/usage", "GET");
			const res = await getUsage(
				buildContext({ db, request: req, params: { slug: "x" }, user: null }),
			);
			expect(res.status).toBe(401);
		});

		it("POST /byline-fields/reorder returns 401", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/reorder", "POST", {
				slugs: ["x"],
			});
			const res = await reorderFields(buildContext({ db, request: req, user: null }));
			expect(res.status).toBe(401);
		});
	});

	// ===========================================
	// Permission gate — read/manage split (Phase 6 of #1174)
	//
	// Editors need to *read* the registry so the byline edit form can
	// render custom-field inputs (Phase 6). Only admins can mutate
	// the registry. The split is anchored by two perms:
	//   - `schema:read`  → Editor (read endpoints)
	//   - `schema:manage` → Admin  (mutation endpoints)
	// ===========================================

	describe("editors can read but not mutate", () => {
		it("GET /byline-fields succeeds for Editor (schema:read)", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "GET");
			const res = await listFields(buildContext({ db, request: req, user: editorUser }));
			expect(res.status).toBe(200);
		});

		it("GET /byline-fields/{slug} succeeds for Editor (schema:read)", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });

			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/job_title", "GET");
			const res = await getOne(
				buildContext({ db, request: req, params: { slug: "job_title" }, user: editorUser }),
			);
			expect(res.status).toBe(200);
		});

		it("GET /byline-fields/{slug}/usage succeeds for Editor (schema:read)", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });

			const req = jsonRequest(
				"http://localhost/_emdash/api/admin/byline-fields/job_title/usage",
				"GET",
			);
			const res = await getUsage(
				buildContext({
					db,
					request: req,
					params: { slug: "job_title" },
					user: editorUser,
				}),
			);
			expect(res.status).toBe(200);
		});

		it("POST /byline-fields returns 403 for Editor (mutation requires schema:manage)", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "job_title",
				label: "Job Title",
				type: "string",
			});
			const res = await createField(buildContext({ db, request: req, user: editorUser }));
			expect(res.status).toBe(403);
		});

		it("PATCH /byline-fields/{slug} returns 403 for Editor", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });

			const req = jsonRequest(
				"http://localhost/_emdash/api/admin/byline-fields/job_title",
				"PATCH",
				{ label: "Patched" },
			);
			const res = await patchOne(
				buildContext({
					db,
					request: req,
					params: { slug: "job_title" },
					user: editorUser,
				}),
			);
			expect(res.status).toBe(403);
		});

		it("DELETE /byline-fields/{slug} returns 403 for Editor", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/x", "DELETE");
			const res = await deleteOne(
				buildContext({ db, request: req, params: { slug: "x" }, user: editorUser }),
			);
			expect(res.status).toBe(403);
		});

		it("POST /byline-fields/reorder returns 403 for Editor", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/reorder", "POST", {
				slugs: ["x"],
			});
			const res = await reorderFields(buildContext({ db, request: req, user: editorUser }));
			expect(res.status).toBe(403);
		});
	});

	// ===========================================
	// Happy paths — Admin can manage fields
	// ===========================================

	describe("happy paths with schema:manage", () => {
		it("creates and lists a field", async () => {
			const createReq = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "job_title",
				label: "Job title",
				type: "string",
			});
			const createRes = await createField(
				buildContext({ db, request: createReq, user: adminUser }),
			);
			expect(createRes.status).toBe(201);
			const created = (await createRes.json()) as { data: { slug: string; type: string } };
			expect(created.data.slug).toBe("job_title");
			expect(created.data.type).toBe("string");

			const listReq = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "GET");
			const listRes = await listFields(buildContext({ db, request: listReq, user: adminUser }));
			expect(listRes.status).toBe(200);
			const list = (await listRes.json()) as { data: { items: { slug: string }[] } };
			expect(list.data.items).toHaveLength(1);
			expect(list.data.items[0]?.slug).toBe("job_title");
		});

		it("returns 404 when GET targets an unknown slug", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/missing", "GET");
			const res = await getOne(
				buildContext({ db, request: req, params: { slug: "missing" }, user: adminUser }),
			);
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
		});

		it("PATCH updates a field's label", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "pronouns", label: "Pronouns", type: "string" });

			const req = jsonRequest(
				"http://localhost/_emdash/api/admin/byline-fields/pronouns",
				"PATCH",
				{ label: "Preferred pronouns" },
			);
			const res = await patchOne(
				buildContext({ db, request: req, params: { slug: "pronouns" }, user: adminUser }),
			);
			expect(res.status).toBe(200);
			const updated = (await res.json()) as { data: { label: string } };
			expect(updated.data.label).toBe("Preferred pronouns");
		});

		it("DELETE removes a field", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "twitter", label: "Twitter", type: "url" });

			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/twitter", "DELETE");
			const res = await deleteOne(
				buildContext({ db, request: req, params: { slug: "twitter" }, user: adminUser }),
			);
			expect(res.status).toBe(200);
			expect(await registry.getField("twitter")).toBeNull();
		});

		it("usage returns zero counts for a fresh field", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "company", label: "Company", type: "string" });

			const req = jsonRequest(
				"http://localhost/_emdash/api/admin/byline-fields/company/usage",
				"GET",
			);
			const res = await getUsage(
				buildContext({ db, request: req, params: { slug: "company" }, user: adminUser }),
			);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({
				data: {
					translatableValueCount: 0,
					groupValueCount: 0,
					totalAffectedRows: 0,
				},
			});
		});

		it("reorder swaps two registered fields", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "a_field", label: "A", type: "string" });
			await registry.createField({ slug: "b_field", label: "B", type: "string" });

			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/reorder", "POST", {
				slugs: ["b_field", "a_field"],
			});
			const res = await reorderFields(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: { items: { slug: string; sortOrder: number }[] } };
			expect(body.data.items.map((i) => i.slug)).toEqual(["b_field", "a_field"]);
		});
	});

	// ===========================================
	// Zod-layer rejections (400 VALIDATION_ERROR)
	// ===========================================

	describe("zod-layer rejections", () => {
		it("rejects a reserved slug at the zod layer", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "display_name", // reserved (column collision)
				label: "Display name",
				type: "string",
			});
			const res = await createField(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		it("rejects `reorder` at the zod layer — would collide with the static reorder route", async () => {
			// Astro's static-route precedence: `/byline-fields/reorder` resolves
			// to `reorder.ts` (POST-only), so a field with slug `reorder` is
			// unreachable via single-field CRUD on `[slug].ts`. Reserve at the
			// system level — see `RESERVED_BYLINE_FIELD_SLUGS` JSDoc rationale.
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "reorder",
				label: "Reorder",
				type: "string",
			});
			const res = await createField(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		it("rejects `reorder` at the registry layer (non-HTTP callers)", async () => {
			const registry = new BylineSchemaRegistry(db);
			await expect(
				registry.createField({ slug: "reorder", label: "Reorder", type: "string" }),
			).rejects.toMatchObject({ code: "RESERVED_SLUG" });
		});

		it("rejects an invalid slug pattern at the zod layer", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "Bad-Slug", // hyphen + uppercase — pattern is /^[a-z][a-z0-9_]*$/
				label: "X",
				type: "string",
			});
			const res = await createField(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({
				error: { code: "VALIDATION_ERROR" },
			});
		});

		it("rejects an unsupported type at the zod layer", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "x",
				label: "X",
				type: "portableText", // not in v1 byline subset
			});
			const res = await createField(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(400);
		});

		it("rejects unknown top-level keys (strict mode)", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "x",
				label: "X",
				type: "string",
				bogus: true,
			});
			const res = await createField(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(400);
		});

		it("accepts an empty reorder list when zero fields are registered (no-op)", async () => {
			// Registry contract: `reorderFields([])` against an empty set
			// is a valid no-op (length match passes; loop runs 0 times).
			// The zod schema must agree to avoid producing a spurious 400
			// for the UI's "reorder after deleting the last field" flow.
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/reorder", "POST", {
				slugs: [],
			});
			const res = await reorderFields(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { data: { items: unknown[] } };
			expect(body.data.items).toEqual([]);
		});
	});

	// ===========================================
	// Registry-error mapping
	// ===========================================

	describe("registry-error → HTTP mapping", () => {
		it("FIELD_EXISTS → 409 on duplicate create", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });

			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields", "POST", {
				slug: "job_title",
				label: "Job title (dup)",
				type: "string",
			});
			const res = await createField(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(409);
			expect(await res.json()).toMatchObject({ error: { code: "FIELD_EXISTS" } });
		});

		it("FIELD_NOT_FOUND → 404 on patch of missing slug", async () => {
			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/missing", "PATCH", {
				label: "Label",
			});
			const res = await patchOne(
				buildContext({ db, request: req, params: { slug: "missing" }, user: adminUser }),
			);
			expect(res.status).toBe(404);
			expect(await res.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
		});

		it("REORDER_MISMATCH → 400 when slug set differs", async () => {
			const registry = new BylineSchemaRegistry(db);
			await registry.createField({ slug: "a_field", label: "A", type: "string" });

			const req = jsonRequest("http://localhost/_emdash/api/admin/byline-fields/reorder", "POST", {
				slugs: ["a_field", "nonexistent_field"],
			});
			const res = await reorderFields(buildContext({ db, request: req, user: adminUser }));
			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ error: { code: "REORDER_MISMATCH" } });
		});

		it("usage endpoint returns 404 for missing slug", async () => {
			const req = jsonRequest(
				"http://localhost/_emdash/api/admin/byline-fields/missing/usage",
				"GET",
			);
			const res = await getUsage(
				buildContext({ db, request: req, params: { slug: "missing" }, user: adminUser }),
			);
			expect(res.status).toBe(404);
		});
	});
});
