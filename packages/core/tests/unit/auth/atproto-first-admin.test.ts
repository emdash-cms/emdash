import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as callback } from "../../../../auth-atproto/src/routes/callback.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { answersOverIo, failFirstInsertInto } from "../../utils/query-plugins.js";
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
			session: { set: vi.fn(), regenerate: vi.fn(async () => {}) },
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

	async function storedClaim() {
		const row = await db.selectFrom("users").select("data").executeTakeFirstOrThrow();
		return row.data ? (JSON.parse(row.data) as Record<string, unknown>).firstAdminClaim : undefined;
	}

	describe.each([
		{ wizardEmail: "owner@example.com", storedEmail: "owner@example.com" },
		{ wizardEmail: undefined, storedEmail: "did-plc-owner@atproto.invalid" },
	])(
		"when the account link fails after the admin is created (wizard email: $wizardEmail)",
		({ wizardEmail, storedEmail }) => {
			beforeEach(async () => {
				await new OptionsRepository(db).set("emdash:setup_state", { email: wizardEmail });
			});

			async function failedFirstSignIn() {
				const failingDb = db.withPlugin(failFirstInsertInto("oauth_accounts"));
				expect(await signIn("did:plc:owner", failingDb)).toBe(
					"/_emdash/admin/login?error=atproto_error",
				);
				expect(await db.selectFrom("oauth_accounts").select("user_id").execute()).toEqual([]);
			}

			it("lets the same DID finish setup", async () => {
				await failedFirstSignIn();

				expect(await signIn("did:plc:owner")).toBe("/_emdash/admin");

				const [owner] = await db.selectFrom("users").select(["id", "email", "role"]).execute();
				expect(owner).toMatchObject({ email: storedEmail, role: Role.ADMIN });
				expect(
					await db
						.selectFrom("oauth_accounts")
						.select(["provider_account_id", "user_id"])
						.execute(),
				).toEqual([{ provider_account_id: "did:plc:owner", user_id: owner?.id }]);
				expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBe(true);
			});

			it("refuses a different DID", async () => {
				await failedFirstSignIn();

				expect(await signIn("did:plc:second")).toBe(
					"/_emdash/admin/login?error=signup_not_allowed",
				);

				expect(await db.selectFrom("oauth_accounts").select("user_id").execute()).toEqual([]);
				expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBeNull();
			});

			it("removes the claim once the DID is linked", async () => {
				await failedFirstSignIn();
				expect(await storedClaim()).toEqual({
					provider: "atproto",
					providerAccountId: "did:plc:owner",
				});

				await signIn("did:plc:owner");

				expect(await storedClaim()).toBeUndefined();
			});
		},
	);
});
