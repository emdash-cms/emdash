/**
 * Role-Based Access Control
 */

import type { ApiTokenScope } from "./tokens.js";
import { Role, type RoleLevel } from "./types.js";

// ---------------------------------------------------------------------------
// Role Registry — in-memory cache of role definitions for custom roles
// ---------------------------------------------------------------------------

export interface RoleDef {
	id: string;
	name: string;
	label: string;
	level: number;
	builtin: boolean;
	permissions: Permission[] | null;
	fields: unknown[] | null;
	color: string | null;
	description: string | null;
}

const BUILTIN_LEVELS = new Set<number>([10, 20, 30, 40, 50]);

export class RoleRegistry {
	private defs = new Map<number, RoleDef>();
	private _loaded = false;

	get loaded(): boolean {
		return this._loaded;
	}

	load(defs: RoleDef[]): void {
		this.defs.clear();
		for (const def of defs) {
			this.defs.set(def.level, def);
		}
		this._loaded = true;
	}

	invalidate(): void {
		this.defs.clear();
		this._loaded = false;
	}

	getRoleDef(level: number): RoleDef | undefined {
		return this.defs.get(level);
	}

	isBuiltinLevel(level: number): boolean {
		return BUILTIN_LEVELS.has(level);
	}

	getAllRoles(): RoleDef[] {
		return [...this.defs.values()].sort((a, b) => a.level - b.level);
	}

	getCustomRoles(): RoleDef[] {
		return this.getAllRoles().filter((d) => !d.builtin);
	}
}

/**
 * Permission definitions with minimum role required
 */
export const Permissions = {
	// Content
	"content:read": Role.SUBSCRIBER,
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
 * Check if a user has a specific permission.
 *
 * For built-in roles (10/20/30/40/50) or when no registry is provided,
 * uses the legacy numeric comparison. For custom roles, looks up the
 * explicit permissions array in the registry.
 */
export function hasPermission(
	user: { role: RoleLevel | number } | null | undefined,
	permission: Permission,
	registry?: RoleRegistry,
): boolean {
	if (!user) return false;

	// If registry is loaded and role is a custom level, check permissions array
	if (registry?.loaded && !BUILTIN_LEVELS.has(user.role)) {
		const def = registry.getRoleDef(user.role);
		if (!def || !def.permissions) return false;
		return def.permissions.includes(permission);
	}

	// Built-in role or no registry: legacy numeric comparison
	return user.role >= Permissions[permission];
}

/**
 * Require a permission, throwing if not met
 */
export function requirePermission(
	user: { role: RoleLevel | number } | null | undefined,
	permission: Permission,
	registry?: RoleRegistry,
): asserts user is { role: RoleLevel | number } {
	if (!user) {
		throw new PermissionError("unauthorized", "Authentication required");
	}
	if (!hasPermission(user, permission, registry)) {
		throw new PermissionError("forbidden", `Missing permission: ${permission}`);
	}
}

/**
 * Check if user can perform action on a resource they own
 */
export function canActOnOwn(
	user: { role: RoleLevel | number; id: string } | null | undefined,
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
	registry?: RoleRegistry,
): boolean {
	if (!user) return false;
	if (user.id === ownerId) {
		return hasPermission(user, ownPermission, registry);
	}
	return hasPermission(user, anyPermission, registry);
}

/**
 * Require permission on a resource, checking ownership
 */
export function requirePermissionOnResource(
	user: { role: RoleLevel | number; id: string } | null | undefined,
	ownerId: string,
	ownPermission: Permission,
	anyPermission: Permission,
	registry?: RoleRegistry,
): asserts user is { role: RoleLevel | number; id: string } {
	if (!user) {
		throw new PermissionError("unauthorized", "Authentication required");
	}
	if (!canActOnOwn(user, ownerId, ownPermission, anyPermission, registry)) {
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
