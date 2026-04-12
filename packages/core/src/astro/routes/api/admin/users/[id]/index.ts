/**
 * User management detail endpoint
 *
 * GET /_emdash/api/admin/users/:id - Get user details
 * PUT /_emdash/api/admin/users/:id - Update user
 */

import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { userUpdateBody } from "#api/schemas.js";

export const prerender = false;

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user: currentUser } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!currentUser || currentUser.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const adapter = createKyselyAdapter(emdash.db);

	const { id } = params;

	if (!id) {
		return apiError("MISSING_PARAM", "User ID required", 400);
	}

	try {
		const result = await adapter.getUserWithDetails(id);

		if (!result) {
			return apiError("NOT_FOUND", "User not found", 404);
		}

		// Transform for JSON serialization
		const item = {
			id: result.user.id,
			email: result.user.email,
			name: result.user.name,
			avatarUrl: result.user.avatarUrl,
			role: result.user.role,
			emailVerified: result.user.emailVerified,
			disabled: result.user.disabled,
			createdAt: result.user.createdAt.toISOString(),
			updatedAt: result.user.updatedAt.toISOString(),
			lastLogin: result.lastLogin?.toISOString() ?? null,
			credentials: result.credentials.map((c) => ({
				id: c.id,
				name: c.name,
				deviceType: c.deviceType,
				createdAt: c.createdAt.toISOString(),
				lastUsedAt: c.lastUsedAt.toISOString(),
			})),
			oauthAccounts: result.oauthAccounts.map((a) => ({
				provider: a.provider,
				createdAt: a.createdAt.toISOString(),
			})),
		};

		return apiSuccess({ item });
	} catch (error) {
		return handleError(error, "Failed to get user details", "USER_DETAIL_ERROR");
	}
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user: currentUser } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!currentUser || currentUser.role < Role.ADMIN) {
		return apiError("FORBIDDEN", "Admin privileges required", 403);
	}

	const adapter = createKyselyAdapter(emdash.db);

	const { id } = params;

	if (!id) {
		return apiError("MISSING_PARAM", "User ID required", 400);
	}

	try {
		// Get target user
		const targetUser = await adapter.getUserById(id);
		if (!targetUser) {
			return apiError("NOT_FOUND", "User not found", 404);
		}

		const body = await parseBody(request, userUpdateBody);
		if (isParseError(body)) return body;

		// Role is already validated as RoleLevel by Zod schema
		const role = body.role;

		// Prevent editing own role (security: prevents self-demotion/lockout)
		if (role !== undefined && id === currentUser.id) {
			return apiError("SELF_ROLE_CHANGE", "Cannot change your own role", 400);
		}

		// Prevent demoting the last admin
		if (role !== undefined && role < Role.ADMIN && targetUser.role === Role.ADMIN) {
			const adminCount = await adapter.countAdmins();
			if (adminCount <= 1) {
				return apiError(
					"LAST_ADMIN",
					"Cannot demote the last admin. Promote another user first.",
					400,
				);
			}
		}

		// Check email uniqueness if changing email
		if (body.email && body.email !== targetUser.email) {
			const existing = await adapter.getUserByEmail(body.email);
			if (existing) {
				return apiError("EMAIL_IN_USE", "Email already in use", 409);
			}
		}

		// Update user
		await adapter.updateUser(id, {
			name: body.name,
			email: body.email,
			role,
		});

		// Fetch updated user
		const updated = await adapter.getUserById(id);

		return apiSuccess({
			item: {
				id: updated!.id,
				email: updated!.email,
				name: updated!.name,
				avatarUrl: updated!.avatarUrl,
				role: updated!.role,
				emailVerified: updated!.emailVerified,
				disabled: updated!.disabled,
				createdAt: updated!.createdAt.toISOString(),
				updatedAt: updated!.updatedAt.toISOString(),
			},
		});
	} catch (error) {
		return handleError(error, "Failed to update user", "USER_UPDATE_ERROR");
	}
};
