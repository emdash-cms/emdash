import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as callback } from "../../../../auth-atproto/src/routes/callback.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { answersOverIo } from "../../utils/answers-over-io.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("emdash/api/route-utils", () => import("../../../src/api/route-utils.js"));
vi.mock("../../../../auth-atproto/src/storage.js", () => ({
	getAtprotoStorage: async () => null,
}));
const profileGate = vi.hoisted(() => ({ wait: async () => {} }));

vi.mock("@emdash-cms/auth-atproto/oauth-client", () => ({
	getAtprotoOAuthClient: async () => ({
		callback: async (params: URLSearchParams) => ({ session: { did: params.get("code") } }),
	}),
	resolveAtprotoProfile: async (session: { did: string }) => {
		await profileGate.wait();
		return { displayName: session.did, handle: `${session.did.split(":").pop()}.example.com` };
	},
}));

function redirect(url: string): Response {
	return new Response(null, { status: 302, headers: { Location: url } });
}

describe("first admin through AT Protocol during setup", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await new OptionsRepository(db).set("emdash:setup_state", { email: "owner@example.com" });
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		profileGate.wait = async () => {};
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function signIn(did: string, database: Kysely<Database> = db) {
		const response = await callback({
			request: new Request(
				`http://localhost:4321/_emdash/api/auth/atproto/callback?code=${encodeURIComponent(did)}`,
			),
			locals: { emdash: { db: database, config: {} } },
			session: { set: vi.fn() },
			redirect,
		} as unknown as Parameters<typeof callback>[0]);
		return response.headers.get("Location")?.split("&")[0];
	}

	it("stores the first admin with the setup wizard's email", async () => {
		expect(await signIn("did:plc:owner")).toBe("/_emdash/admin");

		const users = await db
			.selectFrom("users")
			.select(["email", "role", "email_verified"])
			.execute();
		expect(users).toEqual([{ email: "owner@example.com", role: Role.ADMIN, email_verified: 1 }]);
	});

	it("does not link a new DID to an admin created before setup is marked complete", async () => {
		const owner = await createKyselyAdapter(db).createUser({
			email: "owner@example.com",
			role: Role.ADMIN,
			emailVerified: true,
		});

		expect(await signIn("did:plc:second")).toBe("/_emdash/admin/login?error=signup_not_allowed");

		expect(await db.selectFrom("users").select("id").execute()).toEqual([{ id: owner.id }]);
		expect(await db.selectFrom("oauth_accounts").select("user_id").execute()).toEqual([]);
	});

	it("creates one admin when two callbacks overlap", async () => {
		// Park the first callback just before its first-user check and start
		// the second only then: two in-flight imports of a mocked module can
		// load the real one. Both continue once the second arrives.
		let firstArrived!: () => void;
		const firstParked = new Promise<void>((resolve) => (firstArrived = resolve));
		let secondArrived!: () => void;
		const secondParked = new Promise<void>((resolve) => (secondArrived = resolve));
		let arrivals = 0;
		profileGate.wait = async () => {
			if (++arrivals === 1) {
				firstArrived();
				await secondParked;
			} else {
				secondArrived();
			}
		};
		const slowDb = db.withPlugin(answersOverIo);

		const owner = signIn("did:plc:owner", slowDb);
		await firstParked;
		const locations = await Promise.all([owner, signIn("did:plc:second", slowDb)]);

		expect(await db.selectFrom("users").select(["email", "role"]).execute()).toEqual([
			{ email: "owner@example.com", role: Role.ADMIN },
		]);
		expect(await db.selectFrom("oauth_accounts").select("user_id").execute()).toHaveLength(1);
		expect(locations).toHaveLength(2);
		expect(locations).toContain("/_emdash/admin");
		expect(locations).toContain("/_emdash/admin/login?error=signup_not_allowed");
	});
});
