/**
 * User management, passkeys, and allowed domains APIs
 */

import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type FindManyResult,
} from "./client.js";

// =============================================================================
// User Management API
// =============================================================================

/** User list item with computed fields */
export interface UserListItem {
	id: string;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	role: number;
	emailVerified: boolean;
	disabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastLogin: string | null;
	credentialCount: number;
	oauthProviders: string[];
}

/** User detail with credentials and OAuth accounts */
export interface UserDetail extends UserListItem {
	credentials: Array<{
		id: string;
		name: string | null;
		deviceType: string;
		createdAt: string;
		lastUsedAt: string;
	}>;
	oauthAccounts: Array<{
		provider: string;
		createdAt: string;
	}>;
}

/** User update input */
export interface UpdateUserInput {
	name?: string;
	email?: string;
	role?: number;
}

/**
 * Fetch users with search, filter, and pagination
 */
export async function fetchUsers(options?: {
	search?: string;
	role?: number;
	cursor?: string;
	limit?: number;
}): Promise<FindManyResult<UserListItem>> {
	const params = new URLSearchParams();
	if (options?.search) params.set("search", options.search);
	if (options?.role !== undefined) params.set("role", String(options.role));
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit) params.set("limit", String(options.limit));

	const url = `${API_BASE}/admin/users${params.toString() ? `?${params}` : ""}`;
	const response = await apiFetch(url);
	return parseApiResponse<FindManyResult<UserListItem>>(response, "Failed to fetch users");
}

/**
 * Fetch a single user with details
 */
export async function fetchUser(id: string): Promise<UserDetail> {
	const response = await apiFetch(`${API_BASE}/admin/users/${id}`);

	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`User not found: ${id}`);
		}
		await throwResponseError(response, "Failed to fetch user");
	}

	const data = await parseApiResponse<{ item: UserDetail }>(response, "Failed to fetch user");
	return data.item;
}

/**
 * Update a user
 */
export async function updateUser(id: string, input: UpdateUserInput): Promise<UserDetail> {
	const response = await apiFetch(`${API_BASE}/admin/users/${id}`, {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ item: UserDetail }>(response, "Failed to update user");
	return data.item;
}

/**
 * Disable a user
 */
export async function disableUser(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/users/${id}/disable`, {
		method: "POST",
	});
	if (!response.ok) await throwResponseError(response, "Failed to disable user");
}

/**
 * Send a recovery magic link to a user
 */
export async function sendRecoveryLink(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/users/${id}/send-recovery`, {
		method: "POST",
	});
	if (!response.ok) await throwResponseError(response, "Failed to send recovery link");
}

/**
 * Enable a user
 */
export async function enableUser(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/admin/users/${id}/enable`, {
		method: "POST",
	});
	if (!response.ok) await throwResponseError(response, "Failed to enable user");
}

/** Invite response -- includes inviteUrl when no email provider is configured */
export interface InviteResult {
	success: true;
	message: string;
	/** Present when no email provider is configured (copy-link fallback) */
	inviteUrl?: string;
}

/**
 * Invite a new user
 *
 * Uses the existing /auth/invite endpoint.
 * When no email provider is configured, the response includes
 * an `inviteUrl` for manual sharing.
 */
export async function inviteUser(email: string, role?: number): Promise<InviteResult> {
	const response = await apiFetch(`${API_BASE}/auth/invite`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email, role }),
	});
	return parseApiResponse<InviteResult>(response, "Failed to invite user");
}

// =============================================================================
// Passkey Management API
// =============================================================================

/**
 * Passkey info returned from API
 */
export interface PasskeyInfo {
	id: string;
	name: string | null;
	deviceType: "singleDevice" | "multiDevice";
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string;
}

export interface TwoFactorStatus {
	enabled: boolean;
	hasPendingSetup: boolean;
	enabledAt: string | null;
}

export interface TwoFactorSetupResult {
	secret: string;
	otpAuthUrl: string;
}

export interface TwoFactorPendingStatus {
	pending: boolean;
	expiresAt?: number;
	expiresInMs?: number;
}

/**
 * List all passkeys for the current user
 */
export async function fetchPasskeys(): Promise<PasskeyInfo[]> {
	const response = await apiFetch(`${API_BASE}/auth/passkey`);
	const data = await parseApiResponse<{ items: PasskeyInfo[] }>(
		response,
		"Failed to fetch passkeys",
	);
	return data.items;
}

/**
 * Rename a passkey
 */
export async function renamePasskey(id: string, name: string): Promise<PasskeyInfo> {
	const response = await apiFetch(`${API_BASE}/auth/passkey/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
	});
	const data = await parseApiResponse<{ passkey: PasskeyInfo }>(
		response,
		"Failed to rename passkey",
	);
	return data.passkey;
}

/**
 * Delete a passkey
 */
export async function deletePasskey(id: string): Promise<void> {
	const response = await apiFetch(`${API_BASE}/auth/passkey/${id}`, {
		method: "DELETE",
	});
	if (!response.ok) await throwResponseError(response, "Failed to delete passkey");
}

export async function fetchTwoFactorStatus(): Promise<TwoFactorStatus> {
	const response = await apiFetch(`${API_BASE}/auth/2fa/status`);
	return parseApiResponse<TwoFactorStatus>(response, "Failed to fetch two-factor status");
}

export async function fetchTwoFactorPendingStatus(): Promise<TwoFactorPendingStatus> {
	const response = await apiFetch(`${API_BASE}/auth/2fa/pending`);
	return parseApiResponse<TwoFactorPendingStatus>(
		response,
		"Failed to fetch pending two-factor status",
	);
}

export async function beginTwoFactorSetup(): Promise<TwoFactorSetupResult> {
	const response = await apiFetch(`${API_BASE}/auth/2fa/setup`, {
		method: "POST",
	});
	return parseApiResponse<TwoFactorSetupResult>(
		response,
		"Failed to start two-factor setup",
	);
}

export async function enableTwoFactorAuth(code: string): Promise<{ success: boolean; enabled: boolean }> {
	const response = await apiFetch(`${API_BASE}/auth/2fa/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	return parseApiResponse<{ success: boolean; enabled: boolean }>(
		response,
		"Failed to enable two-factor authentication",
	);
}

export async function disableTwoFactorAuth(
	code: string,
): Promise<{ success: boolean; enabled: boolean }> {
	const response = await apiFetch(`${API_BASE}/auth/2fa/disable`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	return parseApiResponse<{ success: boolean; enabled: boolean }>(
		response,
		"Failed to disable two-factor authentication",
	);
}

export async function verifyTwoFactorLogin(
	code: string,
): Promise<{ success: boolean; user: UserListItem }> {
	const response = await apiFetch(`${API_BASE}/auth/2fa/verify`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	return parseApiResponse<{ success: boolean; user: UserListItem }>(
		response,
		"Failed to verify two-factor code",
	);
}

// =============================================================================
// Allowed Domains API (Self-Signup)
// =============================================================================

/** Allowed domain for self-signup */
export interface AllowedDomain {
	domain: string;
	defaultRole: number;
	roleName: string;
	enabled: boolean;
	createdAt: string;
}

/** Create allowed domain input */
export interface CreateAllowedDomainInput {
	domain: string;
	defaultRole: number;
}

/** Update allowed domain input */
export interface UpdateAllowedDomainInput {
	enabled?: boolean;
	defaultRole?: number;
}

/**
 * Fetch all allowed domains
 */
export async function fetchAllowedDomains(): Promise<AllowedDomain[]> {
	const response = await apiFetch(`${API_BASE}/admin/allowed-domains`);
	const data = await parseApiResponse<{ domains: AllowedDomain[] }>(
		response,
		"Failed to fetch allowed domains",
	);
	return data.domains;
}

/**
 * Create an allowed domain
 */
export async function createAllowedDomain(input: CreateAllowedDomainInput): Promise<AllowedDomain> {
	const response = await apiFetch(`${API_BASE}/admin/allowed-domains`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = await parseApiResponse<{ domain: AllowedDomain }>(
		response,
		"Failed to create allowed domain",
	);
	return data.domain;
}

/**
 * Update an allowed domain
 */
export async function updateAllowedDomain(
	domain: string,
	input: UpdateAllowedDomainInput,
): Promise<AllowedDomain> {
	const response = await apiFetch(
		`${API_BASE}/admin/allowed-domains/${encodeURIComponent(domain)}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	const data = await parseApiResponse<{ domain: AllowedDomain }>(
		response,
		"Failed to update allowed domain",
	);
	return data.domain;
}

/**
 * Delete an allowed domain
 */
export async function deleteAllowedDomain(domain: string): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/admin/allowed-domains/${encodeURIComponent(domain)}`,
		{
			method: "DELETE",
		},
	);
	if (!response.ok) await throwResponseError(response, "Failed to delete allowed domain");
}

// =============================================================================
// Self-Signup API
// =============================================================================

/** Signup verification result */
export interface SignupVerifyResult {
	email: string;
	role: number;
	roleName: string;
}

/**
 * Request signup - send verification email
 * Always returns success to prevent enumeration
 */
export async function requestSignup(email: string): Promise<{ success: true; message: string }> {
	const response = await apiFetch(`${API_BASE}/auth/signup/request`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email }),
	});
	return parseApiResponse<{ success: true; message: string }>(response, "Signup request failed");
}

/**
 * Verify signup token
 *
 * Uses custom error handling to preserve error codes for the UI.
 */
export async function verifySignupToken(token: string): Promise<SignupVerifyResult> {
	const response = await apiFetch(
		`${API_BASE}/auth/signup/verify?token=${encodeURIComponent(token)}`,
	);

	if (!response.ok) {
		const errorData: unknown = await response.json().catch(() => ({}));
		let message = `Token verification failed: ${response.statusText}`;
		let code: string | undefined;
		if (typeof errorData === "object" && errorData !== null && "error" in errorData) {
			const err = errorData.error;
			if (typeof err === "object" && err !== null) {
				if ("message" in err && typeof err.message === "string") message = err.message;
				if ("code" in err && typeof err.code === "string") code = err.code;
			}
		}
		const error: Error & { code?: string } = new Error(message);
		error.code = code;
		throw error;
	}

	return parseApiResponse<SignupVerifyResult>(response, "Token verification failed");
}

/**
 * Complete signup with passkey registration
 *
 * Uses custom error handling to preserve error codes for the UI.
 */
export async function completeSignup(
	token: string,
	credential: unknown,
	name?: string,
): Promise<{
	success: true;
	user: { id: string; email: string; name: string | null; role: number };
}> {
	const response = await apiFetch(`${API_BASE}/auth/signup/complete`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token, credential, name }),
	});

	if (!response.ok) {
		const errorData: unknown = await response.json().catch(() => ({}));
		let message = `Signup completion failed: ${response.statusText}`;
		let code: string | undefined;
		if (typeof errorData === "object" && errorData !== null && "error" in errorData) {
			const err = errorData.error;
			if (typeof err === "object" && err !== null) {
				if ("message" in err && typeof err.message === "string") message = err.message;
				if ("code" in err && typeof err.code === "string") code = err.code;
			}
		}
		const error: Error & { code?: string } = new Error(message);
		error.code = code;
		throw error;
	}

	return parseApiResponse<{
		success: true;
		user: { id: string; email: string; name: string | null; role: number };
	}>(response, "Signup completion failed");
}

/**
 * Check if any allowed domains exist (for showing signup link)
 */
export async function hasAllowedDomains(): Promise<boolean> {
	try {
		const domains = await fetchAllowedDomains();
		return domains.some((d) => d.enabled);
	} catch {
		// If we can't fetch (e.g., not logged in), assume no domains
		return false;
	}
}
