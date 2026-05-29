/**
 * customFields write surface on the admin bylines POST (create) route.
 *
 * Phase 6 of Discussion #1174 extends `POST /_emdash/api/admin/bylines`
 * to accept a `customFields` map, mirroring the PUT route. Per-field
 * type validation lives in `BylineRepository.resolveCustomFieldWrites`
 * (extracted from the Phase 3 update path); the handler maps
 * `EmDashValidationError` → 400 `VALIDATION_ERROR`. Validation runs
 * BEFORE the row insert, so a failed create leaves no orphaned byline
 * behind.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getById } from "../../../src/astro/routes/api/admin/bylines/[id]/index.js";
import { POST as createByline } from "../../../src/astro/routes/api/admin/bylines/index.js";
import { resetBylineFieldDefsCacheForTests } from "../../../src/bylines/field-defs-cache.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import type { Database } from "../../../src/database/types.js";
import { BylineSchemaRegistry } from "../../../src/schema/byline-registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuildOpts {
	db: Kysely<Database>;
	request: Request;
	params?: { id: string };
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

function postReq(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/admin/bylines", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: JSON.stringify(body),
	});
}

function getReq(id: string): Request {
	return new Request(`http://localhost/_emdash/api/admin/bylines/${id}`, {
		method: "GET",
		headers: { "X-EmDash-Request": "1" },
	});
}

const adminUser = { id: "admin-1", role: Role.ADMIN };

const baseCreate = {
	slug: "jane-doe",
	displayName: "Jane Doe",
	isGuest: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/bylines — customFields write surface", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		// The field-defs cache lives on globalThis (see
		// `field-defs-cache.ts`); across tests in the same Vitest worker
		// it would otherwise hold stale field IDs from a previous test's
		// in-memory DB, producing spurious FK failures.
		resetBylineFieldDefsCacheForTests();
		db = await setupTestDatabase();

		const registry = new BylineSchemaRegistry(db);
		await registry.createField({
			slug: "job_title",
			label: "Job title",
			type: "string",
			translatable: true,
		});
		await registry.createField({
			slug: "twitter_handle",
			label: "Twitter",
			type: "url",
			translatable: false,
		});
		await registry.createField({
			slug: "tier",
			label: "Tier",
			type: "select",
			translatable: true,
			validation: { options: ["bronze", "silver", "gold"] },
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// ===========================================
	// Round-trip
	// ===========================================

	it("POST writes customFields, GET reads them back", async () => {
		const createRes = await createByline(
			buildContext({
				db,
				request: postReq({
					...baseCreate,
					customFields: {
						job_title: "Senior editor",
						twitter_handle: "https://twitter.com/jane",
						tier: "gold",
					},
				}),
				user: adminUser,
			}),
		);
		expect(createRes.status).toBe(201);
		const createJson = (await createRes.json()) as {
			data: { id: string; customFields?: Record<string, unknown> };
		};
		expect(createJson.data.customFields).toMatchObject({
			job_title: "Senior editor",
			twitter_handle: "https://twitter.com/jane",
			tier: "gold",
		});

		const getRes = await getById(
			buildContext({
				db,
				request: getReq(createJson.data.id),
				params: { id: createJson.data.id },
				user: adminUser,
			}),
		);
		expect(getRes.status).toBe(200);
		const getJson = (await getRes.json()) as {
			data: { customFields?: Record<string, unknown> };
		};
		expect(getJson.data.customFields).toMatchObject({
			job_title: "Senior editor",
			twitter_handle: "https://twitter.com/jane",
			tier: "gold",
		});
	});

	it("create without customFields still works (back-compat)", async () => {
		const res = await createByline(
			buildContext({
				db,
				request: postReq(baseCreate),
				user: adminUser,
			}),
		);
		expect(res.status).toBe(201);
	});

	// ===========================================
	// Validation failures → 400 + no bare byline left behind
	// ===========================================

	it("unknown customField slug → 400 VALIDATION_ERROR and no byline row created", async () => {
		const res = await createByline(
			buildContext({
				db,
				request: postReq({
					...baseCreate,
					customFields: { not_a_registered_field: "x" },
				}),
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

		// Validation MUST run before the row insert — otherwise a bad
		// customFields payload would leave a bare byline orphaned.
		const repo = new BylineRepository(db);
		const found = await repo.findBySlug(baseCreate.slug);
		expect(found).toBeNull();
	});

	it("type mismatch (string expected, boolean sent) → 400 and no byline created", async () => {
		const res = await createByline(
			buildContext({
				db,
				request: postReq({
					...baseCreate,
					customFields: { job_title: true },
				}),
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);

		const repo = new BylineRepository(db);
		expect(await repo.findBySlug(baseCreate.slug)).toBeNull();
	});

	it("select-choice mismatch → 400", async () => {
		const res = await createByline(
			buildContext({
				db,
				request: postReq({
					...baseCreate,
					customFields: { tier: "platinum" },
				}),
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);
	});

	// ===========================================
	// Auth — bylines:manage gate still applies
	// ===========================================

	it("returns 401 without a session", async () => {
		const res = await createByline(
			buildContext({
				db,
				request: postReq({
					...baseCreate,
					customFields: { job_title: "X" },
				}),
				user: null,
			}),
		);
		expect(res.status).toBe(401);
	});

	it("AUTHOR (below bylines:manage) → 403", async () => {
		const authorUser = { id: "author-1", role: Role.AUTHOR };
		const res = await createByline(
			buildContext({
				db,
				request: postReq({
					...baseCreate,
					customFields: { job_title: "X" },
				}),
				user: authorUser,
			}),
		);
		expect(res.status).toBe(403);
	});
});
