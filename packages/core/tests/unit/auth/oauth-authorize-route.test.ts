import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleOAuthClientCreate } from "../../../src/api/handlers/oauth-clients.js";
import {
	GET as getAuthorizationConsent,
	POST as postAuthorizationConsent,
} from "../../../src/astro/routes/api/oauth/authorize.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const REDIRECT_URI = "http://127.0.0.1:8080/callback";

describe("OAuth authorization consent", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();

		await db
			.insertInto("users")
			.values({
				id: "user-1",
				email: "test@example.com",
				name: "Test User",
				role: 50,
				email_verified: 1,
			})
			.execute();

		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: [REDIRECT_URI],
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("renders every requested scope as a checked choice with accurate grant copy", async () => {
		const { response } = await renderConsent([
			"content:read",
			"content:write",
			"schema:write",
			"mcp:tools:calendar",
		]);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('<input type="checkbox" name="scope" value="content:read" checked>');
		expect(html).toContain('<input type="checkbox" name="scope" value="schema:write" checked>');
		expect(html).toContain(
			'<input type="checkbox" name="scope" value="mcp:tools:calendar" checked>',
		);
		expect(html).toContain("Create, edit, and delete content; manage menus and taxonomies");
		expect(html).not.toContain('<input type="hidden" name="scope"');
		const form = html.slice(html.indexOf("<form"), html.indexOf("</form>"));
		expect(form).toContain('<input type="checkbox" name="scope" value="content:read"');
	});

	it("grants only selected scopes from the original request", async () => {
		const consent = await renderConsent(["content:read", "schema:write"]);
		const response = await submitConsent(consent, ["admin", "content:read"]);

		expect(response.status).toBe(302);
		expect(new URL(response.headers.get("Location")!).searchParams.get("code")).toBeTruthy();

		const authorizationCode = await db
			.selectFrom("_emdash_authorization_codes")
			.select("scopes")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(authorizationCode.scopes)).toEqual(["content:read"]);
	});

	it("renders duplicate requests once so clearing a scope removes it", async () => {
		const consent = await renderConsent(["admin", "admin", "content:read"]);
		const html = await consent.response.clone().text();
		expect(html.match(/name="scope" value="admin"/g)).toHaveLength(1);

		const response = await submitConsent(consent, ["content:read"]);
		expect(response.status).toBe(302);

		const authorizationCode = await db
			.selectFrom("_emdash_authorization_codes")
			.select("scopes")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(authorizationCode.scopes)).toEqual(["content:read"]);
	});

	it("preserves client and role scope clamps after selection", async () => {
		await db
			.updateTable("_emdash_oauth_clients")
			.set({ scopes: JSON.stringify(["content:read", "schema:write"]) })
			.where("id", "=", "test-client")
			.execute();

		const consent = await renderConsent(["content:read", "media:read", "schema:write"]);
		const response = await submitConsent(
			consent,
			["content:read", "media:read", "schema:write"],
			20,
		);

		expect(response.status).toBe(302);
		const authorizationCode = await db
			.selectFrom("_emdash_authorization_codes")
			.select("scopes")
			.executeTakeFirstOrThrow();
		expect(JSON.parse(authorizationCode.scopes)).toEqual(["content:read"]);
	});

	it("rejects approval when no requested scope is selected", async () => {
		const consent = await renderConsent(["content:read", "schema:write"]);
		const response = await submitConsent(consent, []);

		expect(response.status).toBe(302);
		const redirect = new URL(response.headers.get("Location")!);
		expect(redirect.searchParams.get("error")).toBe("invalid_scope");
		expect(redirect.searchParams.get("error_description")).toBe(
			"No selected permission can be granted",
		);

		const authorizationCodes = await db
			.selectFrom("_emdash_authorization_codes")
			.select("code_hash")
			.execute();
		expect(authorizationCodes).toHaveLength(0);
	});

	async function renderConsent(scopes: string[]): Promise<{
		response: Response;
		url: URL;
		csrfToken: string;
		cookie: string;
	}> {
		const url = new URL("http://localhost:4321/_emdash/oauth/authorize");
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", "test-client");
		url.searchParams.set("redirect_uri", REDIRECT_URI);
		url.searchParams.set("scope", scopes.join(" "));
		url.searchParams.set("state", "state-1");
		url.searchParams.set("code_challenge", "challenge");
		url.searchParams.set("code_challenge_method", "S256");

		const response = await getAuthorizationConsent({
			url,
			request: new Request(url),
			locals: {
				emdash: { db, config: {} },
				user: {
					id: "user-1",
					email: "test@example.com",
					name: "Test User",
					role: 50,
				},
			},
		} as Parameters<typeof getAuthorizationConsent>[0]);

		const html = response.clone();
		const csrfToken = (await html.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
		const cookie = response.headers.get("Set-Cookie")?.split(";")[0];
		if (!csrfToken || !cookie) throw new Error("Consent response omitted CSRF state");

		return { response, url, csrfToken, cookie };
	}

	async function submitConsent(
		consent: Awaited<ReturnType<typeof renderConsent>>,
		selectedScopes: string[],
		role = 50,
	): Promise<Response> {
		const body = new URLSearchParams({
			csrf_token: consent.csrfToken,
			response_type: "code",
			client_id: "test-client",
			redirect_uri: REDIRECT_URI,
			state: "state-1",
			code_challenge: "challenge",
			code_challenge_method: "S256",
			action: "approve",
		});
		for (const scope of selectedScopes) body.append("scope", scope);

		const request = new Request(consent.url, {
			method: "POST",
			headers: { Cookie: consent.cookie },
			body,
		});

		return postAuthorizationConsent({
			request,
			locals: {
				emdash: { db, config: {} },
				user: {
					id: "user-1",
					email: "test@example.com",
					name: "Test User",
					role,
				},
			},
		} as Parameters<typeof postAuthorizationConsent>[0]);
	}
});
