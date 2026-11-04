import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { ApiError } from "../api/errors.js";

const ACCESS_JWKS_CACHE_SYMBOL = Symbol.for("@emdash-cms/release-service/access-jwks-cache");
const ACCESS_TOKEN_HEADER = "cf-access-jwt-assertion";
const OPERATOR_REQUEST_HEADER = "x-emdash-request";
const MAX_ACCESS_TOKEN_CHARS = 16 * 1024;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const HUMAN_SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

export type AccessRole = "viewer" | "reviewer" | "admin";

export interface AccessConfiguration {
	teamDomain: string;
	audiences: Readonly<Record<AccessRole, string | readonly string[]>>;
}

export interface AccessActor {
	realm: "access";
	identity: string;
	email: string;
	role: AccessRole;
}

export function accessRoleForOperatorPath(pathname: string): AccessRole | null {
	for (const role of ["viewer", "reviewer", "admin"] as const) {
		if (pathname.startsWith(`/admin/api/${role}/`)) return role;
	}
	return null;
}

function getAccessJwksCache(): Map<string, JWTVerifyGetKey> {
	const target = globalThis as typeof globalThis & {
		[ACCESS_JWKS_CACHE_SYMBOL]?: Map<string, JWTVerifyGetKey>;
	};
	return (target[ACCESS_JWKS_CACHE_SYMBOL] ??= new Map());
}

function getAccessJwks(teamDomain: string): JWTVerifyGetKey {
	const cache = getAccessJwksCache();
	let resolver = cache.get(teamDomain);
	if (!resolver) {
		resolver = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
		cache.set(teamDomain, resolver);
	}
	return resolver;
}

export async function authenticateAccessRequest(
	request: Request,
	requiredRole: AccessRole,
	configuration: AccessConfiguration,
	keyResolver: JWTVerifyGetKey = getAccessJwks(configuration.teamDomain),
): Promise<AccessActor> {
	const token = request.headers.get(ACCESS_TOKEN_HEADER);
	if (!token) {
		throw new ApiError("ACCESS_AUTH_REQUIRED", 401, "Access authentication required");
	}
	if (token.length > MAX_ACCESS_TOKEN_CHARS) {
		throw new ApiError("ACCESS_AUTH_INVALID", 403, "Access authorization failed");
	}
	try {
		const configuredAudience = configuration.audiences[requiredRole];
		const { payload } = await jwtVerify(token, keyResolver, {
			algorithms: ["RS256"],
			audience:
				typeof configuredAudience === "string" ? configuredAudience : [...configuredAudience],
			clockTolerance: 5,
			issuer: configuration.teamDomain,
			typ: "JWT",
			requiredClaims: ["exp", "iat", "nbf", "sub", "email", "type"],
		});
		const now = Math.floor(Date.now() / 1000);
		if (
			payload["type"] !== "app" ||
			!Number.isSafeInteger(payload.iat) ||
			!Number.isSafeInteger(payload.nbf) ||
			!Number.isSafeInteger(payload.exp) ||
			Number(payload.iat) > now + 5 ||
			Number(payload.iat) > Number(payload.exp) ||
			typeof payload.sub !== "string" ||
			!HUMAN_SUBJECT_PATTERN.test(payload.sub) ||
			typeof payload["email"] !== "string" ||
			payload["email"].length > 320 ||
			!EMAIL_PATTERN.test(payload["email"])
		) {
			throw new Error("Invalid Access identity claims");
		}
		return {
			realm: "access",
			identity: payload.sub,
			email: payload["email"],
			role: requiredRole,
		};
	} catch {
		throw new ApiError("ACCESS_AUTH_INVALID", 403, "Access authorization failed");
	}
}

export function validateAccessMutation(request: Request, publicOrigin: string): void {
	if (
		request.headers.get("origin") !== publicOrigin ||
		request.headers.get(OPERATOR_REQUEST_HEADER) !== "1"
	) {
		throw new ApiError("CSRF_INVALID", 403, "Request origin validation failed");
	}
	const idempotencyKey = request.headers.get("idempotency-key");
	if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
		throw new ApiError("IDEMPOTENCY_KEY_INVALID", 400, "Valid idempotency key required");
	}
}
