/**
 * Role-Based Access Control
 */

import type { ApiTokenScope } from "./tokens.js";
import { Role, type RoleLevel } from "./types.js";

/**
 * Permission definitions with minimum role required
 */
export const Permissions = {
	// Content
	"content:read": Role.SUBSCRIBER,
	// content:read_drafts gates non-published content (drafts, scheduled, trash)
	// and editor-only views (revisions, compare, preview-url). Subscribers may
	// hold content:read for member-only published content but must not see
	// drafts.
	"content:read_drafts": Role.CONTRIBUTOR,
	"content:create": Role.CONTRIBUTOR,
	"content:edit_own": Role.AUTHOR,
	"content:edit_any": Role.EDITOR,
	"content:delete_own": Role.AUTHOR,
	"content:delete_any": Role.EDITOR,
	"content:publish_own": Role.AUTHOR,
	"content:publish_any": Role.EDITOR,

	// Media
	"media:read": Role.SUBSCRIBER,
	"media:upload": Role.CONTRIBUTOR,
	"media:edit_own": Role.AUTHOR,
	"media:edit_any": Role.EDITOR,
	"media:delete_own": Role.AUTHOR,
	"media:delete_any": Role.EDITOR,

	// Taxonomies
	"taxonomies:read": Role.SUBSCRIBER,
	"taxonomies:manage": Role.EDITOR,

	// Comments
	"comments:read": Role.SUBSCRIBER,
	"comments:moderate": Role.EDITOR,
	"comments:delete": Role.ADMIN,
	"comments:settings": Role.ADMIN,

	// Menus
	"menus:read": Role.SUBSCRIBER,
	"menus:manage": Role.EDITOR,

	// Widgets
	"widgets:read": Role.SUBSCRIBER,
	"widgets:manage": Role.EDITOR,

	// Sections
	"sections:read": Role.SUBSCRIBER,
	"sections:manage": Role.EDITOR,

	// Redirects
	"redirects:read": Role.EDITOR,
	"redirects:manage": Role.ADMIN,

	// Users
	"users:read": Role.ADMIN,
	"users:invite": Role.ADMIN,
	"users:manage": Role.ADMIN,

	// Settings
	"settings:read": Role.EDITOR,
	"settings:manage": Role.ADMIN,

	// Schema (content types)
	"schema:read": Role.EDITOR,
	"schema:manage": Role.ADMIN,

	// Plugins
	"plugins:read": Role.EDITOR,
	"plugins:manage": Role.ADMIN,

	// Import
	"import:execute": Role.ADMIN,

	// Search
	"search:read": Role.SUBSCRIBER,
	"search:manage": Role.ADMIN,

	// Auth
	"auth:manage_own_credentials": Role.SUBSCRIBER,
	"auth:manage_connections": Role.ADMIN,
} as const;

export type Permission = keyof typeof Permissions;

/**
 * Check if a user has a specific permission
 */
export function hasPermission(
	user: { role: RoleLevel } | null | undefined,
	permission: Permission,
): boolean {
	if (!user) return false;
	return user.role >= Permissions[permission];
}

/**
 * Require a permission, throwing if not met
 */
export function requirePermission(
	user: { role: RoleLevel } | null | undefined,
	permission: Permission,
): asserts user is { role: RoleLevel } {
	if (!user) {
		throw new PermissionError("unauthorized", "Authentication required");
	}
	if (!hasPermission(user, permission)) {
		throw new PermissionError("forbidden", `Missing permission: ${permission}`);
	}
}

/**
 * Check if user can perform action on a resource they own
 */
export function canActOnOwn(
	user: { role: RoleLevel; id: string } | null | undefined,
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
): boolean {
	if (!user) return false;
	// Defense in depth: an empty-string ownerId means "no recorded owner"
	// (e.g. seed-imported content with `authorId: null` extracted to ""),
	// not "owned by an unauthenticated user". If both the user.id and the
	// ownerId are "", treating them as a match would accidentally grant
	// edit-own — fall through to the any-permission check instead.
	if (ownerId !== "" && user.id === ownerId) {
		return hasPermission(user, ownPermission);
	}
	return hasPermission(user, anyPermission);
}

/**
 * Require permission on a resource, checking ownership
 */
export function requirePermissionOnResource(
	user: { role: RoleLevel; id: string } | null | undefined,
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
): asserts user is { role: RoleLevel; id: string } {
	if (!user) {
		throw new PermissionError("unauthorized", "Authentication required");
	}
	if (!canActOnOwn(user, ownerId, ownPermission, anyPermission)) {
		throw new PermissionError("forbidden", `Missing permission: ${anyPermission}`);
	}
}

export class PermissionError extends Error {
	constructor(
		public code: "unauthorized" | "forbidden",
		message: string,
	) {
		super(message);
		this.name = "PermissionError";
	}
}

// ---------------------------------------------------------------------------
// API Token Scope ↔ Role mapping
//
// Maps each API token scope to the minimum RBAC role required to hold it.
// Used at token issuance time to clamp granted scopes to the user's role.
// ---------------------------------------------------------------------------

/**
 * Minimum role required for each API token scope.
 *
 * This is the authoritative mapping between the two authorization systems
 * (RBAC roles and API token scopes). When issuing a token, the granted
 * scopes must be intersected with the scopes allowed by the user's role.
 */
const SCOPE_MIN_ROLE: Record<ApiTokenScope, RoleLevel> = {
	"content:read": Role.SUBSCRIBER,
	"content:write": Role.CONTRIBUTOR,
	"media:read": Role.SUBSCRIBER,
	"media:write": Role.CONTRIBUTOR,
	"schema:read": Role.EDITOR,
	"schema:write": Role.ADMIN,
	"taxonomies:manage": Role.EDITOR,
	"menus:manage": Role.EDITOR,
	"settings:read": Role.EDITOR,
	"settings:manage": Role.ADMIN,
	admin: Role.ADMIN,
};

/**
 * Return the maximum set of API token scopes a given role level may hold.
 *
 * Used at token issuance time (device flow, authorization code exchange)
 * to enforce: effective_scopes = requested_scopes ∩ scopesForRole(role).
 */
export function scopesForRole(role: RoleLevel): ApiTokenScope[] {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Object.entries loses tuple types; SCOPE_MIN_ROLE keys are ApiTokenScope by construction
	const entries = Object.entries(SCOPE_MIN_ROLE) as [ApiTokenScope, RoleLevel][];
	return entries.reduce<ApiTokenScope[]>((acc, [scope, minRole]) => {
		if (role >= minRole) acc.push(scope);
		return acc;
	}, []);
}

/**
 * Clamp a set of requested scopes to those permitted by a user's role.
 *
 * Returns the intersection of `requested` and the scopes the role allows.
 * This is the central policy enforcement point: effective permissions =
 * role permissions ∩ token scopes.
 */
export function clampScopes(requested: string[], role: RoleLevel): string[] {
	const allowed = new Set<string>(scopesForRole(role));
	return requested.filter((s) => allowed.has(s));
}
