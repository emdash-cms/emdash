/**
 * Authorization helpers for API routes
 *
 * Thin wrappers around @emdash-cms/auth RBAC that return HTTP responses.
 * Auth middleware handles authentication; these handle authorization.
 */

import type { Permission, RoleLevel } from "@emdash-cms/auth";
import { hasPermission, canActOnOwn, hasScope } from "@emdash-cms/auth";

import { apiError } from "./error.js";

interface UserLike {
	id: string;
	role: RoleLevel;
}

export function canReadMediaUsageCount(
	user: UserLike | null | undefined,
	tokenScopes: string[] | undefined,
): boolean {
	return (
		hasPermission(user, "content:read_drafts") && (!tokenScopes || hasScope(tokenScopes, "admin"))
	);
}

/**
 * Check if user has a permission. Returns a 401/403 Response if not, or null if authorized.
 *
 * Usage:
 * ```ts
 * const denied = requirePerm(user, "schema:manage");
 * if (denied) return denied;
 * ```
 */
export function requirePerm(
	user: UserLike | null | undefined,
	permission: Permission,
): Response | null {
	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}
	if (!hasPermission(user, permission)) {
		return apiError("FORBIDDEN", "Insufficient permissions", 403);
	}
	return null;
}

/**
 * Check if user can act on a resource, considering ownership.
 * Returns a 401/403 Response if not, or null if authorized.
 *
 * Usage:
 * ```ts
 * const denied = requireOwnerPerm(user, item.authorId, "content:edit_own", "content:edit_any");
 * if (denied) return denied;
 * ```
 */
export function requireOwnerPerm(
	user: UserLike | null | undefined,
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
): Response | null {
	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}
	if (!canActOnOwn(user, ownerId, ownPermission, anyPermission)) {
		return apiError("FORBIDDEN", "Insufficient permissions", 403);
	}
	return null;
}

/**
 * How `user` may edit an entry: `"full"` through `content:edit_own` or
 * `content:edit_any`, `"draft"` through `content:edit_own_drafts` only, or
 * `null` when they can't edit it.
 *
 * A `"draft"` grant holds only while the entry is still a draft, so the caller
 * must make its write fail if the entry changes after this check, for example
 * by conditioning the update on the `_rev` it checked.
 */
export function entryEditAccess(
	user: UserLike | null | undefined,
	entry: { authorId: string; status: unknown },
): "full" | "draft" | null {
	if (canActOnOwn(user, entry.authorId, "content:edit_own", "content:edit_any")) return "full";
	if (
		entry.status === "draft" &&
		canActOnOwn(user, entry.authorId, "content:edit_own_drafts", "content:edit_any")
	) {
		return "draft";
	}
	return null;
}

/**
 * Check if user can edit an entry, including an owner editing their own draft
 * through `content:edit_own_drafts`. Returns a 401/403 Response if not, or null
 * if authorized. See {@link entryEditAccess} for what a draft-only grant requires
 * of the caller.
 */
export function requireEntryEditPerm(
	user: UserLike | null | undefined,
	entry: { authorId: string; status: unknown },
): Response | null {
	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}
	if (!entryEditAccess(user, entry)) {
		return apiError("FORBIDDEN", "Insufficient permissions", 403);
	}
	return null;
}

/**
 * Like {@link requirePerm}, but authorized when the user has any of
 * `permissions`.
 */
export function requireAnyPerm(
	user: UserLike | null | undefined,
	permissions: readonly Permission[],
): Response | null {
	if (!user) {
		return apiError("UNAUTHORIZED", "Authentication required", 401);
	}
	if (!permissions.some((permission) => hasPermission(user, permission))) {
		return apiError("FORBIDDEN", "Insufficient permissions", 403);
	}
	return null;
}
