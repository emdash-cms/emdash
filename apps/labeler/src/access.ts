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

export type AccessKeyResolver = Parameters<typeof jwtVerify>[1];

export class AccessAuthError extends Error {
	override readonly name = "AccessAuthError";
}

export function parseAccessAuthConfig(value: unknown): AccessAuthConfig {
	if (!isRecord(value)) throw new TypeError("Access auth config must be an object");
	return {
		teamDomain: parseHttpsOrigin(value["teamDomain"]),
		audience: requiredString(value["audience"], "audience"),
		admins: stringArray(value["admins"], "admins"),
		reviewers: stringArray(value["reviewers"], "reviewers"),
	};
}

export function readAccessAuthConfig(env: object): AccessAuthConfig {
	const raw: unknown = Reflect.get(env, "OPERATOR_ACCESS_CONFIG");
	if (typeof raw !== "string") throw new TypeError("OPERATOR_ACCESS_CONFIG is not configured");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new TypeError("OPERATOR_ACCESS_CONFIG must be valid JSON");
	}
	return parseAccessAuthConfig(parsed);
}

const ACCESS_JWKS_CACHE_KEY = Symbol.for("emdash-labeler:access-jwks");

export function getAccessKeyResolver(teamDomain: string): AccessKeyResolver {
	const existing: unknown = Reflect.get(globalThis, ACCESS_JWKS_CACHE_KEY);
	const cache: Map<string, AccessKeyResolver> =
		existing instanceof Map ? existing : new Map<string, AccessKeyResolver>();
	if (!(existing instanceof Map)) Reflect.set(globalThis, ACCESS_JWKS_CACHE_KEY, cache);
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
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (!token) throw new AccessAuthError("Access assertion header is missing");
	let payload: Record<string, unknown>;
	try {
		const verified = await jwtVerify(token, keys, {
			algorithms: ["RS256"],
			requiredClaims: ["exp", "sub"],
			issuer: config.teamDomain,
			audience: config.audience,
		});
		payload = verified.payload;
	} catch (cause) {
		throw new AccessAuthError("Access assertion failed verification", { cause });
	}
	const sub = payload["sub"];
	if (typeof sub !== "string") throw new AccessAuthError("Access assertion is missing sub");
	const commonName = payload["common_name"];
	const email = payload["email"];
	let identity: OperatorIdentity;
	if (typeof commonName === "string" && commonName.length > 0) {
		identity = { kind: "service", commonName, sub, roles: [] };
	} else if (typeof email === "string" && email.length > 0 && sub.length > 0) {
		identity = { kind: "human", email, sub, roles: [] };
	} else {
		throw new AccessAuthError("Access assertion has no usable operator identity");
	}
	const principal = identity.kind === "human" ? identity.email : identity.commonName;
	const principals = new Set([
		principal,
		...(identity.kind === "human" ? accessGroups(payload["custom"]) : []),
	]);
	const roles: OperatorRole[] = [];
	if (config.admins.some((value) => principals.has(value))) roles.push("admin");
	if (config.reviewers.some((value) => principals.has(value))) roles.push("reviewer");
	return { ...identity, roles };
}

export function hasOperatorRole(identity: OperatorIdentity, role: OperatorRole): boolean {
	return identity.roles.includes(role) || (role === "reviewer" && identity.roles.includes("admin"));
}

export async function operatorActorDid(identity: OperatorIdentity): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(`${identity.kind}:${identity.sub}`),
		),
	);
	const suffix = Array.from(digest, (value) => value.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 32);
	return `did:web:labels.emdashcms.com:operators:${suffix}`;
}

export async function authenticateOperator(
	request: Request,
	env: object,
): Promise<OperatorIdentity> {
	const config = readAccessAuthConfig(env);
	return verifyAccessRequest(request, config, getAccessKeyResolver(config.teamDomain));
}

export async function requireAccessVerification(request: Request, env: object): Promise<Response> {
	try {
		const identity = await authenticateOperator(request, env);
		if (identity.roles.length === 0) {
			return Response.json(
				{ error: { code: "FORBIDDEN", message: "Operator access is not authorized" } },
				{ status: 403, headers: { "cache-control": "no-store" } },
			);
		}
		return Response.json(
			{ authenticated: true, roles: identity.roles },
			{ headers: { "cache-control": "no-store" } },
		);
	} catch (error) {
		if (!(error instanceof AccessAuthError)) throw error;
		return Response.json(
			{ error: { code: "UNAUTHENTICATED", message: "Operator authentication required" } },
			{ status: 401, headers: { "cache-control": "no-store" } },
		);
	}
}

function parseHttpsOrigin(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Access teamDomain must be an HTTPS origin");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("Access teamDomain must be an HTTPS origin");
	}
	if (url.protocol !== "https:" || url.origin !== value) {
		throw new TypeError("Access teamDomain must be an HTTPS origin");
	}
	return url.origin;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`Access auth config ${field} must be a non-empty string`);
	}
	return value;
}

function stringArray(value: unknown, field: string): string[] {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || item.length === 0)
	) {
		throw new TypeError(`Access auth config ${field} must contain non-empty strings`);
	}
	return [...new Set(value)];
}

function accessGroups(value: unknown): string[] {
	if (!isRecord(value) || !Array.isArray(value["groups"])) return [];
	return value["groups"].filter(
		(group): group is string => typeof group === "string" && group.length > 0,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
