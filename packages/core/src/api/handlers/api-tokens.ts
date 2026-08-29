/**
 * API token management handlers.
 *
 * Creates, lists, and revokes Personal Access Tokens (PATs).
 * Token format: ec_pat_<base64url>
 * Only the SHA-256 hash is stored — raw token shown once at creation.
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { after } from "../../after.js";
import { hashApiToken, generatePrefixedToken } from "../../auth/api-tokens.js";
import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiTokenInfo {
	id: string;
	name: string;
	prefix: string;
	scopes: string[];
	userId: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	createdAt: string;
}

export interface ApiTokenCreateResult {
	/** The raw token — shown once, never stored */
	token: string;
	/** Token metadata */
	info: ApiTokenInfo;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Create a new API token for a user.
 */
export async function handleApiTokenCreate(
	db: Kysely<Database>,
	userId: string,
	input: {
		name: string;
		scopes: string[];
		expiresAt?: string;
	},
): Promise<ApiResult<ApiTokenCreateResult>> {
	try {
		const id = ulid();
		const { raw, hash, prefix } = generatePrefixedToken("ec_pat_");

		await db
			.insertInto("_emdash_api_tokens")
			.values({
				id,
				name: input.name,
				token_hash: hash,
				prefix,
				user_id: userId,
				scopes: JSON.stringify(input.scopes),
				expires_at: input.expiresAt ?? null,
			})
			.execute();

		const info: ApiTokenInfo = {
			id,
			name: input.name,
			prefix,
			scopes: input.scopes,
			userId,
			expiresAt: input.expiresAt ?? null,
			lastUsedAt: null,
			createdAt: new Date().toISOString(),
		};

		return { success: true, data: { token: raw, info } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_CREATE_ERROR",
				message: "Failed to create API token",
			},
		};
	}
}

/**
 * List all API tokens for a user (never returns the raw token or hash).
 */
export async function handleApiTokenList(
	db: Kysely<Database>,
	userId: string,
): Promise<ApiResult<{ items: ApiTokenInfo[] }>> {
	try {
		const rows = await db
			.selectFrom("_emdash_api_tokens")
			.select([
				"id",
				"name",
				"prefix",
				"scopes",
				"user_id",
				"expires_at",
				"last_used_at",
				"created_at",
			])
			.where("user_id", "=", userId)
			.orderBy("created_at", "desc")
			.execute();

		const items: ApiTokenInfo[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			prefix: row.prefix,
			scopes: JSON.parse(row.scopes) as string[],
			userId: row.user_id,
			expiresAt: row.expires_at,
			lastUsedAt: row.last_used_at,
			createdAt: row.created_at,
		}));

		return { success: true, data: { items } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_LIST_ERROR",
				message: "Failed to list API tokens",
			},
		};
	}
}

/**
 * Revoke (delete) an API token.
 */
export async function handleApiTokenRevoke(
	db: Kysely<Database>,
	tokenId: string,
	userId: string,
): Promise<ApiResult<{ revoked: boolean }>> {
	try {
		const result = await db
			.deleteFrom("_emdash_api_tokens")
			.where("id", "=", tokenId)
			.where("user_id", "=", userId)
			.executeTakeFirst();

		if (result.numDeletedRows === 0n) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Token not found" },
			};
		}

		return { success: true, data: { revoked: true } };
	} catch {
		return {
			success: false,
			error: {
				code: "TOKEN_REVOKE_ERROR",
				message: "Failed to revoke API token",
			},
		};
	}
}

/**
 * Delete every token with the given name for a user, returning how many were
 * removed. Token names aren't unique, so this is a bulk delete — used by the
 * dev-bypass flow to keep a single `dev-bypass-token` instead of minting a new
 * one on every reset.
 */
export async function deleteApiTokensByName(
	db: Kysely<Database>,
	userId: string,
	name: string,
): Promise<number> {
	const result = await db
		.deleteFrom("_emdash_api_tokens")
		.where("user_id", "=", userId)
		.where("name", "=", name)
		.executeTakeFirst();
	return Number(result.numDeletedRows ?? 0n);
}

/**
 * Resolve a raw API token (ec_pat_...) to a user ID and scopes.
 * Returns null if the token is invalid, expired, or belongs to a disabled user.
 */
export async function resolveApiToken(
	db: Kysely<Database>,
	rawToken: string,
): Promise<{ tokenId: string; userId: string; scopes: string[] } | null> {
	const hash = hashApiToken(rawToken);

	const row = await db
		.selectFrom("_emdash_api_tokens as token")
		.innerJoin("users as user", "user.id", "token.user_id")
		.select([
			"token.id as id",
			"token.user_id as user_id",
			"token.scopes as scopes",
			"token.expires_at as expires_at",
		])
		.where("token.token_hash", "=", hash)
		.where("user.disabled", "=", 0)
		.executeTakeFirst();

	if (!row) return null;

	// Check expiry
	if (row.expires_at && new Date(row.expires_at) < new Date()) {
		return null;
	}

	return {
		tokenId: row.id,
		userId: row.user_id,
		scopes: JSON.parse(row.scopes) as string[],
	};
}

export function recordApiTokenUse(db: Kysely<Database>, tokenId: string): void {
	const lastUsedAt = new Date().toISOString();
	after(async () => {
		try {
			await db
				.updateTable("_emdash_api_tokens")
				.set({ last_used_at: lastUsedAt })
				.where("id", "=", tokenId)
				.where("user_id", "in", db.selectFrom("users").select("id").where("disabled", "=", 0))
				.where((eb) => eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<", lastUsedAt)]))
				.execute();
		} catch (error) {
			console.error("[api-tokens] Failed to record token use:", error);
		}
	});
}

/**
 * Resolve an OAuth access token (ec_oat_...) to a user ID and scopes.
 * Returns null if the token is invalid or expired.
 */
export async function resolveOAuthToken(
	db: Kysely<Database>,
	rawToken: string,
): Promise<{ userId: string; scopes: string[] } | null> {
	const hash = hashApiToken(rawToken);

	const row = await db
		.selectFrom("_emdash_oauth_tokens")
		.select(["user_id", "scopes", "expires_at", "token_type"])
		.where("token_hash", "=", hash)
		.where("token_type", "=", "access")
		.executeTakeFirst();

	if (!row) return null;

	// Check expiry
	if (new Date(row.expires_at) < new Date()) {
		return null;
	}

	return {
		userId: row.user_id,
		scopes: JSON.parse(row.scopes) as string[],
	};
}
