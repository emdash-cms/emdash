/**
 * `emdash:setup_complete` with an EMPTY users table is a recoverable
 * half-state: it appears when a completed instance's users are wiped or
 * a sanitised DB copy is shipped to a new environment (the documented
 * promote-a-QA'd-DB flow). GET /api/setup/status deliberately resumes
 * the wizard at the "admin" step for this state — but the admin-step
 * routes used to reject it on the stale flag alone (SETUP_COMPLETE,
 * 400), leaving the instance with NO UI path to an admin account.
 *
 * These tests pin the recovery path end to end: with the flag set and
 * zero users, POST /setup/admin must proceed (and /setup/admin/verify
 * must get past the same guard), while the normal fully-set-up state
 * keeps rejecting exactly as before.
 */

import type { APIContext, AstroCookies } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as postAdminVerify } from "../../../src/astro/routes/api/setup/admin-verify.js";
import { POST as postAdmin } from "../../../src/astro/routes/api/setup/admin.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface CookieRecord {
	value: string;
	options: Record<string, unknown>;
}

/** Minimal in-memory AstroCookies stub (same shape as the nonce tests). */
function createCookieJar(initial: Record<string, string> = {}): {
	jar: Map<string, CookieRecord>;
	cookies: AstroCookies;
} {
	const jar = new Map<string, CookieRecord>();
	for (const [name, value] of Object.entries(initial)) {
		jar.set(name, { value, options: {} });
	}

	const cookies = {
		get(name: string) {
			const record = jar.get(name);
			if (!record) return undefined;
			return { value: record.value };
		},
		set(name: string, value: string, options: Record<string, unknown> = {}) {
			jar.set(name, { value, options });
		},
		delete(name: string) {
			jar.delete(name);
		},
		has(name: string) {
			return jar.has(name);
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub
	} as unknown as AstroCookies;

	return { jar, cookies };
}

function buildRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function buildContext(db: Kysely<Database>, request: Request, cookies: AstroCookies): APIContext {
	return {
		params: {},
		url: new URL(request.url),
		request,
		cookies,
		locals: {
			emdash: {
				db,
				config: {},
				storage: undefined,
			},
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub
	} as unknown as APIContext;
}

const adminBody = { email: "recovered@admin.example", name: "Recovered Admin" };

async function insertUser(db: Kysely<Database>): Promise<void> {
	await db
		.insertInto("users")
		.values({
			id: "existing1",
			email: "existing@admin.example",
			name: "Existing Admin",
			role: 50,
			email_verified: 1,
		})
		.execute();
}

describe("POST /setup/admin — recovery when setup_complete but no users exist", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("allows starting admin registration when setup_complete is true but users is empty", async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:setup_complete", true);

		const { cookies } = createCookieJar();
		const res = await postAdmin(
			buildContext(db, buildRequest("/_emdash/api/setup/admin", adminBody), cookies),
		);

		// Pre-fix this returned 400 SETUP_COMPLETE — the state
		// /api/setup/status resumes at "admin" was unreachable.
		expect(res.status).toBe(200);
	});

	it('accepts the string "true" flag variant the same way', async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:setup_complete", "true");

		const { cookies } = createCookieJar();
		const res = await postAdmin(
			buildContext(db, buildRequest("/_emdash/api/setup/admin", adminBody), cookies),
		);

		expect(res.status).toBe(200);
	});

	it("lets /setup/admin/verify past the setup-complete guard in the same state", async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:setup_complete", true);

		// Start the admin step for real so state + nonce cookie exist.
		const { cookies } = createCookieJar();
		const adminRes = await postAdmin(
			buildContext(db, buildRequest("/_emdash/api/setup/admin", adminBody), cookies),
		);
		expect(adminRes.status).toBe(200);

		// A bogus credential: verification fails at the WebAuthn step,
		// but only AFTER the setup-complete/users gate. Assert the gate,
		// not the passkey result (same technique as the nonce tests).
		const verifyRes = await postAdminVerify(
			buildContext(
				db,
				buildRequest("/_emdash/api/setup/admin/verify", {
					credential: {
						id: "AA",
						rawId: "AA",
						type: "public-key",
						response: { clientDataJSON: "AA", attestationObject: "AA" },
					},
				}),
				cookies,
			),
		);

		const body = (await verifyRes.json()) as { error?: { code?: string } };
		expect(body.error?.code).not.toBe("SETUP_COMPLETE");
	});

	it("still rejects with SETUP_COMPLETE when setup is complete AND a user exists", async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:setup_complete", true);
		await insertUser(db);

		const { cookies } = createCookieJar();
		const res = await postAdmin(
			buildContext(db, buildRequest("/_emdash/api/setup/admin", adminBody), cookies),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { code?: string } };
		expect(body.error?.code).toBe("SETUP_COMPLETE");
	});

	it("still rejects with ADMIN_EXISTS when a user exists without the complete flag", async () => {
		await insertUser(db);

		const { cookies } = createCookieJar();
		const res = await postAdmin(
			buildContext(db, buildRequest("/_emdash/api/setup/admin", adminBody), cookies),
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { code?: string } };
		expect(body.error?.code).toBe("ADMIN_EXISTS");
	});
});
