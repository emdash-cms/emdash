/**
 * Microsoft Entra ID OAuth provider (OIDC, v2.0 endpoints)
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

import type { MicrosoftOAuthConfig, OAuthProfile, OAuthProvider } from "../types.js";

const LOGIN_HOST = "https://login.microsoftonline.com";

/** Tenant ID of personal Microsoft accounts */
const CONSUMERS_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";

const MULTI_TENANT_SEGMENTS = new Set(["common", "organizations", "consumers"]);

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Microsoft documents `xms_edov` as a boolean, but its encoding in tokens is
 * reported inconsistently, so the string and number forms of true count too.
 */
const XMS_EDOV_TRUE = new Set<unknown>([true, "true", 1, "1"]);

const idTokenClaimsSchema = z.object({
	sub: z.string(),
	iss: z.string(),
	tid: z.string(),
	nonce: z.string(),
	idp: z.string().optional(),
	email: z.string().optional(),
	preferred_username: z.string().optional(),
	name: z.string().optional(),
	xms_edov: z.unknown().optional(),
});

/**
 * Whether `tenant` is a directory (tenant) ID or one of the multi-tenant
 * segments. Domain names are rejected because the ID token identifies the
 * tenant by ID only, so a domain could not be checked against it.
 */
export function isValidMicrosoftTenant(tenant: string): boolean {
	return TENANT_ID_PATTERN.test(tenant) || MULTI_TENANT_SEGMENTS.has(tenant);
}

function domainOf(address: string | undefined): string | undefined {
	if (!address) return undefined;
	const at = address.lastIndexOf("@");
	return at === -1 ? undefined : address.slice(at + 1).toLowerCase();
}

const JWKS_CACHE_KEY = Symbol.for("emdash:auth:microsoft-jwks");

function getTenantKeys(tenant: string): JWTVerifyGetKey {
	const g = globalThis as Record<symbol, unknown>;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see core request-context.ts)
	let cache = g[JWKS_CACHE_KEY] as Map<string, JWTVerifyGetKey> | undefined;
	if (!cache) {
		cache = new Map();
		g[JWKS_CACHE_KEY] = cache;
	}
	let keys = cache.get(tenant);
	if (!keys) {
		keys = createRemoteJWKSet(new URL(`${LOGIN_HOST}/${tenant}/discovery/v2.0/keys`));
		cache.set(tenant, keys);
	}
	return keys;
}

function checkTenant(configured: string, tid: string): void {
	const tenantId = tid.toLowerCase();
	if (configured === "common") return;
	if (configured === "organizations") {
		if (tenantId === CONSUMERS_TENANT_ID) {
			throw new Error("Personal Microsoft accounts are not accepted");
		}
		return;
	}
	const expected = configured === "consumers" ? CONSUMERS_TENANT_ID : configured.toLowerCase();
	if (tenantId !== expected) {
		throw new Error("ID token was issued for a different tenant");
	}
}

/**
 * Create the Microsoft provider for one app registration.
 *
 * @param keys - Signing key source; defaults to the tenant's published JWKS
 */
export function createMicrosoftProvider(
	config: MicrosoftOAuthConfig,
	keys?: JWTVerifyGetKey,
): OAuthProvider {
	if (!isValidMicrosoftTenant(config.tenant)) {
		throw new Error(`Invalid Microsoft tenant: ${config.tenant}`);
	}
	const specificTenant =
		!MULTI_TENANT_SEGMENTS.has(config.tenant) &&
		config.tenant.toLowerCase() !== CONSUMERS_TENANT_ID;
	const endpoint = `${LOGIN_HOST}/${config.tenant}/oauth2/v2.0`;

	return {
		name: "microsoft",
		authorizeUrl: `${endpoint}/authorize`,
		tokenUrl: `${endpoint}/token`,
		scopes: ["openid", "email", "profile"],
		requireVerifiedEmailForSignup: true,

		async verifyIdToken(idToken: string, nonce: string): Promise<unknown> {
			const { payload } = await jwtVerify(idToken, keys ?? getTenantKeys(config.tenant), {
				audience: config.clientId,
				algorithms: ["RS256"],
				requiredClaims: ["exp"],
			});
			const claims = idTokenClaimsSchema.parse(payload);
			// With `common` and `organizations` the issuer names the user's
			// tenant, so it can only be checked against the token's own `tid`.
			if (claims.iss !== `${LOGIN_HOST}/${claims.tid}/v2.0`) {
				throw new Error("ID token issuer does not match its tenant");
			}
			checkTenant(config.tenant, claims.tid);
			if (claims.nonce !== nonce) {
				throw new Error("ID token nonce does not match");
			}
			return payload;
		},

		parseProfile(data: unknown): OAuthProfile {
			const claims = idTokenClaimsSchema.parse(data);
			const email = claims.email ?? claims.preferred_username;
			if (!email?.includes("@")) {
				throw new Error("ID token carries no email address");
			}
			// A guest signs in through another directory or identity provider,
			// which `idp` names; for accounts of the tenant itself it is absent
			// or equal to the issuer.
			const guest = claims.idp !== undefined && claims.idp !== claims.iss;
			// An administrator can set a member's `email` to any address, while
			// `preferred_username` can only end in a domain the tenant has
			// verified. `xms_edov` is Microsoft's own check, sent only when the
			// app registration requests it.
			const domainOwned =
				claims.email === undefined ||
				domainOf(claims.email) === domainOf(claims.preferred_username) ||
				XMS_EDOV_TRUE.has(claims.xms_edov);
			return {
				id: claims.sub,
				email,
				name: claims.name ?? null,
				avatarUrl: null,
				emailVerified: config.emailVerified ?? (specificTenant && !guest && domainOwned),
			};
		},
	};
}
