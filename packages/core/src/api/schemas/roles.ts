import { z } from "zod";

import { BUILTIN_ROLE_LEVELS } from "./common.js";

// ---------------------------------------------------------------------------
// Role definitions: Input schemas
// ---------------------------------------------------------------------------

const slugPattern = /^[a-z][a-z0-9_]*$/;

/** Field definition for role custom metadata (reuses taxonomy field shape) */
const roleFieldDef = z.object({
	name: z.string().min(1),
	label: z.string().min(1),
	type: z.enum(["string", "text", "number", "integer", "boolean", "datetime", "select", "multiSelect", "image", "file", "reference", "json", "url", "color"]),
	required: z.boolean().optional(),
	options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
	widget: z.string().optional(),
	validation: z.object({
		min: z.number().optional(),
		max: z.number().optional(),
		minLength: z.number().optional(),
		maxLength: z.number().optional(),
		pattern: z.string().optional(),
	}).optional(),
	defaultValue: z.unknown().optional(),
});

export const createRoleBody = z
	.object({
		name: z
			.string()
			.min(1)
			.max(63)
			.regex(slugPattern, "Name must be lowercase alphanumeric with underscores"),
		label: z.string().min(1).max(200),
		level: z.number().int().min(1).max(99)
			.refine((n) => !BUILTIN_ROLE_LEVELS.has(n), {
				message: "Level cannot be a built-in role level (10, 20, 30, 40, 50)",
			}),
		permissions: z.array(z.string().min(1)).optional().default([]),
		fields: z.array(roleFieldDef).optional(),
		color: z.string().max(50).optional(),
		description: z.string().max(500).optional(),
	})
	.meta({ id: "CreateRoleBody" });

export const updateRoleBody = z
	.object({
		label: z.string().min(1).max(200).optional(),
		permissions: z.array(z.string().min(1)).optional(),
		fields: z.array(roleFieldDef).optional(),
		color: z.string().max(50).optional(),
		description: z.string().max(500).optional(),
	})
	.meta({ id: "UpdateRoleBody" });

// ---------------------------------------------------------------------------
// Role definitions: Response schemas
// ---------------------------------------------------------------------------

export const roleDefSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		label: z.string(),
		level: z.number().int(),
		builtin: z.boolean(),
		permissions: z.array(z.string()).nullable(),
		fields: z.array(roleFieldDef).nullable(),
		color: z.string().nullable(),
		description: z.string().nullable(),
	})
	.meta({ id: "RoleDef" });

export const roleListResponseSchema = z
	.object({ roles: z.array(roleDefSchema) })
	.meta({ id: "RoleListResponse" });
