import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import type { Kysely } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { microsoft, type MicrosoftProviderOptions } from "../../../src/auth/providers/microsoft.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER_TENANT = "f8cdef31-a31e-4b4a-93e4-5f571e91255a";
const CLIENT_ID = "6731de76-14a6-49ae-97bc-6eba6914391e";
const LOGIN = "https://login.microsoftonline.com";

const ENV = {
	EMDASH_OAUTH_MICROSOFT_CLIENT_ID: CLIENT_ID,
	EMDASH_OAUTH_MICROSOFT_CLIENT_SECRET: "client-secret",
	EMDASH_OAUTH_MICROSOFT_TENANT_ID: TENANT,
};

let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
	const pair = await generateKeyPair("RS256");
	privateKey = pair.privateKey;
	publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "test", alg: "RS256", use: "sig" };
});

function redirect(url: string): Response {
	return new Response(null, { status: 302, headers: { Location: url } });
}

async function loadRoutes(env: Record<string, string>) {
	vi.resetModules();
	vi.doMock("virtual:emdash/env", () => ({ env }), { virtual: true });
	const start = await import("../../../src/astro/routes/api/auth/oauth/[provider].js");
	const callback = await import("../../../src/astro/routes/api/auth/oauth/[provider]/callback.js");
	return { start: start.GET, callback: callback.GET };
}

describe("Microsoft login through the OAuth routes", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await new OptionsRepository(db).set("emdash:setup_complete", true);
		await db
			.insertInto("allowed_domains")
			.values({ domain: "contoso.com", default_role: 30, enabled: 1 })
			.execute();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.doUnmock("virtual:emdash/env");
		vi.resetModules();
		await teardownTestDatabase(db);
	});

	/** Runs start and callback; Microsoft's token endpoint answers with `claims(nonce)`. */
	async function signIn(
		claims: (nonce: string) => JWTPayload,
		options: MicrosoftProviderOptions = {},
	): Promise<string> {
		const { start, callback } = await loadRoutes(ENV);
		const locals = { emdash: { db, config: { authProviders: [microsoft(options)] } } };

		const started = await start({
			params: { provider: "microsoft" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/microsoft"),
			locals,
			redirect,
		} as unknown as Parameters<typeof start>[0]);
		const authorizeUrl = new URL(started.headers.get("Location") ?? "");
		expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
			`${LOGIN}/${TENANT}/oauth2/v2.0/authorize`,
		);
		const nonce = authorizeUrl.searchParams.get("nonce") ?? "";
		const state = authorizeUrl.searchParams.get("state") ?? "";

		const idToken = await new SignJWT(claims(nonce))
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === `${LOGIN}/${TENANT}/oauth2/v2.0/token`) {
					return Response.json({ access_token: "access-token", id_token: idToken });
				}
				if (url === `${LOGIN}/${TENANT}/discovery/v2.0/keys`) {
					return Response.json({ keys: [publicJwk] });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);

		const finished = await callback({
			params: { provider: "microsoft" },
			request: new Request(
				`http://localhost:4321/_emdash/api/auth/oauth/microsoft/callback?code=auth-code&state=${state}`,
			),
			locals,
			session: undefined,
			redirect,
		} as unknown as Parameters<typeof callback>[0]);
		return finished.headers.get("Location") ?? "";
	}

	function member(nonce: string): JWTPayload {
		return {
			sub: "member-sub",
			iss: `${LOGIN}/${TENANT}/v2.0`,
			tid: TENANT,
			nonce,
			email: "ada@contoso.com",
			preferred_username: "ada@contoso.com",
			name: "Ada",
		};
	}

	function guest(nonce: string): JWTPayload {
		return { ...member(nonce), sub: "guest-sub", idp: `${LOGIN}/${OTHER_TENANT}/v2.0` };
	}

	async function userByEmail(email: string) {
		return db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
	}

	it("signs up a member of the configured tenant through an allowed domain", async () => {
		expect(await signIn(member)).toBe("/_emdash/admin");
		const user = await userByEmail("ada@contoso.com");
		expect(user?.email_verified).toBe(1);
	});

	it("refuses self-signup for a guest", async () => {
		expect(await signIn(guest)).toContain("error=signup_not_allowed");
		expect(await userByEmail("ada@contoso.com")).toBeUndefined();
	});

	it("lets a guest sign up when the site sets emailVerified", async () => {
		expect(await signIn(guest, { emailVerified: true })).toBe("/_emdash/admin");
		expect(await userByEmail("ada@contoso.com")).toBeDefined();
	});

	it("refuses to link a member whose email lies outside the directory's domains", async () => {
		await createKyselyAdapter(db).createUser({
			email: "owner@fabrikam.com",
			name: "Owner",
			role: Role.ADMIN,
			emailVerified: true,
		});
		const location = await signIn((nonce) => ({
			...member(nonce),
			email: "owner@fabrikam.com",
			preferred_username: "mallory@contoso.com",
		}));
		expect(location).toContain("error=signup_not_allowed");
		expect(await db.selectFrom("oauth_accounts").selectAll().execute()).toEqual([]);
	});

	it("rejects an ID token that carries another flow's nonce", async () => {
		const location = await signIn((nonce) => member(`${nonce}-other`));
		expect(location).toContain("error=id_token_invalid");
		expect(await userByEmail("ada@contoso.com")).toBeUndefined();
	});

	it("treats a tenant given as a domain name as not configured", async () => {
		const { start } = await loadRoutes({
			...ENV,
			EMDASH_OAUTH_MICROSOFT_TENANT_ID: "contoso.onmicrosoft.com",
		});
		const response = await start({
			params: { provider: "microsoft" },
			request: new Request("http://localhost:4321/_emdash/api/auth/oauth/microsoft"),
			locals: { emdash: { db, config: { authProviders: [microsoft()] } } },
			redirect,
		} as unknown as Parameters<typeof start>[0]);
		expect(response.headers.get("Location")).toContain("error=provider_not_configured");
	});
});
