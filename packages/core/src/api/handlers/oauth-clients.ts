/**
 * OAuth client management handlers.
 *
 * CRUD operations for registered OAuth clients. Each client has a set
 * of pre-registered redirect URIs. The authorization endpoint rejects
 * any redirect_uri not in the client's registered set.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { validateRedirectUri } from "../oauth/redirect-uri.js";
import type { ApiResult } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a JSON string column into a typed value. */
function parseJsonColumn<T>(value: string): T {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- JSON.parse returns unknown, callers provide the expected shape
	return JSON.parse(value) as T;
}

function validateRegisteredRedirectUris(redirectUris: string[]): string | null {
	for (const redirectUri of redirectUris) {
		const error = validateRedirectUri(redirectUri);
		if (error) {
			return `Invalid redirect URI: ${error}`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthClientInfo {
	id: string;
	name: string;
	redirectUris: string[];
	scopes: string[] | null;
	createdAt: string;
	updatedAt: string;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Create a new OAuth client.
 */
export async function handleOAuthClientCreate(
	db: Kysely<Database>,
	input: {
		id: string;
		name: string;
		redirectUris: string[];
		scopes?: string[] | null;
	},
): Promise<ApiResult<OAuthClientInfo>> {
	try {
		if (input.redirectUris.length === 0) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "At least one redirect URI is required",
				},
			};
		}

		const redirectUriError = validateRegisteredRedirectUris(input.redirectUris);
		if (redirectUriError) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: redirectUriError,
				},
			};
		}

		// Check for duplicate client ID
		const existing = await db
			.selectFrom("_emdash_oauth_clients")
			.select("id")
			.where("id", "=", input.id)
			.executeTakeFirst();

		if (existing) {
			return {
				success: false,
				error: { code: "CONFLICT", message: "OAuth client with this ID already exists" },
			};
		}

		const now = new Date().toISOString();

		await db
			.insertInto("_emdash_oauth_clients")
			.values({
				id: input.id,
				name: input.name,
				redirect_uris: JSON.stringify(input.redirectUris),
				scopes: input.scopes && input.scopes.length > 0 ? JSON.stringify(input.scopes) : null,
			})
			.execute();

		return {
			success: true,
			data: {
				id: input.id,
				name: input.name,
				redirectUris: input.redirectUris,
				scopes: input.scopes && input.scopes.length > 0 ? input.scopes : null,
				createdAt: now,
				updatedAt: now,
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "CLIENT_CREATE_ERROR",
				message: "Failed to create OAuth client",
			},
		};
	}
}

/**
 * List all registered OAuth clients.
 */
export async function handleOAuthClientList(
	db: Kysely<Database>,
): Promise<ApiResult<{ items: OAuthClientInfo[] }>> {
	try {
		const rows = await db
			.selectFrom("_emdash_oauth_clients")
			.selectAll()
			.orderBy("created_at", "desc")
			.execute();

		const items: OAuthClientInfo[] = rows.map((row) => ({
			id: row.id,
			name: row.name,
			redirectUris: parseJsonColumn<string[]>(row.redirect_uris),
			scopes: row.scopes ? parseJsonColumn<string[]>(row.scopes) : null,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));

		return { success: true, data: { items } };
	} catch {
		return {
			success: false,
			error: {
				code: "CLIENT_LIST_ERROR",
				message: "Failed to list OAuth clients",
			},
		};
	}
}

/**
 * Get a single OAuth client by ID.
 */
export async function handleOAuthClientGet(
	db: Kysely<Database>,
	clientId: string,
): Promise<ApiResult<OAuthClientInfo>> {
	try {
		const row = await db
			.selectFrom("_emdash_oauth_clients")
			.selectAll()
			.where("id", "=", clientId)
			.executeTakeFirst();

		if (!row) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "OAuth client not found" },
			};
		}

		return {
			success: true,
			data: {
				id: row.id,
				name: row.name,
				redirectUris: parseJsonColumn<string[]>(row.redirect_uris),
				scopes: row.scopes ? parseJsonColumn<string[]>(row.scopes) : null,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "CLIENT_GET_ERROR",
				message: "Failed to get OAuth client",
			},
		};
	}
}

/**
 * Update an OAuth client.
 */
export async function handleOAuthClientUpdate(
	db: Kysely<Database>,
	clientId: string,
	input: {
		name?: string;
		redirectUris?: string[];
		scopes?: string[] | null;
	},
): Promise<ApiResult<OAuthClientInfo>> {
	try {
		const existing = await db
			.selectFrom("_emdash_oauth_clients")
			.selectAll()
			.where("id", "=", clientId)
			.executeTakeFirst();

		if (!existing) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "OAuth client not found" },
			};
		}

		if (input.redirectUris !== undefined && input.redirectUris.length === 0) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "At least one redirect URI is required",
				},
			};
		}

		if (input.redirectUris !== undefined) {
			const redirectUriError = validateRegisteredRedirectUris(input.redirectUris);
			if (redirectUriError) {
				return {
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						message: redirectUriError,
					},
				};
			}
		}

		const updates: Record<string, string | null> = {
			updated_at: new Date().toISOString(),
		};

		if (input.name !== undefined) {
			updates.name = input.name;
		}
		if (input.redirectUris !== undefined) {
			updates.redirect_uris = JSON.stringify(input.redirectUris);
		}
		if (input.scopes !== undefined) {
			updates.scopes =
				input.scopes && input.scopes.length > 0 ? JSON.stringify(input.scopes) : null;
		}

		await db.updateTable("_emdash_oauth_clients").set(updates).where("id", "=", clientId).execute();

		// Fetch the updated row
		const updated = await db
			.selectFrom("_emdash_oauth_clients")
			.selectAll()
			.where("id", "=", clientId)
			.executeTakeFirst();

		if (!updated) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "OAuth client not found after update" },
			};
		}

		return {
			success: true,
			data: {
				id: updated.id,
				name: updated.name,
				redirectUris: parseJsonColumn<string[]>(updated.redirect_uris),
				scopes: updated.scopes ? parseJsonColumn<string[]>(updated.scopes) : null,
				createdAt: updated.created_at,
				updatedAt: updated.updated_at,
			},
		};
	} catch {
		return {
			success: false,
			error: {
				code: "CLIENT_UPDATE_ERROR",
				message: "Failed to update OAuth client",
			},
		};
	}
}

/**
 * Delete an OAuth client.
 */
export async function handleOAuthClientDelete(
	db: Kysely<Database>,
	clientId: string,
): Promise<ApiResult<{ deleted: true }>> {
	try {
		const result = await db
			.deleteFrom("_emdash_oauth_clients")
			.where("id", "=", clientId)
			.executeTakeFirst();

		if (result.numDeletedRows === 0n) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "OAuth client not found" },
			};
		}

		return { success: true, data: { deleted: true } };
	} catch {
		return {
			success: false,
			error: {
				code: "CLIENT_DELETE_ERROR",
				message: "Failed to delete OAuth client",
			},
		};
	}
}

// ---------------------------------------------------------------------------
// Lookup helpers (used by authorization handler)
// ---------------------------------------------------------------------------

/**
 * Look up a registered OAuth client by ID.
 * Returns the client's redirect URIs or null if the client is not registered.
 */
export async function lookupOAuthClient(
	db: Kysely<Database>,
	clientId: string,
): Promise<{ redirectUris: string[]; scopes: string[] | null } | null> {
	const row = await db
		.selectFrom("_emdash_oauth_clients")
		.select(["redirect_uris", "scopes"])
		.where("id", "=", clientId)
		.executeTakeFirst();

	if (!row) return null;

	return {
		redirectUris: parseJsonColumn<string[]>(row.redirect_uris),
		scopes: row.scopes ? parseJsonColumn<string[]>(row.scopes) : null,
	};
}

/**
 * Validate that a redirect URI is in the client's registered set.
 *
 * Comparison is exact string match (per RFC 6749 §3.1.2.3).
 * Returns null if valid, or an error message if not.
 */
export function validateClientRedirectUri(
	redirectUri: string,
	allowedUris: string[],
): string | null {
	if (allowedUris.includes(redirectUri)) {
		return null; // OK
	}
	return "redirect_uri is not registered for this client";
}
