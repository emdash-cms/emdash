/**
 * Role definition CRUD handlers
 */

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { Database } from "../../database/types.js";
import type { ApiResult } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoleDefResponse {
	id: string;
	name: string;
	label: string;
	level: number;
	builtin: boolean;
	permissions: string[] | null;
	fields: unknown[] | null;
	color: string | null;
	description: string | null;
}

export interface RoleListResponse {
	roles: RoleDefResponse[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUILTIN_LEVELS = new Set([10, 20, 30, 40, 50]);

function rowToRoleDef(row: Record<string, unknown>): RoleDefResponse {
	return {
		id: row.id as string,
		name: row.name as string,
		label: row.label as string,
		level: row.level as number,
		builtin: (row.builtin as number) === 1,
		permissions: row.permissions ? JSON.parse(row.permissions as string) : null,
		fields: row.fields ? JSON.parse(row.fields as string) : null,
		color: (row.color as string) ?? null,
		description: (row.description as string) ?? null,
	};
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * List all role definitions (built-in + custom)
 */
export async function handleRoleList(
	db: Kysely<Database>,
): Promise<ApiResult<RoleListResponse>> {
	try {
		const rows = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.orderBy("level", "asc")
			.execute();

		const roles = rows.map((row) => rowToRoleDef(row as Record<string, unknown>));
		return { success: true, data: { roles } };
	} catch {
		return {
			success: false,
			error: { code: "ROLE_LIST_ERROR", message: "Failed to list roles" },
		};
	}
}

/**
 * Get a single role definition by name
 */
export async function handleRoleGet(
	db: Kysely<Database>,
	name: string,
): Promise<ApiResult<{ role: RoleDefResponse }>> {
	try {
		const row = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		if (!row) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Role '${name}' not found` },
			};
		}

		return {
			success: true,
			data: { role: rowToRoleDef(row as Record<string, unknown>) },
		};
	} catch {
		return {
			success: false,
			error: { code: "ROLE_GET_ERROR", message: "Failed to get role" },
		};
	}
}

/**
 * Create a custom role definition
 */
export async function handleRoleCreate(
	db: Kysely<Database>,
	input: {
		name: string;
		label: string;
		level: number;
		permissions?: string[];
		fields?: unknown[];
		color?: string;
		description?: string;
	},
): Promise<ApiResult<{ role: RoleDefResponse }>> {
	try {
		// Prevent creating roles with built-in levels
		if (BUILTIN_LEVELS.has(input.level)) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Cannot use a built-in role level (10, 20, 30, 40, 50)",
				},
			};
		}

		// Check for duplicate name
		const existingName = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.where("name", "=", input.name)
			.executeTakeFirst();

		if (existingName) {
			return {
				success: false,
				error: { code: "CONFLICT", message: `Role '${input.name}' already exists` },
			};
		}

		// Check for duplicate level
		const existingLevel = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.where("level", "=", input.level)
			.executeTakeFirst();

		if (existingLevel) {
			return {
				success: false,
				error: { code: "CONFLICT", message: `A role with level ${input.level} already exists` },
			};
		}

		const id = ulid();
		const values: Record<string, unknown> = {
			id,
			name: input.name,
			label: input.label,
			level: input.level,
			builtin: 0,
			permissions: JSON.stringify(input.permissions ?? []),
		};
		if (input.fields) values.fields = JSON.stringify(input.fields);
		if (input.color) values.color = input.color;
		if (input.description) values.description = input.description;

		await db.insertInto("_emdash_role_defs").values(values).execute();

		const role: RoleDefResponse = {
			id,
			name: input.name,
			label: input.label,
			level: input.level,
			builtin: false,
			permissions: input.permissions ?? [],
			fields: input.fields ?? null,
			color: input.color ?? null,
			description: input.description ?? null,
		};

		return { success: true, data: { role } };
	} catch (error) {
		if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
			return {
				success: false,
				error: { code: "CONFLICT", message: `Role '${input.name}' or level ${input.level} already exists` },
			};
		}
		return {
			success: false,
			error: { code: "ROLE_CREATE_ERROR", message: "Failed to create role" },
		};
	}
}

/**
 * Update a role definition
 */
export async function handleRoleUpdate(
	db: Kysely<Database>,
	name: string,
	input: {
		label?: string;
		permissions?: string[];
		fields?: unknown[];
		color?: string;
		description?: string;
	},
): Promise<ApiResult<{ role: RoleDefResponse }>> {
	try {
		const existing = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		if (!existing) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Role '${name}' not found` },
			};
		}

		const isBuiltin = (existing as Record<string, unknown>).builtin === 1;

		// Built-in roles: only allow updating fields, color, description (not permissions or label)
		if (isBuiltin && input.permissions !== undefined) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Cannot modify permissions of built-in roles",
				},
			};
		}

		const updates: Record<string, unknown> = {};
		if (input.label !== undefined && !isBuiltin) updates.label = input.label;
		if (input.permissions !== undefined) updates.permissions = JSON.stringify(input.permissions);
		if (input.fields !== undefined) updates.fields = JSON.stringify(input.fields);
		if (input.color !== undefined) updates.color = input.color;
		if (input.description !== undefined) updates.description = input.description;

		if (Object.keys(updates).length > 0) {
			await db
				.updateTable("_emdash_role_defs")
				.set(updates)
				.where("name", "=", name)
				.execute();
		}

		const row = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		return {
			success: true,
			data: { role: rowToRoleDef(row as Record<string, unknown>) },
		};
	} catch {
		return {
			success: false,
			error: { code: "ROLE_UPDATE_ERROR", message: "Failed to update role" },
		};
	}
}

/**
 * Delete a custom role definition
 *
 * Users with the deleted role are reassigned to subscriber (level 10).
 */
export async function handleRoleDelete(
	db: Kysely<Database>,
	name: string,
): Promise<ApiResult<{ deleted: true; usersReassigned: number }>> {
	try {
		const existing = await db
			.selectFrom("_emdash_role_defs")
			.selectAll()
			.where("name", "=", name)
			.executeTakeFirst();

		if (!existing) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `Role '${name}' not found` },
			};
		}

		if ((existing as Record<string, unknown>).builtin === 1) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "Cannot delete built-in roles",
				},
			};
		}

		const level = (existing as Record<string, unknown>).level as number;

		// Reassign users with this role level to subscriber (10)
		const reassignResult = await db
			.updateTable("users")
			.set({ role: 10 })
			.where("role", "=", level)
			.executeTakeFirst();

		const usersReassigned = Number(reassignResult.numUpdatedRows ?? 0);

		// Delete the role definition
		await db
			.deleteFrom("_emdash_role_defs")
			.where("name", "=", name)
			.execute();

		return { success: true, data: { deleted: true, usersReassigned } };
	} catch {
		return {
			success: false,
			error: { code: "ROLE_DELETE_ERROR", message: "Failed to delete role" },
		};
	}
}
