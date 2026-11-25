import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as start } from "../../../src/astro/routes/api/auth/oauth/[provider].js";
import { GET as callback } from "../../../src/astro/routes/api/auth/oauth/[provider]/callback.js";
import type { Database } from "../../../src/database/types.js";
import { answersOverIo, failFirstInsertInto } from "../../utils/query-plugins.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const GITHUB_IDS: Record<string, number> = { owner: 1, second: 2 };

function redirect(url: string): Response {
	return new Response(null, { status: 302, headers: { Location: url } });
}

describe("first admin through an OAuth provider during setup", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_ID", "client-id");
		vi.stubEnv("EMDASH_OAUTH_GITHUB_CLIENT_SECRET", "client-secret");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === "https://github.com/login/oauth/access_token") {
					// The code doubles as the GitHub login that approved the request.
					const code = init?.body instanceof URLSearchParams ? init.body.get("code") : null;
					return Response.json({ access_token: code });
				}
				if (url === "https://api.github.com/user") {
					const login =
						new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
					return Response.json({
						id: GITHUB_IDS[login],
						login,
						name: login,
						email: `${login}@example.com`,
						avatar_url: `https://avatars.example.com/${login}.png`,
					});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await teardownTestDatabase(db);
	});

	async function approve(login: string, database: Kysely<Database>) {
		const locals = { emdash: { db: database, config: {} } };
		const jar = new Map<string, string>();
		const cookies = {
			get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
			set: (name: string, value: string) => jar.set(name, value),
			delete: (name: string) => jar.delete(name),
		};
		const started = await start({
			params: { provider: "github" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/github"),
			locals,
			cookies,
			redirect,
		} as unknown as Parameters<typeof start>[0]);
		const state = new URL(started.headers.get("Location") ?? "").searchParams.get("state");
		return async () => {
			const response = await callback({
				params: { provider: "github" },
				request: new Request(
					`http://localhost:4321/_emdash/api/auth/oauth/github/callback?code=${login}&state=${state}`,
				),
				locals,
				cookies,
				session: { set: vi.fn(), regenerate: vi.fn(async () => {}) },
				redirect,
			} as unknown as Parameters<typeof callback>[0]);
			return response.headers.get("Location")?.split("&")[0];
		};
	}

	it("creates one admin when two callbacks overlap", async () => {
		const slowDb = db.withPlugin(answersOverIo);
		const ownerReturns = await approve("owner", slowDb);
		const secondReturns = await approve("second", slowDb);

		const locations = await Promise.all([ownerReturns(), secondReturns()]);

		const users = await db.selectFrom("users").select(["role"]).execute();
		expect(users).toEqual([{ role: Role.ADMIN }]);
		expect(await db.selectFrom("oauth_accounts").select("user_id").execute()).toHaveLength(1);
		expect(locations).toHaveLength(2);
		expect(locations).toContain("/_emdash/admin");
		expect(locations).toContain("/_emdash/admin/login?error=signup_not_allowed");
	});

	it("refuses a new identity once a user exists, even before setup is marked complete", async () => {
		const ownerReturns = await approve("owner", db);
		expect(await ownerReturns()).toBe("/_emdash/admin");
		await db.deleteFrom("options").where("name", "=", "emdash:setup_complete").execute();

		const secondReturns = await approve("second", db);
		expect(await secondReturns()).toBe("/_emdash/admin/login?error=signup_not_allowed");

		expect(await db.selectFrom("users").select(["email", "role"]).execute()).toEqual([
			{ email: "owner@example.com", role: Role.ADMIN },
		]);
	});

	it("stores the provider's avatar and verified email on the first admin", async () => {
		const ownerReturns = await approve("owner", db);
		await ownerReturns();

		const owner = await db
			.selectFrom("users")
			.select(["avatar_url", "email_verified"])
			.executeTakeFirstOrThrow();
		expect(owner).toEqual({
			avatar_url: "https://avatars.example.com/owner.png",
			email_verified: 1,
		});
	});

	async function storedClaim() {
		const row = await db.selectFrom("users").select("data").executeTakeFirstOrThrow();
		return row.data ? (JSON.parse(row.data) as Record<string, unknown>).firstAdminClaim : undefined;
	}

	it("finishes setup and removes the claim when a retry follows a failed account link", async () => {
		const failingDb = db.withPlugin(failFirstInsertInto("oauth_accounts"));
		const firstTry = await approve("owner", failingDb);
		expect(await firstTry()).toBe("/_emdash/admin/login?error=oauth_error");
		expect(await storedClaim()).toEqual({ provider: "github", providerAccountId: "1" });

		const retry = await approve("owner", db);
		expect(await retry()).toBe("/_emdash/admin");

		expect(await db.selectFrom("users").select("role").execute()).toEqual([{ role: Role.ADMIN }]);
		expect(await storedClaim()).toBeUndefined();
		expect(await db.selectFrom("oauth_accounts").select("provider_account_id").execute()).toEqual([
			{ provider_account_id: "1" },
		]);
	});
});
