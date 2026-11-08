/**
 * Integration tests for OAuth 2.1 Authorization Code + PKCE handlers.
 *
 * Tests the full authorization code flow lifecycle against a real
 * in-memory SQLite database.
 */

import {
	computeS256Challenge,
	generateToken as generateCodeVerifier,
	Role,
} from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildDeniedRedirect,
	cleanupExpiredAuthorizationCodes,
	handleAuthorizationApproval,
	handleAuthorizationCodeExchange,
} from "../../../src/api/handlers/oauth-authorization.js";
import { handleOAuthClientCreate } from "../../../src/api/handlers/oauth-clients.js";
import { hashApiToken } from "../../../src/auth/api-tokens.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

const ACCESS_TOKEN_PREFIX_REGEX = /^ec_oat_/;
const REFRESH_TOKEN_PREFIX_REGEX = /^ec_ort_/;

let db: Kysely<Database>;

beforeEach(async () => {
	db = await setupTestDatabase();

	// Create a test user
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

	// Register OAuth clients used by tests
	await handleOAuthClientCreate(db, {
		id: "test-client",
		name: "Test Client",
		redirectUris: ["http://127.0.0.1:8080/callback", "https://myapp.example.com/callback"],
	});

	await handleOAuthClientCreate(db, {
		id: "test",
		name: "Test",
		redirectUris: ["http://127.0.0.1:8080/callback"],
	});
});

afterEach(async () => {
	await db.destroy();
});

describe("Authorization Approval", () => {
	it("should create an authorization code with valid params", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read content:write",
			state: "random-state-value",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const redirectUrl = new URL(result.data.redirect_url);
		expect(redirectUrl.origin).toBe("http://127.0.0.1:8080");
		expect(redirectUrl.pathname).toBe("/callback");
		expect(redirectUrl.searchParams.get("code")).toBeTruthy();
		expect(redirectUrl.searchParams.get("state")).toBe("random-state-value");
	});

	it("should reject unsupported response_type", async () => {
		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "token",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: "test",
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("UNSUPPORTED_RESPONSE_TYPE");
	});

	it("should reject plain HTTP redirect to non-localhost", async () => {
		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://evil.com/callback",
			scope: "content:read",
			code_challenge: "test",
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_REDIRECT_URI");
	});

	it("should allow HTTPS redirects", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "https://myapp.example.com/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(true);
	});

	it("should reject plain code challenge method", async () => {
		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: "test",
			code_challenge_method: "plain",
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_REQUEST");
	});

	it("should reject invalid scopes", async () => {
		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "invalid:scope",
			code_challenge: "test",
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_SCOPE");
	});
});

describe("Authorization Code Exchange: Full Flow", () => {
	it("should exchange code for tokens with valid PKCE", async () => {
		// Step 1: Generate PKCE pair
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		// Step 2: Get authorization code
		const approvalResult = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read content:write media:read",
			state: "state123",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		expect(approvalResult.success).toBe(true);
		if (!approvalResult.success) return;

		const redirectUrl = new URL(approvalResult.data.redirect_url);
		const code = redirectUrl.searchParams.get("code")!;

		// Step 3: Exchange code for tokens
		const exchangeResult = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:8080/callback",
			client_id: "test-client",
			code_verifier: codeVerifier,
		});
		expect(exchangeResult.success).toBe(true);
		if (!exchangeResult.success) return;

		expect(exchangeResult.data.access_token).toMatch(ACCESS_TOKEN_PREFIX_REGEX);
		expect(exchangeResult.data.refresh_token).toMatch(REFRESH_TOKEN_PREFIX_REGEX);
		expect(exchangeResult.data.token_type).toBe("Bearer");
		expect(exchangeResult.data.expires_in).toBe(3600);
		expect(exchangeResult.data.scope).toBe("content:read content:write media:read");

		// Step 4: Verify tokens are stored
		const accessHash = hashApiToken(exchangeResult.data.access_token);
		const accessRow = await db
			.selectFrom("_emdash_oauth_tokens")
			.selectAll()
			.where("token_hash", "=", accessHash)
			.executeTakeFirst();
		expect(accessRow).toBeTruthy();
		expect(accessRow!.token_type).toBe("access");
		expect(accessRow!.user_id).toBe("user-1");
		expect(accessRow!.client_id).toBe("test-client");

		// Step 5: Authorization code is consumed (single-use)
		const codeHash = hashApiToken(code);
		const codeRow = await db
			.selectFrom("_emdash_authorization_codes")
			.selectAll()
			.where("code_hash", "=", codeHash)
			.executeTakeFirst();
		expect(codeRow).toBeUndefined();
	});

	it("should reject wrong code verifier (PKCE failure)", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const approvalResult = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		expect(approvalResult.success).toBe(true);
		if (!approvalResult.success) return;

		const redirectUrl = new URL(approvalResult.data.redirect_url);
		const code = redirectUrl.searchParams.get("code")!;

		// Use a DIFFERENT code verifier
		const wrongVerifier = generateCodeVerifier();
		const exchangeResult = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:8080/callback",
			client_id: "test-client",
			code_verifier: wrongVerifier,
		});

		expect(exchangeResult.success).toBe(false);
		if (exchangeResult.success) return;
		expect(exchangeResult.error.code).toBe("invalid_grant");
		expect(exchangeResult.error.message).toContain("PKCE");

		// Code should be deleted after failed PKCE verification
		const codeHash = hashApiToken(code);
		const codeRow = await db
			.selectFrom("_emdash_authorization_codes")
			.selectAll()
			.where("code_hash", "=", codeHash)
			.executeTakeFirst();
		expect(codeRow).toBeUndefined();
	});

	it("should reject mismatched redirect_uri", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const approvalResult = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		expect(approvalResult.success).toBe(true);
		if (!approvalResult.success) return;

		const redirectUrl = new URL(approvalResult.data.redirect_url);
		const code = redirectUrl.searchParams.get("code")!;

		const exchangeResult = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:9999/different",
			client_id: "test-client",
			code_verifier: codeVerifier,
		});

		expect(exchangeResult.success).toBe(false);
		if (exchangeResult.success) return;
		expect(exchangeResult.error.code).toBe("invalid_grant");
		expect(exchangeResult.error.message).toContain("redirect_uri");
	});

	it("should reject mismatched client_id", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const approvalResult = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		expect(approvalResult.success).toBe(true);
		if (!approvalResult.success) return;

		const redirectUrl = new URL(approvalResult.data.redirect_url);
		const code = redirectUrl.searchParams.get("code")!;

		const exchangeResult = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:8080/callback",
			client_id: "different-client",
			code_verifier: codeVerifier,
		});

		expect(exchangeResult.success).toBe(false);
		if (exchangeResult.success) return;
		expect(exchangeResult.error.code).toBe("invalid_grant");
		expect(exchangeResult.error.message).toContain("client_id");
	});

	it("should reject expired authorization code", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		// Insert an expired code directly
		const code = generateCodeVerifier();
		const codeHash = hashApiToken(code);

		await db
			.insertInto("_emdash_authorization_codes")
			.values({
				code_hash: codeHash,
				client_id: "test-client",
				redirect_uri: "http://127.0.0.1:8080/callback",
				user_id: "user-1",
				scopes: JSON.stringify(["content:read"]),
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				resource: null,
				expires_at: new Date(Date.now() - 1000).toISOString(), // Already expired
			})
			.execute();

		const exchangeResult = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:8080/callback",
			client_id: "test-client",
			code_verifier: codeVerifier,
		});

		expect(exchangeResult.success).toBe(false);
		if (exchangeResult.success) return;
		expect(exchangeResult.error.code).toBe("invalid_grant");
		expect(exchangeResult.error.message).toContain("expired");
	});

	it("should reject code reuse (single-use enforcement)", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const approvalResult = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});
		expect(approvalResult.success).toBe(true);
		if (!approvalResult.success) return;

		const redirectUrl = new URL(approvalResult.data.redirect_url);
		const code = redirectUrl.searchParams.get("code")!;

		// First exchange succeeds
		const first = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:8080/callback",
			client_id: "test-client",
			code_verifier: codeVerifier,
		});
		expect(first.success).toBe(true);

		// Second exchange with same code fails
		const second = await handleAuthorizationCodeExchange(db, {
			grant_type: "authorization_code",
			code,
			redirect_uri: "http://127.0.0.1:8080/callback",
			client_id: "test-client",
			code_verifier: codeVerifier,
		});
		expect(second.success).toBe(false);
		if (second.success) return;
		expect(second.error.code).toBe("invalid_grant");
	});
});

describe("buildDeniedRedirect", () => {
	it("should include error and state params", () => {
		const url = buildDeniedRedirect("http://127.0.0.1:8080/callback", "state123");
		const parsed = new URL(url);

		expect(parsed.searchParams.get("error")).toBe("access_denied");
		expect(parsed.searchParams.get("error_description")).toBeTruthy();
		expect(parsed.searchParams.get("state")).toBe("state123");
	});

	it("should omit state when not provided", () => {
		const url = buildDeniedRedirect("http://127.0.0.1:8080/callback");
		const parsed = new URL(url);

		expect(parsed.searchParams.get("error")).toBe("access_denied");
		expect(parsed.searchParams.has("state")).toBe(false);
	});
});

describe("cleanupExpiredAuthorizationCodes", () => {
	it("should delete expired codes", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		// Insert an expired code
		await db
			.insertInto("_emdash_authorization_codes")
			.values({
				code_hash: "expired-hash",
				client_id: "test",
				redirect_uri: "http://127.0.0.1:8080/callback",
				user_id: "user-1",
				scopes: JSON.stringify(["content:read"]),
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				resource: null,
				expires_at: new Date(Date.now() - 1000).toISOString(),
			})
			.execute();

		// Insert a valid code
		await db
			.insertInto("_emdash_authorization_codes")
			.values({
				code_hash: "valid-hash",
				client_id: "test",
				redirect_uri: "http://127.0.0.1:8080/callback",
				user_id: "user-1",
				scopes: JSON.stringify(["content:read"]),
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				resource: null,
				expires_at: new Date(Date.now() + 600000).toISOString(),
			})
			.execute();

		const deleted = await cleanupExpiredAuthorizationCodes(db);
		expect(deleted).toBe(1);

		// Valid code should remain
		const remaining = await db.selectFrom("_emdash_authorization_codes").selectAll().execute();
		expect(remaining).toHaveLength(1);
		expect(remaining[0]!.code_hash).toBe("valid-hash");
	});
});
