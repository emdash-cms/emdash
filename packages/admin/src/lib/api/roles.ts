/**
 * Roles API (role definitions)
 */

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

export interface RoleFieldDef {
	name: string;
	label: string;
	type: "string" | "text" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "image" | "file" | "reference" | "json" | "url" | "color";
	required?: boolean;
	options?: Array<{ value: string; label: string }>;
	widget?: string;
	validation?: {
		min?: number;
		max?: number;
		minLength?: number;
		maxLength?: number;
		pattern?: string;
	};
	defaultValue?: unknown;
}

export interface RoleDef {
	id: string;
	name: string;
	label: string;
	level: number;
	builtin: boolean;
	permissions: string[] | null;
	fields: RoleFieldDef[] | null;
	color: string | null;
	description: string | null;
}

export interface CreateRoleInput {
	name: string;
	label: string;
	level: number;
	permissions?: string[];
	fields?: RoleFieldDef[];
	color?: string;
	description?: string;
}

export interface UpdateRoleInput {
	label?: string;
	permissions?: string[];
	fields?: RoleFieldDef[];
	color?: string;
	description?: string;
}

/**
 * Fetch all role definitions
 */
export async function fetchRoles(): Promise<RoleDef[]> {
	const response = await apiFetch(`${API_BASE}/roles`);
	const data = await parseApiResponse<{ roles: RoleDef[] }>(
		response,
		"Failed to fetch roles",
	);
	return data.roles;
}

/**
 * Fetch a role definition by name
 */
export async function fetchRole(name: string): Promise<RoleDef> {
	const response = await apiFetch(`${API_BASE}/roles/${name}`);
	const data = await parseApiResponse<{ role: RoleDef }>(
		response,
		"Failed to fetch role",
	);
	return data.role;
}

/**
 * Create a custom role definition
 */
export async function createRole(input: CreateRoleInput): Promise<RoleDef> {
	const response = await apiFetch(`${API_BASE}/roles`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ role: RoleDef }>(
		response,
		"Failed to create role",
	);
	return data.role;
}

/**
 * Update a role definition
 */
export async function updateRole(
	name: string,
	input: UpdateRoleInput,
): Promise<RoleDef> {
	const response = await apiFetch(`${API_BASE}/roles/${name}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ role: RoleDef }>(
		response,
		"Failed to update role",
	);
	return data.role;
}

/**
 * Delete a custom role definition
 */
export async function deleteRole(name: string): Promise<{ usersReassigned: number }> {
	const response = await apiFetch(`${API_BASE}/roles/${name}`, {
		method: "DELETE",
	});
	const data = await parseApiResponse<{ deleted: true; usersReassigned: number }>(
		response,
		"Failed to delete role",
	);
	return { usersReassigned: data.usersReassigned };
}

/**
 * All available permissions that can be assigned to custom roles
 */
export const ALL_PERMISSIONS = [
	{ group: "Content", permissions: [
		{ value: "content:read", label: "Read content" },
		{ value: "content:create", label: "Create content" },
		{ value: "content:edit_own", label: "Edit own content" },
		{ value: "content:edit_any", label: "Edit any content" },
		{ value: "content:delete_own", label: "Delete own content" },
		{ value: "content:delete_any", label: "Delete any content" },
		{ value: "content:publish_own", label: "Publish own content" },
		{ value: "content:publish_any", label: "Publish any content" },
	]},
	{ group: "Media", permissions: [
		{ value: "media:read", label: "View media" },
		{ value: "media:upload", label: "Upload media" },
		{ value: "media:edit_own", label: "Edit own media" },
		{ value: "media:edit_any", label: "Edit any media" },
		{ value: "media:delete_own", label: "Delete own media" },
		{ value: "media:delete_any", label: "Delete any media" },
	]},
	{ group: "Taxonomies", permissions: [
		{ value: "taxonomies:read", label: "View taxonomies" },
		{ value: "taxonomies:manage", label: "Manage taxonomies" },
	]},
	{ group: "Comments", permissions: [
		{ value: "comments:read", label: "View comments" },
		{ value: "comments:moderate", label: "Moderate comments" },
		{ value: "comments:delete", label: "Delete comments" },
		{ value: "comments:settings", label: "Comment settings" },
	]},
	{ group: "Navigation", permissions: [
		{ value: "menus:read", label: "View menus" },
		{ value: "menus:manage", label: "Manage menus" },
		{ value: "widgets:read", label: "View widgets" },
		{ value: "widgets:manage", label: "Manage widgets" },
		{ value: "sections:read", label: "View sections" },
		{ value: "sections:manage", label: "Manage sections" },
	]},
	{ group: "Administration", permissions: [
		{ value: "users:read", label: "View users" },
		{ value: "users:invite", label: "Invite users" },
		{ value: "users:manage", label: "Manage users" },
		{ value: "settings:read", label: "View settings" },
		{ value: "settings:manage", label: "Manage settings" },
		{ value: "schema:read", label: "View content types" },
		{ value: "schema:manage", label: "Manage content types" },
		{ value: "plugins:read", label: "View plugins" },
		{ value: "plugins:manage", label: "Manage plugins" },
		{ value: "redirects:read", label: "View redirects" },
		{ value: "redirects:manage", label: "Manage redirects" },
		{ value: "search:read", label: "Search content" },
		{ value: "search:manage", label: "Manage search" },
		{ value: "import:execute", label: "Import content" },
	]},
	{ group: "Auth", permissions: [
		{ value: "auth:manage_own_credentials", label: "Manage own credentials" },
		{ value: "auth:manage_connections", label: "Manage OAuth connections" },
	]},
] as const;
