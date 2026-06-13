/**
 * Cloudflare Access Authentication - RUNTIME MODULE
 *
 * When EmDash is deployed behind Cloudflare Access, this module handles
 * JWT validation and user provisioning from Access identity.
 *
 * Uses jose for JWT verification - works in all runtimes.
 *
 * This is loaded at runtime via the auth provider system.
 * Do not import at config time.
 */

import type { AuthResult } from "emdash";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/**
 * Configuration for Cloudflare Access authentication
 *
 * Note: This interface is duplicated in ../index.ts for config-time usage.
 * Keep them in sync.
 */
export interface AccessConfig {
	/**
	 * Your Cloudflare Access team domain
	 * @example "myteam.cloudflareaccess.com"
	 */
	teamDomain: string;

	/**
	 * Application Audience (AUD) tag from Access application settings.
	 * For Cloudflare Workers, use `audienceEnvVar` instead to read at runtime.
	 */
	audience?: string;

	/**
	 * Environment variable name containing the audience tag.
	 * Read at runtime from environment.
	 * @default "CF_ACCESS_AUDIENCE"
	 */
	audienceEnvVar?: string;

	/**
	 * Role level for users not matching any group in roleMapping
	 * @default 30 (Editor)
	 */
	defaultRole?: number;

	/**
	 * Map IdP group names to EmDash role levels
	 */
	roleMapping?: Record<string, number>;
}

/**
 * Cloudflare Access JWT payload extends standard JWT with email claim
 */
export interface AccessJwtPayload extends JWTPayload {
	/** User's email address (Access-specific claim) */
	email: string;
}

/**
 * Group from IdP (returned by get-identity endpoint)
 */
export interface AccessGroup {
	id: string;
	name: string;
	email?: string;
}

/**
 * Full identity from Access get-identity endpoint
 */
export interface AccessIdentity {
	/** Unique identity ID */
	id: string;
	/** User's display name (may be undefined if IdP doesn't provide it) */
	name?: string;
	/** User's email address */
	email: string;
	/** Groups from IdP */
	groups: AccessGroup[];
	/** Identity provider info */
	idp: {
		id: string;
		type: string;
	};
	/** Custom OIDC claims from IdP */
	oidc_fields?: Record<string, unknown>;
	/** SAML attributes from IdP */
	saml_attributes?: Record<string, unknown>;
	/** User's country (from geo) */
	geo?: {
		country: string;
	};
}

// Cache for JWKS (jose handles key rotation automatically)
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Regex to extract CF_Authorization cookie value */
const CF_AUTHORIZATION_COOKIE_REGEX = /CF_Authorization=([^;]+)/;

/**
 * Get or create a JWKS client for the given team domain
 */
function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	let jwks = jwksCache.get(teamDomain);
	if (!jwks) {
		const jwksUrl = new URL(`https://${teamDomain}/cdn-cgi/access/certs`);
		jwks = createRemoteJWKSet(jwksUrl);
		jwksCache.set(teamDomain, jwks);
	}
	return jwks;
}

/** Default environment variable name for Access audience */
const DEFAULT_AUDIENCE_ENV_VAR = "CF_ACCESS_AUDIENCE";

/**
 * Resolve the audience value from config.
 * Supports direct value or reading from environment variable.
 */
function resolveAudience(config: AccessConfig): string {
	// Direct value takes precedence
	if (config.audience) {
		return config.audience;
	}

	// Read from environment
	const envVarName = config.audienceEnvVar ?? DEFAULT_AUDIENCE_ENV_VAR;
	const value = process.env[envVarName];

	if (typeof value === "string" && value) {
		return value;
	}

	throw new Error(
		`Environment variable "${envVarName}" not found or empty. ` +
			`Set it via wrangler secret, .env, or environment.`,
	);
}

/**
 * Validate a Cloudflare Access JWT using jose
 *
 * @param jwt The JWT string from header or cookie
 * @param config Access configuration
 * @returns Decoded and validated JWT payload
 * @throws Error if validation fails
 */
export async function validateAccessJwt(
	jwt: string,
	config: AccessConfig,
): Promise<AccessJwtPayload> {
	const audience = resolveAudience(config);
	const issuer = `https://${config.teamDomain}`;
	const jwks = getJwks(config.teamDomain);

	const { payload } = await jwtVerify<AccessJwtPayload>(jwt, jwks, {
		issuer,
		audience,
		clockTolerance: 60, // 60 seconds clock skew tolerance
	});

	return payload;
}

/**
 * Extract Access JWT from request
 *
 * Checks header first (more reliable), then falls back to cookie.
 *
 * @param request The incoming request
 * @returns JWT string or null if not present
 */
export function extractAccessJwt(request: Request): string | null {
	// Try header first (preferred - set by Access on all requests)
	const headerJwt = request.headers.get("Cf-Access-Jwt-Assertion");
	if (headerJwt) {
		return headerJwt;
	}

	// Fall back to cookie (set in browser)
	const cookies = request.headers.get("Cookie") || "";
	const match = cookies.match(CF_AUTHORIZATION_COOKIE_REGEX);
	return match?.[1] || null;
}

/**
 * Fetch full identity from Access (includes groups)
 *
 * The JWT itself only contains basic claims. To get groups and other
 * IdP attributes, we need to call the get-identity endpoint.
 *
 * @param jwt The JWT string
 * @param teamDomain The Access team domain
 * @returns Full identity including groups
 */
export async function getAccessIdentity(jwt: string, teamDomain: string): Promise<AccessIdentity> {
	const response = await fetch(`https://${teamDomain}/cdn-cgi/access/get-identity`, {
		headers: {
			Cookie: `CF_Authorization=${jwt}`,
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch identity: ${response.status}`);
	}

	return response.json();
}

/**
 * Resolve role from IdP groups using roleMapping config
 *
 * @param groups User's groups from IdP
 * @param config Access configuration
 * @returns Role level (e.g., 50 for Admin, 30 for Editor)
 */
export function resolveRoleFromGroups(groups: AccessGroup[], config: AccessConfig): number {
	const defaultRole = config.defaultRole ?? 30; // Editor

	if (!config.roleMapping) {
		return defaultRole;
	}

	// Check each group against mapping (first match wins)
	for (const group of groups) {
		const role = config.roleMapping[group.name];
		if (role !== undefined) {
			return role;
		}
	}

	return defaultRole;
}

/**
 * Authenticate a request using Cloudflare Access
 *
 * This is the main entry point for Access authentication.
 * It validates the JWT, fetches the full identity, and resolves the role.
 *
 * This function implements the AuthProviderModule.authenticate interface.
 *
 * @param request The incoming request
 * @param config Access configuration (passed from AuthDescriptor)
 * @returns Authentication result with user info and role
 * @throws Error if authentication fails
 */
function isAccessConfig(value: unknown): value is AccessConfig {
	return (
		value != null &&
		typeof value === "object" &&
		"teamDomain" in value &&
		typeof value.teamDomain === "string"
	);
}

export async function authenticate(request: Request, config: unknown): Promise<AuthResult> {
	if (!isAccessConfig(config)) {
		throw new Error("Invalid Cloudflare Access config: teamDomain is required");
	}
	const accessConfig = config;

	// Extract JWT
	const jwt = extractAccessJwt(request);
	if (!jwt) {
		throw new Error("No Access JWT present");
	}

	// Validate JWT
	const payload = await validateAccessJwt(jwt, accessConfig);

	// Fetch full identity (includes groups)
	const identity = await getAccessIdentity(jwt, accessConfig.teamDomain);

	// Resolve role from groups
	const role = resolveRoleFromGroups(identity.groups, accessConfig);

	// Log identity for debugging
	console.log(
		"[cf-access] Identity from Access:",
		JSON.stringify({
			email: identity.email,
			name: identity.name,
			groups: identity.groups?.map((g) => g.name),
			idp: identity.idp,
		}),
	);

	return {
		email: identity.email,
		name: identity.name ?? identity.email.split("@")[0] ?? "Unknown",
		role,
		subject: payload.sub,
		metadata: {
			groups: identity.groups,
			idp: identity.idp,
		},
	};
}
