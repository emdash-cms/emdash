import { createRemoteJWKSet, jwtVerify } from "jose";

export type OperatorRole = "admin" | "reviewer";

export type OperatorIdentity =
	| { kind: "human"; email: string; sub: string; roles: readonly OperatorRole[] }
	| { kind: "service"; commonName: string; sub: string; roles: readonly OperatorRole[] };

export interface AccessAuthConfig {
	teamDomain: string;
	audience: string;
	admins: readonly string[];
	reviewers: readonly string[];
}

export class AccessAuthError extends Error {
	readonly reason: "missing-token" | "invalid-token";

	constructor(reason: "missing-token" | "invalid-token", message: string, options?: ErrorOptions) {
		super(message, options);
		this.reason = reason;
	}
}

export type AccessKeyResolver = Parameters<typeof jwtVerify>[1];

export function parseAccessAuthConfig(value: unknown): AccessAuthConfig {
	if (!isRecord(value)) throw new TypeError("Access auth config must be an object");
	const teamDomain = value.teamDomain;
	if (typeof teamDomain !== "string" || teamDomain.length === 0)
		throw new TypeError("Access auth config teamDomain must be a non-empty string");
	let teamDomainUrl: URL;
	try {
		teamDomainUrl = new URL(teamDomain);
	} catch {
		throw new TypeError("Access auth config teamDomain must be an HTTPS origin");
	}
	if (
		teamDomainUrl.protocol !== "https:" ||
		teamDomainUrl.username !== "" ||
		teamDomainUrl.password !== "" ||
		teamDomainUrl.search !== "" ||
		teamDomainUrl.hash !== "" ||
		teamDomainUrl.pathname !== "/"
	)
		throw new TypeError("Access auth config teamDomain must be an HTTPS origin");
	const audience = value.audience;
	if (typeof audience !== "string" || audience.length === 0)
		throw new TypeError("Access auth config audience must be a non-empty string");
	return {
		teamDomain: teamDomainUrl.origin,
		audience,
		admins: parseStringArray(value.admins, "admins"),
		reviewers: parseStringArray(value.reviewers, "reviewers"),
	};
}

function parseStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value)) throw new TypeError(`Access auth config ${field} must be an array`);
	if (!value.every((entry): entry is string => typeof entry === "string" && entry.length > 0))
		throw new TypeError(`Access auth config ${field} must contain non-empty strings`);
	return value;
}

const ACCESS_JWKS_CACHE_KEY = Symbol.for("emdash-labeler:access-jwks");
type AccessJwksCache = Map<string, AccessKeyResolver>;

export function getAccessKeyResolver(teamDomain: string): AccessKeyResolver {
	const g = globalThis as Record<symbol, unknown>;
	// Cached on globalThis (Symbol.for) so Vite SSR chunk duplication and isolate
	// reuse share one resolver per team domain; createRemoteJWKSet already
	// handles kid rotation and cooldown internally.
	const cache: AccessJwksCache =
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
		(g[ACCESS_JWKS_CACHE_KEY] as AccessJwksCache | undefined) ??
		(() => {
			const c: AccessJwksCache = new Map();
			g[ACCESS_JWKS_CACHE_KEY] = c;
			return c;
		})();
	let resolver = cache.get(teamDomain);
	if (!resolver) {
		resolver = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
		cache.set(teamDomain, resolver);
	}
	return resolver;
}

export async function verifyAccessRequest(
	request: Request,
	config: AccessAuthConfig,
	keys: AccessKeyResolver,
): Promise<OperatorIdentity> {
	// Identity comes only from a verified assertion; other headers (e.g.
	// Cf-Access-Authenticated-User-Email) are attacker-controlled and never read.
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) throw new AccessAuthError("missing-token", "Access assertion header is missing");

	let payload: Record<string, unknown>;
	try {
		const result = await jwtVerify(token, keys, {
			algorithms: ["RS256"],
			requiredClaims: ["exp"],
			issuer: config.teamDomain,
			audience: config.audience,
		});
		payload = result.payload;
	} catch (cause) {
		throw new AccessAuthError("invalid-token", "Access assertion failed verification", { cause });
	}

	const sub = payload.sub;
	if (typeof sub !== "string" || sub.length === 0)
		throw new AccessAuthError("invalid-token", "Access assertion is missing sub");

	const commonName = payload.common_name;
	const email = payload.email;

	let identity: OperatorIdentity;
	if (typeof commonName === "string" && commonName.length > 0) {
		identity = { kind: "service", commonName, sub, roles: [] };
	} else if (typeof email === "string" && email.length > 0) {
		identity = { kind: "human", email, sub, roles: [] };
	} else {
		throw new AccessAuthError(
			"invalid-token",
			"Access assertion has neither email nor common_name",
		);
	}

	const principal = identity.kind === "service" ? identity.commonName : identity.email;
	const principals = new Set<string>([principal, ...groupPrincipals(payload.groups)]);
	const roles: OperatorRole[] = [];
	if (config.admins.some((admin) => principals.has(admin))) roles.push("admin");
	if (config.reviewers.some((reviewer) => principals.has(reviewer))) roles.push("reviewer");

	return { ...identity, roles };
}

function groupPrincipals(groups: unknown): readonly string[] {
	if (!Array.isArray(groups)) return [];
	return groups.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function hasRole(identity: OperatorIdentity, role: OperatorRole): boolean {
	if (identity.roles.includes(role)) return true;
	return role === "reviewer" && identity.roles.includes("admin");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
