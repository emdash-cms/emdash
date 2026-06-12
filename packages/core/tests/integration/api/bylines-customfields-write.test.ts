/**
 * customFields write surface on the admin bylines PUT route.
 *
 * Phase 4 of Discussion #1174 extends `PUT /_emdash/api/admin/bylines/{id}`
 * to accept a `customFields` map. Per-field type validation lives in
 * `BylineRepository.update` (Phase 3); the route is responsible for
 * forwarding the field and mapping `EmDashValidationError` to a clean
 * 400 `VALIDATION_ERROR`.
 *
 * Covers:
 * - Round-trip: PUT writes, GET reads them back.
 * - Unknown slug → 400 `VALIDATION_ERROR` (rejected by repository, not
 *   leaked as a 500).
 * - Type mismatch → 400 `VALIDATION_ERROR`.
 * - Select-choice mismatch → 400 `VALIDATION_ERROR`.
 * - PUT route still requires `bylines:manage` — Author can't write
 *   custom fields on someone else's (or any) byline; missing user is
 *   401.
 * - Reserved-slug writes return 400 (unknown-key path; no registered
 *   field claims a reserved slug because the registry rejects them).
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	GET as getById,
	PUT as putById,
} from "../../../src/astro/routes/api/admin/bylines/[id]/index.js";
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
	params: { id: string };
	user: { id: string; role: (typeof Role)[keyof typeof Role] } | null;
}

function buildContext(opts: BuildOpts): APIContext {
	return {
		params: opts.params,
		url: new URL(opts.request.url),
		request: opts.request,
		locals: {
			emdash: { db: opts.db, config: {} },
			user: opts.user,
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

function putReq(id: string, body: unknown): Request {
	return new Request(`http://localhost/_emdash/api/admin/bylines/${id}`, {
		method: "PUT",
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
const editorUser = { id: "editor-1", role: Role.EDITOR };

const basePut = {
	slug: "jane-doe",
	displayName: "Jane Doe",
	bio: null,
	avatarMediaId: null,
	websiteUrl: null,
	userId: null,
	isGuest: true,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PUT /admin/bylines/{id} — customFields write surface", () => {
	let db: Kysely<Database>;
	let bylineId: string;

	beforeEach(async () => {
		// The field-defs cache lives on globalThis (see
		// `field-defs-cache.ts`); across tests in the same Vitest worker
		// it would otherwise hold stale field IDs from a previous test's
		// in-memory DB, producing spurious FK failures when the
		// repository writes a value row keyed by a vanished field id.
		// The version-counter coincidentally lands at the same value
		// (4 fields × bump-twice = 8) in each test, so the version-based
		// invalidation doesn't fire on its own.
		resetBylineFieldDefsCacheForTests();
		db = await setupTestDatabase();

		// Register two custom fields: one translatable (job_title), one
		// group-shared (twitter_handle). Different types so we cover the
		// type-validation paths.
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
			slug: "is_staff",
			label: "Staff",
			type: "boolean",
			translatable: true,
		});
		await registry.createField({
			slug: "tier",
			label: "Tier",
			type: "select",
			translatable: true,
			validation: { options: ["bronze", "silver", "gold"] },
		});

		// Create a byline directly through the repository — the PUT
		// route under test is for *updates*, and the create route is out
		// of scope here.
		const repo = new BylineRepository(db);
		const byline = await repo.create({
			slug: "jane-doe",
			displayName: "Jane Doe",
			isGuest: true,
		});
		bylineId = byline.id;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// ===========================================
	// Round-trip
	// ===========================================

	it("PUT writes customFields, GET reads them back", async () => {
		const putBody = {
			...basePut,
			customFields: {
				job_title: "Senior editor",
				twitter_handle: "https://twitter.com/jane",
				is_staff: true,
				tier: "gold",
			},
		};
		const putRes = await putById(
			buildContext({
				db,
				request: putReq(bylineId, putBody),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		expect(putRes.status).toBe(200);
		const putJson = (await putRes.json()) as {
			data: { customFields?: Record<string, unknown> };
		};
		expect(putJson.data.customFields).toMatchObject({
			job_title: "Senior editor",
			twitter_handle: "https://twitter.com/jane",
			is_staff: true,
			tier: "gold",
		});

		const getRes = await getById(
			buildContext({ db, request: getReq(bylineId), params: { id: bylineId }, user: adminUser }),
		);
		expect(getRes.status).toBe(200);
		const getJson = (await getRes.json()) as {
			data: { customFields?: Record<string, unknown> };
		};
		expect(getJson.data.customFields).toMatchObject({
			job_title: "Senior editor",
			twitter_handle: "https://twitter.com/jane",
			is_staff: true,
			tier: "gold",
		});
	});

	it("null customField value clears that slot", async () => {
		const writeRes = await putById(
			buildContext({
				db,
				request: putReq(bylineId, { ...basePut, customFields: { job_title: "Editor" } }),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		// Assert the initial write landed — otherwise the clear assertion
		// below would pass trivially (the key is absent because the value
		// was never written, not because the clear cleared it).
		expect(writeRes.status).toBe(200);

		const clearRes = await putById(
			buildContext({
				db,
				request: putReq(bylineId, { ...basePut, customFields: { job_title: null } }),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		expect(clearRes.status).toBe(200);

		const getRes = await getById(
			buildContext({ db, request: getReq(bylineId), params: { id: bylineId }, user: adminUser }),
		);
		const getJson = (await getRes.json()) as {
			data: { customFields?: Record<string, unknown> };
		};
		// `null` cleared the row; the key is absent on read (Phase 3 AC).
		expect(getJson.data.customFields).not.toHaveProperty("job_title");
	});

	// ===========================================
	// Validation failures → 400
	// ===========================================

	it("unknown customField slug → 400 VALIDATION_ERROR", async () => {
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, {
					...basePut,
					customFields: { not_a_registered_field: "x" },
				}),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
	});

	it("reserved-slug write returns 400 (no registered field has that slug)", async () => {
		// `display_name` is reserved, so no custom field can claim it.
		// The repo therefore treats it as an unknown key → 400.
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, {
					...basePut,
					customFields: { display_name: "X" },
				}),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
	});

	it("type mismatch (string expected, boolean sent) → 400", async () => {
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, {
					...basePut,
					customFields: { job_title: true },
				}),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);
	});

	it("select-choice mismatch → 400", async () => {
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, {
					...basePut,
					customFields: { tier: "platinum" }, // not in validation.options
				}),
				params: { id: bylineId },
				user: adminUser,
			}),
		);
		expect(res.status).toBe(400);
	});

	// ===========================================
	// Auth — bylines:manage gate still applies to customFields writes
	// ===========================================

	it("returns 401 without a session", async () => {
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, { ...basePut, customFields: { job_title: "X" } }),
				params: { id: bylineId },
				user: null,
			}),
		);
		expect(res.status).toBe(401);
	});

	it("EDITOR can write customFields (bylines:manage = EDITOR)", async () => {
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, { ...basePut, customFields: { job_title: "Editor" } }),
				params: { id: bylineId },
				user: editorUser,
			}),
		);
		expect(res.status).toBe(200);
	});

	it("AUTHOR (below bylines:manage) → 403", async () => {
		const authorUser = { id: "author-1", role: Role.AUTHOR };
		const res = await putById(
			buildContext({
				db,
				request: putReq(bylineId, { ...basePut, customFields: { job_title: "X" } }),
				params: { id: bylineId },
				user: authorUser,
			}),
		);
		expect(res.status).toBe(403);
	});
});
