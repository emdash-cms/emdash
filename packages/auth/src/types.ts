/**
 * Core types for @emdash-cms/auth
 */

// ============================================================================
// Roles & Permissions
// ============================================================================

export const Role = {
	SUBSCRIBER: 10,
	CONTRIBUTOR: 20,
	AUTHOR: 30,
	EDITOR: 40,
	ADMIN: 50,
} as const;

export type RoleLevel = (typeof Role)[keyof typeof Role];
export type RoleName = keyof typeof Role;

export function roleFromLevel(level: number): RoleName | undefined {
	const entry = Object.entries(Role).find(([, v]) => v === level);
	if (!entry) return undefined;
	const name = entry[0];
	if (isRoleName(name)) return name;
	return undefined;
}

function isRoleName(value: string): value is RoleName {
	return value in Role;
}

const ROLE_LEVEL_MAP = new Map<number, RoleLevel>(Object.values(Role).map((v) => [v, v]));

export function toRoleLevel(value: number): RoleLevel {
	const level = ROLE_LEVEL_MAP.get(value);
	if (level !== undefined) return level;
	throw new Error(`Invalid role level: ${value}`);
}

const DEVICE_TYPE_MAP: Record<string, DeviceType | undefined> = {
	singleDevice: "singleDevice",
	multiDevice: "multiDevice",
};

export function toDeviceType(value: string): DeviceType {
	const dt = DEVICE_TYPE_MAP[value];
	if (dt !== undefined) return dt;
	throw new Error(`Invalid device type: ${value}`);
}

const TOKEN_TYPE_MAP: Record<string, TokenType | undefined> = {
	magic_link: "magic_link",
	email_verify: "email_verify",
	invite: "invite",
	recovery: "recovery",
};

export function toTokenType(value: string): TokenType {
	const tt = TOKEN_TYPE_MAP[value];
	if (tt !== undefined) return tt;
	throw new Error(`Invalid token type: ${value}`);
}

export function roleToLevel(name: RoleName): RoleLevel {
	return Role[name];
}

// ============================================================================
// User
// ============================================================================

export interface User {
	id: string;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	role: RoleLevel;
	emailVerified: boolean;
	disabled: boolean;
	data: Record<string, unknown> | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface NewUser {
	email: string;
	name?: string | null;
	avatarUrl?: string | null;
	role?: RoleLevel;
	emailVerified?: boolean;
	data?: Record<string, unknown> | null;
}

export interface UpdateUser {
	email?: string;
	name?: string | null;
	avatarUrl?: string | null;
	role?: RoleLevel;
	emailVerified?: boolean;
	disabled?: boolean;
	data?: Record<string, unknown> | null;
}

// ============================================================================
// Credentials (Passkeys)
// ============================================================================

export type AuthenticatorTransport = "usb" | "nfc" | "ble" | "internal" | "hybrid";
export type DeviceType = "singleDevice" | "multiDevice";

export interface Credential {
	id: string; // Base64url credential ID
	userId: string;
	publicKey: Uint8Array; // Encoded public key (SEC1 for ECDSA, PKIX for RSA)
	algorithm: number; // COSE algorithm identifier (e.g., -7 for ES256, -257 for RS256)
	counter: number;
	deviceType: DeviceType;
	backedUp: boolean;
	transports: AuthenticatorTransport[];
	name: string | null;
	createdAt: Date;
	lastUsedAt: Date;
}

export interface NewCredential {
	id: string;
	userId: string;
	publicKey: Uint8Array;
	algorithm: number;
	counter: number;
	deviceType: DeviceType;
	backedUp: boolean;
	transports: AuthenticatorTransport[];
	name?: string | null;
}

// ============================================================================
// Sessions
// ============================================================================

export interface Session {
	id: string;
	userId: string;
	expiresAt: Date;
	ipAddress: string | null;
	userAgent: string | null;
	createdAt: Date;
}

export interface SessionData {
	userId: string;
	expiresAt: number; // Unix timestamp
}

// ============================================================================
// Auth Tokens (magic links, invites, etc.)
// ============================================================================

export type TokenType = "magic_link" | "email_verify" | "invite" | "recovery";

export interface AuthToken {
	hash: string; // SHA-256 hash of the raw token
	userId: string | null; // null for pre-user tokens (invite/signup)
	email: string | null; // For pre-user tokens
	type: TokenType;
	role: RoleLevel | null; // For invites
	invitedBy: string | null;
	expiresAt: Date;
	createdAt: Date;
}

export interface NewAuthToken {
	hash: string;
	userId?: string | null;
	email?: string | null;
	type: TokenType;
	role?: RoleLevel | null;
	invitedBy?: string | null;
	expiresAt: Date;
}

// ============================================================================
// OAuth Accounts
// ============================================================================

export interface OAuthAccount {
	provider: string;
	providerAccountId: string;
	userId: string;
	createdAt: Date;
}

export interface NewOAuthAccount {
	provider: string;
	providerAccountId: string;
	userId: string;
}

// ============================================================================
// OAuth Connections (SSO config)
// ============================================================================

export interface OAuthConnection {
	id: string;
	name: string;
	provider: "oidc" | "github" | "google";
	clientId: string;
	clientSecretEnc: string; // Encrypted
	issuerUrl: string | null;
	config: Record<string, unknown> | null;
	enabled: boolean;
	createdAt: Date;
}

// ============================================================================
// OAuth Clients (when EmDash is provider)
// ============================================================================

export interface OAuthClient {
	id: string;
	name: string;
	secretHash: string;
	redirectUris: string[];
	scopes: string[];
	createdAt: Date;
}

// ============================================================================
// Allowed Domains (self-signup)
// ============================================================================

export interface AllowedDomain {
	domain: string;
	defaultRole: RoleLevel;
	enabled: boolean;
	createdAt: Date;
}

// ============================================================================
// User Listing Types (for admin UI)
// ============================================================================

/** Extended user with list view computed fields */
export interface UserListItem extends User {
	lastLogin: Date | null;
	credentialCount: number;
	oauthProviders: string[];
}

/** User with full details including related data */
export interface UserWithDetails {
	user: User;
	credentials: Credential[];
	oauthAccounts: OAuthAccount[];
	lastLogin: Date | null;
}

// ============================================================================
// Auth Adapter Interface
// ============================================================================

export interface AuthAdapter {
	// Users
	getUserById(id: string): Promise<User | null>;
	getUserByEmail(email: string): Promise<User | null>;
	createUser(user: NewUser): Promise<User>;
	updateUser(id: string, data: UpdateUser): Promise<void>;
	deleteUser(id: string): Promise<void>;
	countUsers(): Promise<number>;

	// User listing and details (for admin)
	getUsers(options?: {
		search?: string;
		role?: number;
		cursor?: string;
		limit?: number;
	}): Promise<{ items: UserListItem[]; nextCursor?: string }>;
	getUserWithDetails(id: string): Promise<UserWithDetails | null>;
	countAdmins(): Promise<number>;

	// Credentials
	getCredentialById(id: string): Promise<Credential | null>;
	getCredentialsByUserId(userId: string): Promise<Credential[]>;
	createCredential(credential: NewCredential): Promise<Credential>;
	updateCredentialCounter(id: string, counter: number): Promise<void>;
	updateCredentialName(id: string, name: string | null): Promise<void>;
	deleteCredential(id: string): Promise<void>;
	countCredentialsByUserId(userId: string): Promise<number>;

	// Auth Tokens
	createToken(token: NewAuthToken): Promise<void>;
	getToken(hash: string, type: TokenType): Promise<AuthToken | null>;
	deleteToken(hash: string): Promise<void>;
	deleteExpiredTokens(): Promise<void>;

	// OAuth Accounts
	getOAuthAccount(provider: string, providerAccountId: string): Promise<OAuthAccount | null>;
	getOAuthAccountsByUserId(userId: string): Promise<OAuthAccount[]>;
	createOAuthAccount(account: NewOAuthAccount): Promise<OAuthAccount>;
	deleteOAuthAccount(provider: string, providerAccountId: string): Promise<void>;

	// Allowed Domains
	getAllowedDomain(domain: string): Promise<AllowedDomain | null>;
	getAllowedDomains(): Promise<AllowedDomain[]>;
	createAllowedDomain(domain: string, defaultRole: RoleLevel): Promise<AllowedDomain>;
	updateAllowedDomain(domain: string, enabled: boolean, defaultRole?: RoleLevel): Promise<void>;
	deleteAllowedDomain(domain: string): Promise<void>;
}

// ============================================================================
// Email Adapter Interface
// ============================================================================

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

export interface EmailAdapter {
	send(message: EmailMessage): Promise<void>;
}

// ============================================================================
// Auth Errors
// ============================================================================

export class AuthError extends Error {
	constructor(
		public code: AuthErrorCode,
		message?: string,
	) {
		super(message ?? code);
		this.name = "AuthError";
	}
}

export type AuthErrorCode =
	| "invalid_credentials"
	| "invalid_token"
	| "token_expired"
	| "user_not_found"
	| "user_exists"
	| "credential_exists"
	| "max_credentials"
	| "email_not_verified"
	| "signup_not_allowed"
	| "domain_not_allowed"
	| "forbidden"
	| "unauthorized"
	| "rate_limited"
	| "invalid_request"
	| "internal_error";
