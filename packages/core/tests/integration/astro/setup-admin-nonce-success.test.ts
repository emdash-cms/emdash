/**
 * Success-path coverage for the setup nonce cookie.
 *
 * The sibling file `setup-admin-nonce.test.ts` covers the negative
 * paths (missing cookie, mismatched cookie, rotation) by driving
 * /setup/admin/verify with a bogus credential that fails at the
 * WebAuthn step. That harness can't exercise the *successful* verify
 * path — real WebAuthn verification requires a live authenticator.
 *
 * This file stubs `verifyRegistrationResponse` with a fake that
 * returns synthetic credential material so we can reach the code
 * after the nonce gate: user creation, passkey registration, setup
 * completion, and — the property we actually care about — deletion
 * of the nonce cookie.
 *
 * `registerPasskey` is left real; it only talks to the Kysely
 * adapter against the in-memory test DB.
 */

import type { APIContext, AstroCookies } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@emdash-cms/auth/passkey", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@emdash-cms/auth/passkey")>();
	return {
		...actual,
		verifyRegistrationResponse: vi.fn(async () => ({
			credentialId: "fake-credential-id",
			publicKey: new Uint8Array([1, 2, 3, 4]),
			algorithm: -7,
			counter: 0,
			deviceType: "singleDevice" as const,
			backedUp: false,
			transports: [],
		})),
	};
});

// Deferred so vi.mock applies before the route modules evaluate.
type AdminRoute = typeof import("../../../src/astro/routes/api/setup/admin.js");
type AdminVerifyRoute = typeof import("../../../src/astro/routes/api/setup/admin-verify.js");
let postAdmin: AdminRoute["POST"];
let postAdminVerify: AdminVerifyRoute["POST"];

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface CookieRecord {
	value: string;
	options: Record<string, unknown>;
	deleted?: boolean;
}

interface CookieJar {
	jar: Map<string, CookieRecord>;
	cookies: AstroCookies;
}

function createCookieJar(initial: Record<string, string> = {}): CookieJar {
	const jar = new Map<string, CookieRecord>();
	for (const [name, value] of Object.entries(initial)) {
		jar.set(name, { value, options: {} });
	}

	const cookies = {
		get(name: string) {
			const record = jar.get(name);
			if (!record || record.deleted) return undefined;
			return { value: record.value };
		},
		set(name: string, value: string, options: Record<string, unknown> = {}) {
			jar.set(name, { value, options });
		},
		delete(name: string, options: Record<string, unknown> = {}) {
			const existing = jar.get(name);
			jar.set(name, {
				value: existing?.value ?? "",
				options: { ...existing?.options, ...options },
				deleted: true,
			});
		},
		has(name: string) {
			const record = jar.get(name);
			return !!record && !record.deleted;
		},
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub
	} as unknown as AstroCookies;

	return { jar, cookies };
}

function buildAdminRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/setup/admin", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function buildVerifyRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/setup/admin/verify", {
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
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub
	} as unknown as APIContext;
}

const adminBody = { email: "real@admin.example", name: "Real Admin" };

// Any object that passes setupAdminVerifyBody — the actual WebAuthn
// verification is mocked out, so the fields don't need to parse as
// valid authenticator data.
const fakeCredential = {
	credential: {
		id: "fake-credential-id",
		rawId: "fake-credential-id",
		type: "public-key" as const,
		response: {
			clientDataJSON: "AA",
			attestationObject: "AA",
		},
	},
};

describe("POST /setup/admin/verify — success path clears nonce cookie", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		({ POST: postAdmin } = await import("../../../src/astro/routes/api/setup/admin.js"));
		({ POST: postAdminVerify } =
			await import("../../../src/astro/routes/api/setup/admin-verify.js"));
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("deletes the setup nonce cookie and marks setup complete when verify succeeds", async () => {
		// 1. Start admin setup — mints the nonce and drops the cookie.
		const { jar, cookies } = createCookieJar();
		const adminRes = await postAdmin(buildContext(db, buildAdminRequest(adminBody), cookies));
		expect(adminRes.status).toBe(200);
		const setCookie = jar.get("emdash_setup_nonce");
		expect(setCookie).toBeDefined();
		expect(setCookie!.deleted).toBeFalsy();

		// 2. Verify with the mocked-out WebAuthn check. The nonce gate
		//    runs first (real code path), then the stub returns a
		//    synthetic credential and the route creates the user.
		const verifyRes = await postAdminVerify(
			buildContext(db, buildVerifyRequest(fakeCredential), cookies),
		);
		expect(verifyRes.status).toBe(200);

		// 3. Cookie should now be deleted. The deletion must be
		//    scoped to /_emdash/ so it actually supersedes the cookie
		//    the browser holds.
		const afterVerify = jar.get("emdash_setup_nonce");
		expect(afterVerify?.deleted).toBe(true);
		expect(afterVerify?.options.path).toBe("/_emdash/");

		// 4. Setup state is cleared and setup_complete is set.
		const options = new OptionsRepository(db);
		const setupState = await options.get("emdash:setup_state");
		expect(setupState).toBeNull();
		const setupComplete = await options.get("emdash:setup_complete");
		expect(setupComplete).toBe(true);
	});
});
