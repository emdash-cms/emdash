/**
 * Integration tests for OAuth client management and redirect URI allowlist.
 *
 * Tests that the authorization endpoint rejects unregistered clients and
 * redirect URIs not in the client's registered set.
 */

import { computeS256Challenge, Role } from "@emdash-cms/auth";
import { generateCodeVerifier } from "arctic";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleAuthorizationApproval } from "../../../src/api/handlers/oauth-authorization.js";
import {
	handleOAuthClientCreate,
	handleOAuthClientDelete,
	handleOAuthClientGet,
	handleOAuthClientList,
	handleOAuthClientUpdate,
	lookupOAuthClient,
	validateClientRedirectUri,
} from "../../../src/api/handlers/oauth-clients.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

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
});

afterEach(async () => {
	await db.destroy();
});

// ---------------------------------------------------------------------------
// validateClientRedirectUri (unit-level)
// ---------------------------------------------------------------------------

describe("validateClientRedirectUri", () => {
	it("should return null for a registered redirect URI", () => {
		const result = validateClientRedirectUri("https://myapp.example.com/callback", [
			"https://myapp.example.com/callback",
			"http://127.0.0.1:8080/callback",
		]);
		expect(result).toBeNull();
	});

	it("should return error for an unregistered redirect URI", () => {
		const result = validateClientRedirectUri("https://evil.com/callback", [
			"https://myapp.example.com/callback",
		]);
		expect(result).toBeTruthy();
	});

	it("should require exact match (no prefix matching)", () => {
		const result = validateClientRedirectUri("https://myapp.example.com/callback/extra", [
			"https://myapp.example.com/callback",
		]);
		expect(result).toBeTruthy();
	});

	it("should require exact match (no query string tolerance)", () => {
		const result = validateClientRedirectUri("https://myapp.example.com/callback?foo=bar", [
			"https://myapp.example.com/callback",
		]);
		expect(result).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// OAuth Client CRUD
// ---------------------------------------------------------------------------

describe("OAuth Client CRUD", () => {
	it("should create a client", async () => {
		const result = await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.id).toBe("test-client");
		expect(result.data.name).toBe("Test Client");
		expect(result.data.redirectUris).toEqual(["https://myapp.example.com/callback"]);
	});

	it("should reject duplicate client IDs", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
		});

		const result = await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Duplicate Client",
			redirectUris: ["https://other.example.com/callback"],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("CONFLICT");
	});

	it("should reject clients with empty redirect URIs", async () => {
		const result = await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: [],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("should reject clients with invalid redirect URIs", async () => {
		const result = await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["http://example.com/callback"],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(result.error.message).toContain("HTTP redirect URIs are only allowed for localhost");
	});

	it("should list clients", async () => {
		await handleOAuthClientCreate(db, {
			id: "client-1",
			name: "Client 1",
			redirectUris: ["https://one.example.com/callback"],
		});
		await handleOAuthClientCreate(db, {
			id: "client-2",
			name: "Client 2",
			redirectUris: ["https://two.example.com/callback"],
		});

		const result = await handleOAuthClientList(db);
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.items).toHaveLength(2);
	});

	it("should get a client by ID", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
			scopes: ["content:read"],
		});

		const result = await handleOAuthClientGet(db, "test-client");
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.id).toBe("test-client");
		expect(result.data.scopes).toEqual(["content:read"]);
	});

	it("should return NOT_FOUND for unknown client", async () => {
		const result = await handleOAuthClientGet(db, "unknown");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});

	it("should update a client", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
		});

		const result = await handleOAuthClientUpdate(db, "test-client", {
			name: "Updated Client",
			redirectUris: ["https://myapp.example.com/callback", "https://myapp.example.com/callback2"],
		});

		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.name).toBe("Updated Client");
		expect(result.data.redirectUris).toHaveLength(2);
	});

	it("should reject update with empty redirect URIs", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
		});

		const result = await handleOAuthClientUpdate(db, "test-client", {
			redirectUris: [],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
	});

	it("should reject update with invalid redirect URIs", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
		});

		const result = await handleOAuthClientUpdate(db, "test-client", {
			redirectUris: ["myapp://callback"],
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("VALIDATION_ERROR");
		expect(result.error.message).toContain("Unsupported redirect URI scheme");
	});

	it("should delete a client", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback"],
		});

		const result = await handleOAuthClientDelete(db, "test-client");
		expect(result.success).toBe(true);

		const getResult = await handleOAuthClientGet(db, "test-client");
		expect(getResult.success).toBe(false);
	});

	it("should return NOT_FOUND when deleting unknown client", async () => {
		const result = await handleOAuthClientDelete(db, "unknown");
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("NOT_FOUND");
	});
});

// ---------------------------------------------------------------------------
// lookupOAuthClient
// ---------------------------------------------------------------------------

describe("lookupOAuthClient", () => {
	it("should return redirect URIs for a registered client", async () => {
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["https://myapp.example.com/callback", "http://127.0.0.1:8080/callback"],
		});

		const client = await lookupOAuthClient(db, "test-client");
		expect(client).toBeTruthy();
		expect(client!.redirectUris).toEqual([
			"https://myapp.example.com/callback",
			"http://127.0.0.1:8080/callback",
		]);
	});

	it("should return null for an unregistered client", async () => {
		const client = await lookupOAuthClient(db, "unknown-client");
		expect(client).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Authorization with client redirect URI validation
// ---------------------------------------------------------------------------

describe("Authorization with redirect URI allowlist", () => {
	beforeEach(async () => {
		// Register a client with specific redirect URIs
		await handleOAuthClientCreate(db, {
			id: "test-client",
			name: "Test Client",
			redirectUris: ["http://127.0.0.1:8080/callback", "https://myapp.example.com/callback"],
		});
	});

	it("should approve authorization with a registered redirect URI", async () => {
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
		expect(redirectUrl.searchParams.get("code")).toBeTruthy();
	});

	it("should reject authorization with unregistered redirect URI", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "test-client",
			redirect_uri: "https://evil.example.com/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_REDIRECT_URI");
		expect(result.error.message).toContain("not registered");
	});

	it("should reject authorization with unknown client_id", async () => {
		const codeVerifier = generateCodeVerifier();
		const codeChallenge = computeS256Challenge(codeVerifier);

		const result = await handleAuthorizationApproval(db, "user-1", Role.ADMIN, {
			response_type: "code",
			client_id: "unknown-client",
			redirect_uri: "http://127.0.0.1:8080/callback",
			scope: "content:read",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
		});

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_CLIENT");
	});

	it("should accept HTTPS redirect URI in allowlist", async () => {
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
});
