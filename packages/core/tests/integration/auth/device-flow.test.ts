/**
 * Integration tests for OAuth Device Flow handlers.
 *
 * Tests the full device flow lifecycle against a real in-memory SQLite database.
 */

import { Role } from "@emdash-cms/auth";
import type { RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleDeviceAuthorize,
	handleDeviceCodeRequest,
	handleDeviceTokenExchange,
	handleTokenRefresh,
	handleTokenRevoke,
} from "../../../src/api/handlers/device-flow.js";
import { hashApiToken } from "../../../src/auth/api-tokens.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

const USER_CODE_FORMAT_REGEX = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const ACCESS_TOKEN_PREFIX_REGEX = /^ec_oat_/;
const REFRESH_TOKEN_PREFIX_REGEX = /^ec_ort_/;
const HYPHEN_REGEX = /-/g;

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

describe("Device Code Request", () => {
	it("should create a device code with default scopes", async () => {
		const result = await handleDeviceCodeRequest(
			db,
			{ client_id: "emdash-cli" },
			"https://example.com/_emdash/device",
		);

		expect(result.success).toBe(true);
		if (!result.success) return;

		expect(result.data.device_code).toBeTruthy();
		expect(result.data.user_code).toMatch(USER_CODE_FORMAT_REGEX);
		expect(result.data.verification_uri).toBe("https://example.com/_emdash/device");
		expect(result.data.expires_in).toBe(900); // 15 minutes
		expect(result.data.interval).toBe(5);
	});

	it("should create a device code with custom scopes", async () => {
		const result = await handleDeviceCodeRequest(
			db,
			{ scope: "content:read media:read" },
			"https://example.com/_emdash/device",
		);

		expect(result.success).toBe(true);
		if (!result.success) return;

		// Verify scopes were stored
		const row = await db
			.selectFrom("_emdash_device_codes")
			.selectAll()
			.where("device_code", "=", result.data.device_code)
			.executeTakeFirst();

		expect(row).toBeTruthy();
		expect(JSON.parse(row!.scopes)).toEqual(["content:read", "media:read"]);
	});

	it("should reject invalid scopes", async () => {
		const result = await handleDeviceCodeRequest(
			db,
			{ scope: "invalid:scope" },
			"https://example.com/_emdash/device",
		);

		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_SCOPE");
	});
});

describe("Device Flow: Full Lifecycle", () => {
	it("should complete the full device flow: code → authorize → exchange", async () => {
		// Step 1: Request device code
		const codeResult = await handleDeviceCodeRequest(
			db,
			{ client_id: "emdash-cli" },
			"https://example.com/_emdash/device",
		);
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		const { device_code, user_code } = codeResult.data;

		// Step 2: Poll before authorization → pending
		const pendingResult = await handleDeviceTokenExchange(db, {
			device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(pendingResult.success).toBe(false);
		expect(pendingResult.deviceFlowError).toBe("authorization_pending");

		// Step 3: User authorizes (admin role = 50)
		const authResult = await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code,
		});
		expect(authResult.success).toBe(true);
		if (!authResult.success) return;
		expect(authResult.data.authorized).toBe(true);

		// Step 4: Exchange for tokens
		const tokenResult = await handleDeviceTokenExchange(db, {
			device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(tokenResult.success).toBe(true);
		if (!tokenResult.success) return;

		expect(tokenResult.data.access_token).toMatch(ACCESS_TOKEN_PREFIX_REGEX);
		expect(tokenResult.data.refresh_token).toMatch(REFRESH_TOKEN_PREFIX_REGEX);
		expect(tokenResult.data.token_type).toBe("Bearer");
		expect(tokenResult.data.expires_in).toBe(3600);
		expect(tokenResult.data.scope).toBeTruthy();

		// Step 5: Device code should be consumed
		const row = await db
			.selectFrom("_emdash_device_codes")
			.selectAll()
			.where("device_code", "=", device_code)
			.executeTakeFirst();
		expect(row).toBeUndefined();

		// Step 6: Tokens should be stored
		const accessHash = hashApiToken(tokenResult.data.access_token);
		const accessRow = await db
			.selectFrom("_emdash_oauth_tokens")
			.selectAll()
			.where("token_hash", "=", accessHash)
			.executeTakeFirst();
		expect(accessRow).toBeTruthy();
		expect(accessRow!.token_type).toBe("access");
		expect(accessRow!.user_id).toBe("user-1");

		const refreshHash = hashApiToken(tokenResult.data.refresh_token);
		const refreshRow = await db
			.selectFrom("_emdash_oauth_tokens")
			.selectAll()
			.where("token_hash", "=", refreshHash)
			.executeTakeFirst();
		expect(refreshRow).toBeTruthy();
		expect(refreshRow!.token_type).toBe("refresh");
	});

	it("should handle denied authorization", async () => {
		const codeResult = await handleDeviceCodeRequest(db, {}, "https://example.com/_emdash/device");
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		// User denies
		const authResult = await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: codeResult.data.user_code,
			action: "deny",
		});
		expect(authResult.success).toBe(true);
		if (!authResult.success) return;
		expect(authResult.data.authorized).toBe(false);

		// Exchange should return access_denied
		const tokenResult = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(tokenResult.success).toBe(false);
		expect(tokenResult.deviceFlowError).toBe("access_denied");
	});

	it("should normalize user codes (strip hyphens, case-insensitive)", async () => {
		const codeResult = await handleDeviceCodeRequest(db, {}, "https://example.com/_emdash/device");
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		// Submit lowercase without hyphen
		const code = codeResult.data.user_code.replace(HYPHEN_REGEX, "").toLowerCase();
		const authResult = await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: code,
		});
		expect(authResult.success).toBe(true);
	});
});

describe("Device Token Exchange: Error Cases", () => {
	it("should reject invalid grant_type", async () => {
		const result = await handleDeviceTokenExchange(db, {
			device_code: "whatever",
			grant_type: "invalid",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("UNSUPPORTED_GRANT_TYPE");
	});

	it("should reject unknown device codes", async () => {
		const result = await handleDeviceTokenExchange(db, {
			device_code: "nonexistent",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_GRANT");
	});

	it("should reject a second exchange for an already-consumed device code", async () => {
		const codeResult = await handleDeviceCodeRequest(
			db,
			{ client_id: "emdash-cli" },
			"https://example.com/_emdash/device",
		);
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: codeResult.data.user_code,
		});

		// First exchange succeeds
		const first = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(first.success).toBe(true);

		// Second exchange fails — device code was consumed atomically
		const second = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(second.success).toBe(false);
		if (second.success) return;
		expect(second.error.code).toBe("INVALID_GRANT");
	});

	it("should report expired device codes", async () => {
		// Create a device code that's already expired
		await db
			.insertInto("_emdash_device_codes")
			.values({
				device_code: "expired-code",
				user_code: "AAAA-BBBB",
				scopes: JSON.stringify(["content:read"]),
				status: "pending",
				expires_at: new Date(Date.now() - 1000).toISOString(),
				interval: 5,
			})
			.execute();

		const result = await handleDeviceTokenExchange(db, {
			device_code: "expired-code",
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(result.success).toBe(false);
		expect(result.deviceFlowError).toBe("expired_token");
	});
});

describe("Token Refresh", () => {
	it("should exchange a refresh token for a new access token", async () => {
		// Complete a device flow first to get tokens
		const codeResult = await handleDeviceCodeRequest(db, {}, "https://example.com/_emdash/device");
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: codeResult.data.user_code,
		});

		const tokenResult = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		expect(tokenResult.success).toBe(true);
		if (!tokenResult.success) return;

		// Refresh
		const refreshResult = await handleTokenRefresh(db, {
			refresh_token: tokenResult.data.refresh_token,
			grant_type: "refresh_token",
		});
		expect(refreshResult.success).toBe(true);
		if (!refreshResult.success) return;

		expect(refreshResult.data.access_token).toMatch(ACCESS_TOKEN_PREFIX_REGEX);
		expect(refreshResult.data.access_token).not.toBe(tokenResult.data.access_token);
		expect(refreshResult.data.refresh_token).toBe(tokenResult.data.refresh_token);
		expect(refreshResult.data.expires_in).toBe(3600);
	});

	it("should reject invalid refresh tokens", async () => {
		const result = await handleTokenRefresh(db, {
			refresh_token: "ec_ort_invalid",
			grant_type: "refresh_token",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_GRANT");
	});

	it("should reject wrong grant_type", async () => {
		const result = await handleTokenRefresh(db, {
			refresh_token: "ec_ort_whatever",
			grant_type: "authorization_code",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("UNSUPPORTED_GRANT_TYPE");
	});

	it("should reject wrong token prefix", async () => {
		const result = await handleTokenRefresh(db, {
			refresh_token: "ec_pat_notarefresh",
			grant_type: "refresh_token",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_GRANT");
	});
});

describe("Token Revoke", () => {
	it("should revoke an access token", async () => {
		// Get tokens via device flow
		const codeResult = await handleDeviceCodeRequest(db, {}, "https://example.com/_emdash/device");
		if (!codeResult.success) return;

		await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: codeResult.data.user_code,
		});

		const tokenResult = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (!tokenResult.success) return;

		// Revoke the access token
		const revokeResult = await handleTokenRevoke(db, {
			token: tokenResult.data.access_token,
		});
		expect(revokeResult.success).toBe(true);

		// Access token should be gone
		const accessHash = hashApiToken(tokenResult.data.access_token);
		const row = await db
			.selectFrom("_emdash_oauth_tokens")
			.selectAll()
			.where("token_hash", "=", accessHash)
			.executeTakeFirst();
		expect(row).toBeUndefined();
	});

	it("should revoke a refresh token and its access tokens", async () => {
		// Get tokens via device flow
		const codeResult = await handleDeviceCodeRequest(db, {}, "https://example.com/_emdash/device");
		if (!codeResult.success) return;

		await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: codeResult.data.user_code,
		});

		const tokenResult = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (!tokenResult.success) return;

		// Revoke the refresh token
		const revokeResult = await handleTokenRevoke(db, {
			token: tokenResult.data.refresh_token,
		});
		expect(revokeResult.success).toBe(true);

		// Both tokens should be gone
		const tokenCount = await db
			.selectFrom("_emdash_oauth_tokens")
			.select(db.fn.count("token_hash").as("count"))
			.executeTakeFirst();
		expect(Number(tokenCount?.count ?? 0)).toBe(0);
	});

	it("should return success for unknown tokens (RFC 7009)", async () => {
		const result = await handleTokenRevoke(db, {
			token: "ec_oat_nonexistent",
		});
		expect(result.success).toBe(true);
	});
});

describe("Device Authorize: Error Cases", () => {
	it("should reject invalid user codes", async () => {
		const result = await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: "INVALID-CODE",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("INVALID_CODE");
	});

	it("should reject expired device codes", async () => {
		await db
			.insertInto("_emdash_device_codes")
			.values({
				device_code: "expired-dc",
				user_code: "CCCC-DDDD",
				scopes: JSON.stringify(["content:read"]),
				status: "pending",
				expires_at: new Date(Date.now() - 1000).toISOString(),
				interval: 5,
			})
			.execute();

		const result = await handleDeviceAuthorize(db, "user-1", Role.ADMIN, {
			user_code: "CCCC-DDDD",
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		expect(result.error.code).toBe("EXPIRED_CODE");
	});
});

// ---------------------------------------------------------------------------
// Scope escalation prevention (SEC: CWE-269)
// ---------------------------------------------------------------------------

describe("Scope Clamping: Role-based scope restriction", () => {
	/** Helper: run a full device flow with given requested scopes and user role */
	async function completeDeviceFlow(
		requestedScopes: string,
		userRole: RoleLevel,
	): Promise<{ scopes: string; success: boolean }> {
		const codeResult = await handleDeviceCodeRequest(
			db,
			{ scope: requestedScopes },
			"https://example.com/_emdash/device",
		);
		if (!codeResult.success) return { scopes: "", success: false };

		const authResult = await handleDeviceAuthorize(db, "user-1", userRole, {
			user_code: codeResult.data.user_code,
		});
		if (!authResult.success) return { scopes: "", success: false };

		const tokenResult = await handleDeviceTokenExchange(db, {
			device_code: codeResult.data.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (!tokenResult.success) return { scopes: "", success: false };

		return { scopes: tokenResult.data.scope, success: true };
	}

	it("should strip admin scope from non-admin user tokens", async () => {
		// CONTRIBUTOR requests admin scope — this is the core attack scenario
		const result = await completeDeviceFlow("content:read content:write admin", Role.CONTRIBUTOR);
		expect(result.success).toBe(true);

		const scopes = result.scopes.split(" ");
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("content:write");
		expect(scopes).not.toContain("admin");
	});

	it("should strip schema:write from non-admin user tokens", async () => {
		// EDITOR requests schema:write — only ADMIN gets schema:write
		const result = await completeDeviceFlow("content:read schema:read schema:write", Role.EDITOR);
		expect(result.success).toBe(true);

		const scopes = result.scopes.split(" ");
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("schema:read");
		expect(scopes).not.toContain("schema:write");
	});

	it("should strip schema:read from contributor tokens", async () => {
		// CONTRIBUTOR requests schema:read — only EDITOR+ gets schema:read
		const result = await completeDeviceFlow("content:read schema:read", Role.CONTRIBUTOR);
		expect(result.success).toBe(true);

		const scopes = result.scopes.split(" ");
		expect(scopes).toContain("content:read");
		expect(scopes).not.toContain("schema:read");
	});

	it("should allow admin user to get all scopes", async () => {
		const result = await completeDeviceFlow(
			"content:read content:write media:read media:write schema:read schema:write admin",
			Role.ADMIN,
		);
		expect(result.success).toBe(true);

		const scopes = result.scopes.split(" ");
		expect(scopes).toContain("admin");
		expect(scopes).toContain("schema:write");
		expect(scopes).toContain("content:write");
	});

	it("should return INSUFFICIENT_ROLE when no scopes survive clamping", async () => {
		// SUBSCRIBER requests only admin scope — nothing survives
		const codeResult = await handleDeviceCodeRequest(
			db,
			{ scope: "admin schema:write" },
			"https://example.com/_emdash/device",
		);
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		const authResult = await handleDeviceAuthorize(db, "user-1", Role.SUBSCRIBER, {
			user_code: codeResult.data.user_code,
		});
		expect(authResult.success).toBe(false);
		if (authResult.success) return;
		expect(authResult.error.code).toBe("INSUFFICIENT_ROLE");
	});

	it("should clamp scopes in stored device code at authorize time", async () => {
		// Verify that the stored scopes are clamped, not just the response
		const codeResult = await handleDeviceCodeRequest(
			db,
			{ scope: "content:read content:write schema:write admin" },
			"https://example.com/_emdash/device",
		);
		expect(codeResult.success).toBe(true);
		if (!codeResult.success) return;

		// Before authorize: scopes include admin and schema:write
		const beforeRow = await db
			.selectFrom("_emdash_device_codes")
			.selectAll()
			.where("device_code", "=", codeResult.data.device_code)
			.executeTakeFirst();
		expect(JSON.parse(beforeRow!.scopes)).toContain("admin");
		expect(JSON.parse(beforeRow!.scopes)).toContain("schema:write");

		// Authorize as CONTRIBUTOR — admin and schema:write must be stripped
		await handleDeviceAuthorize(db, "user-1", Role.CONTRIBUTOR, {
			user_code: codeResult.data.user_code,
		});

		// After authorize: scopes should be clamped in DB
		const afterRow = await db
			.selectFrom("_emdash_device_codes")
			.selectAll()
			.where("device_code", "=", codeResult.data.device_code)
			.executeTakeFirst();
		const storedScopes = JSON.parse(afterRow!.scopes) as string[];
		expect(storedScopes).toContain("content:read");
		expect(storedScopes).toContain("content:write");
		expect(storedScopes).not.toContain("admin");
		expect(storedScopes).not.toContain("schema:write");
	});

	it("should allow editor to get content + media + schema:read scopes", async () => {
		const result = await completeDeviceFlow(
			"content:read content:write media:read media:write schema:read",
			Role.EDITOR,
		);
		expect(result.success).toBe(true);

		const scopes = result.scopes.split(" ");
		expect(scopes).toContain("content:read");
		expect(scopes).toContain("content:write");
		expect(scopes).toContain("media:read");
		expect(scopes).toContain("media:write");
		expect(scopes).toContain("schema:read");
	});
});
