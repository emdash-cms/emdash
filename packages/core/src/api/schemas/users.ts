import { z } from "zod";

import { roleLevel } from "./common.js";

// ---------------------------------------------------------------------------
// Admin / Users: Input schemas
// ---------------------------------------------------------------------------

export const usersListQuery = z
	.object({
		search: z.string().optional(),
		role: z.string().optional(),
		cursor: z.string().max(2048).optional(),
		limit: z.coerce.number().int().min(1).max(100).optional().default(50),
	})
	.meta({ id: "UsersListQuery" });

export const userUpdateBody = z
	.object({
		name: z.string().optional(),
		email: z.string().email().optional(),
		role: roleLevel.optional(),
	})
	.meta({ id: "UserUpdateBody" });

export const allowedDomainCreateBody = z
	.object({
		domain: z.string().min(1),
		defaultRole: roleLevel,
	})
	.meta({ id: "AllowedDomainCreateBody" });

export const allowedDomainUpdateBody = z
	.object({
		enabled: z.boolean().optional(),
		defaultRole: roleLevel.optional(),
	})
	.meta({ id: "AllowedDomainUpdateBody" });

// ---------------------------------------------------------------------------
// Admin / Users: Response schemas
// ---------------------------------------------------------------------------

export const userSchema = z
	.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable(),
		avatarUrl: z.string().nullable(),
		role: z.number().int(),
		emailVerified: z.boolean(),
		disabled: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
		lastLogin: z.string().nullable(),
		credentialCount: z.number().int().optional(),
		oauthProviders: z.array(z.string()).optional(),
	})
	.meta({ id: "User" });

export const userListResponseSchema = z
	.object({
		items: z.array(userSchema),
		nextCursor: z.string().optional(),
	})
	.meta({ id: "UserListResponse" });

export const userDetailSchema = z
	.object({
		id: z.string(),
		email: z.string(),
		name: z.string().nullable(),
		avatarUrl: z.string().nullable(),
		role: z.number().int(),
		emailVerified: z.boolean(),
		disabled: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
		lastLogin: z.string().nullable(),
		credentials: z.array(
			z.object({
				id: z.string(),
				name: z.string().nullable(),
				deviceType: z.string().nullable(),
				createdAt: z.string(),
				lastUsedAt: z.string(),
			}),
		),
		oauthAccounts: z.array(
			z.object({
				provider: z.string(),
				createdAt: z.string(),
			}),
		),
	})
	.meta({ id: "UserDetail" });
