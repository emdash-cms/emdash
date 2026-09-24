/**
 * Integration tests for API token handlers.
 *
 * Tests token CRUD and resolution against a real in-memory SQLite database.
 */

import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	handleApiTokenCreate,
	handleApiTokenList,
	handleApiTokenRevoke,
	resolveApiToken,
	resolveOAuthToken,
} from "../../../src/api/handlers/api-tokens.js";
import { handleTokenRefresh } from "../../../src/api/handlers/device-flow.js";
import { generatePrefixedToken, TOKEN_PREFIXES } from "../../../src/auth/api-tokens.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

// Regex patterns for token validation
const PAT_PREFIX_REGEX = /^ec_pat_/;

let db: Kysely<Database>;

beforeEach(async () => {
	db = await setupTestDatabase();

	// Create a test user
	await db
		.insertInto("users")
		.values({
			id: "user_1",
			email: "admin@test.com",
			name: "Admin",
			role: 50, // ADMIN
			email_verified: 1,
		})
		.execute();
});

afterEach(async () => {
	await db.destroy();
});

describe("handleApiTokenCreate", () => {
	it("creates a token and returns the raw value", async () => {
		const result = await handleApiTokenCreate(db, "user_1", {
			name: "Test Token",
			scopes: ["content:read", "content:write"],
		});

		expect(result.success).toBe(true);
		expect(result.data).toBeDefined();
		expect(result.data!.token).toMatch(PAT_PREFIX_REGEX);
		expect(result.data!.info.name).toBe("Test Token");
		expect(result.data!.info.scopes).toEqual(["content:read", "content:write"]);
		expect(result.data!.info.userId).toBe("user_1");
		expect(result.data!.info.prefix).toMatch(PAT_PREFIX_REGEX);
	});

	it("creates tokens with different hashes", async () => {
		const result1 = await handleApiTokenCreate(db, "user_1", {
			name: "Token 1",
			scopes: ["content:read"],
		});
		const result2 = await handleApiTokenCreate(db, "user_1", {
			name: "Token 2",
			scopes: ["content:read"],
		});

		expect(result1.data!.token).not.toBe(result2.data!.token);
	});

	it("stores expiry date when provided", async () => {
		const expiresAt = new Date(Date.now() + 86400000).toISOString();
		const result = await handleApiTokenCreate(db, "user_1", {
			name: "Expiring Token",
			scopes: ["content:read"],
			expiresAt,
		});

		expect(result.data!.info.expiresAt).toBe(expiresAt);
	});
});

describe("handleApiTokenList", () => {
	it("lists tokens for a user", async () => {
		await handleApiTokenCreate(db, "user_1", {
			name: "Token A",
			scopes: ["content:read"],
		});
		await handleApiTokenCreate(db, "user_1", {
			name: "Token B",
			scopes: ["admin"],
		});

		const result = await handleApiTokenList(db, "user_1");

		expect(result.success).toBe(true);
		expect(result.data!.items).toHaveLength(2);
		const names = result.data!.items.map((t) => t.name).toSorted();
		expect(names).toEqual(["Token A", "Token B"]);
	});

	it("does not return tokens for other users", async () => {
		await db
			.insertInto("users")
			.values({
				id: "user_2",
				email: "other@test.com",
				name: "Other",
				role: 50,
				email_verified: 1,
			})
			.execute();

		await handleApiTokenCreate(db, "user_1", {
			name: "User 1 Token",
			scopes: ["content:read"],
		});
		await handleApiTokenCreate(db, "user_2", {
			name: "User 2 Token",
			scopes: ["content:read"],
		});

		const result = await handleApiTokenList(db, "user_1");
		expect(result.data!.items).toHaveLength(1);
		expect(result.data!.items[0].name).toBe("User 1 Token");
	});

	it("never returns the token hash", async () => {
		await handleApiTokenCreate(db, "user_1", {
			name: "Test",
			scopes: ["content:read"],
		});

		const result = await handleApiTokenList(db, "user_1");
		const item = result.data!.items[0];

		// Ensure no hash or raw token is exposed
		expect(item).not.toHaveProperty("token_hash");
		expect(item).not.toHaveProperty("tokenHash");
		expect(item).not.toHaveProperty("token");
	});
});

describe("handleApiTokenRevoke", () => {
	it("revokes a token", async () => {
		const createResult = await handleApiTokenCreate(db, "user_1", {
			name: "To Revoke",
			scopes: ["content:read"],
		});
		const tokenId = createResult.data!.info.id;

		const result = await handleApiTokenRevoke(db, tokenId, "user_1");
		expect(result.success).toBe(true);

		// Should be gone from the list
		const list = await handleApiTokenList(db, "user_1");
		expect(list.data!.items).toHaveLength(0);
	});

	it("returns error for non-existent token", async () => {
		const result = await handleApiTokenRevoke(db, "nonexistent", "user_1");
		expect(result.success).toBe(false);
		expect(result.error!.code).toBe("NOT_FOUND");
	});

	it("cannot revoke another user's token", async () => {
		await db
			.insertInto("users")
			.values({
				id: "user_2",
				email: "other@test.com",
				name: "Other",
				role: 50,
				email_verified: 1,
			})
			.execute();

		const createResult = await handleApiTokenCreate(db, "user_1", {
			name: "User 1 Token",
			scopes: ["content:read"],
		});
		const tokenId = createResult.data!.info.id;

		// User 2 tries to revoke user 1's token
		const result = await handleApiTokenRevoke(db, tokenId, "user_2");
		expect(result.success).toBe(false);
		expect(result.error!.code).toBe("NOT_FOUND");

		// Token should still exist
		const list = await handleApiTokenList(db, "user_1");
		expect(list.data!.items).toHaveLength(1);
	});
});

describe("resolveApiToken", () => {
	it("resolves a valid token to user and scopes", async () => {
		const createResult = await handleApiTokenCreate(db, "user_1", {
			name: "Test",
			scopes: ["content:read", "media:write"],
		});
		const rawToken = createResult.data!.token;

		const resolved = await resolveApiToken(db, rawToken);
		expect(resolved).not.toBeNull();
		expect(resolved!.userId).toBe("user_1");
		expect(resolved!.scopes).toEqual(["content:read", "media:write"]);
		expect(resolved!.tokenId).toBe(createResult.data!.info.id);
	});

	it("returns null for invalid token", async () => {
		const resolved = await resolveApiToken(db, "ec_pat_invalidtoken123");
		expect(resolved).toBeNull();
	});

	it("returns null for expired token", async () => {
		const pastDate = new Date(Date.now() - 86400000).toISOString(); // Yesterday
		const createResult = await handleApiTokenCreate(db, "user_1", {
			name: "Expired",
			scopes: ["content:read"],
			expiresAt: pastDate,
		});
		const rawToken = createResult.data!.token;

		const resolved = await resolveApiToken(db, rawToken);
		expect(resolved).toBeNull();
	});

	it("resolves non-expired token", async () => {
		const futureDate = new Date(Date.now() + 86400000).toISOString(); // Tomorrow
		const createResult = await handleApiTokenCreate(db, "user_1", {
			name: "Future",
			scopes: ["admin"],
			expiresAt: futureDate,
		});
		const rawToken = createResult.data!.token;

		const resolved = await resolveApiToken(db, rawToken);
		expect(resolved).not.toBeNull();
		expect(resolved!.scopes).toEqual(["admin"]);
	});
});

describe("resolveOAuthToken", () => {
	it("resolves a valid OAuth access token", async () => {
		// Insert directly since we don't have a Device Flow handler yet
		const { raw, hash } = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
		const futureDate = new Date(Date.now() + 3600000).toISOString();

		await db
			.insertInto("_emdash_oauth_tokens")
			.values({
				token_hash: hash,
				token_type: "access",
				user_id: "user_1",
				scopes: JSON.stringify(["content:read"]),
				client_type: "cli",
				expires_at: futureDate,
			})
			.execute();

		const resolved = await resolveOAuthToken(db, raw);
		expect(resolved).not.toBeNull();
		expect(resolved!.userId).toBe("user_1");
		expect(resolved!.scopes).toEqual(["content:read"]);
	});

	it("returns null for expired OAuth token", async () => {
		const { raw, hash } = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
		const pastDate = new Date(Date.now() - 3600000).toISOString();

		await db
			.insertInto("_emdash_oauth_tokens")
			.values({
				token_hash: hash,
				token_type: "access",
				user_id: "user_1",
				scopes: JSON.stringify(["content:read"]),
				client_type: "cli",
				expires_at: pastDate,
			})
			.execute();

		const resolved = await resolveOAuthToken(db, raw);
		expect(resolved).toBeNull();
	});

	it("identifies the grant by an id that survives refresh and is not a token hash", async () => {
		const expires = new Date(Date.now() + 3600000).toISOString();
		async function grant(): Promise<{ access: string; refresh: string; hashes: string[] }> {
			const refresh = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
			const access = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_ACCESS);
			await db
				.insertInto("_emdash_oauth_tokens")
				.values([
					{
						token_hash: refresh.hash,
						token_type: "refresh",
						user_id: "user_1",
						scopes: JSON.stringify(["content:read"]),
						client_type: "mcp",
						expires_at: expires,
					},
					{
						token_hash: access.hash,
						token_type: "access",
						user_id: "user_1",
						scopes: JSON.stringify(["content:read"]),
						client_type: "mcp",
						expires_at: expires,
						refresh_token_hash: refresh.hash,
					},
				])
				.execute();
			return { access: access.raw, refresh: refresh.raw, hashes: [refresh.hash, access.hash] };
		}

		const first = await grant();
		const before = await resolveOAuthToken(db, first.access);
		const refreshed = await handleTokenRefresh(db, {
			refresh_token: first.refresh,
			grant_type: "refresh_token",
		});
		expect(refreshed.success).toBe(true);
		const after = await resolveOAuthToken(db, refreshed.data!.access_token);
		expect(after!.tokenId).toBe(before!.tokenId);
		for (const hash of first.hashes) expect(before!.tokenId).not.toContain(hash);

		const second = await grant();
		expect((await resolveOAuthToken(db, second.access))!.tokenId).not.toBe(before!.tokenId);
	});

	it("does not resolve refresh tokens", async () => {
		const { raw, hash } = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
		const futureDate = new Date(Date.now() + 3600000).toISOString();

		await db
			.insertInto("_emdash_oauth_tokens")
			.values({
				token_hash: hash,
				token_type: "refresh",
				user_id: "user_1",
				scopes: JSON.stringify(["content:read"]),
				client_type: "cli",
				expires_at: futureDate,
			})
			.execute();

		const resolved = await resolveOAuthToken(db, raw);
		expect(resolved).toBeNull();
	});
});
