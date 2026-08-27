import {
	Keyset,
	type ClientAssertionPrivateJwk,
	type ConfidentialClientMetadata,
} from "@atcute/oauth-node-client";
import { getDelegatedReleasePermission } from "@emdash-cms/registry-lexicons";

import { createEnvelopeEncryption, type EnvelopeEncryption } from "./crypto/encryption.js";

export type ConfigurationBindings = Record<
	keyof Pick<
		Env,
		| "PUBLIC_ORIGIN"
		| "DEPLOYMENT_ID"
		| "OAUTH_REDIRECT_URIS"
		| "OAUTH_ASSERTION_KEYSET"
		| "ENCRYPTION_KEYRING"
	>,
	string
>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_ASSERTION_KEYSET_CHARS = 64 * 1024;
const MAX_ASSERTION_KEYS = 8;
const CONFIGURATION_CACHE_SYMBOL = Symbol.for("@emdash-cms/release-service/configuration-cache");
const CONFIGURATION_BINDING_KEYS = [
	"PUBLIC_ORIGIN",
	"DEPLOYMENT_ID",
	"OAUTH_REDIRECT_URIS",
	"OAUTH_ASSERTION_KEYSET",
	"ENCRYPTION_KEYRING",
] as const satisfies readonly (keyof ConfigurationBindings)[];

interface ConfigurationCacheEntry {
	snapshot: readonly string[];
	promise: Promise<ServiceConfiguration>;
}

export interface ServiceConfiguration {
	publicOrigin: string;
	deploymentId: string;
	oauth: OAuthConfiguration;
	encryption: EnvelopeEncryption;
}

export type P256AssertionPrivateJwk = ClientAssertionPrivateJwk & {
	kty: "EC";
	crv: "P-256";
	x: string;
	y: string;
	d: string;
	alg: "ES256";
	use: "sig";
};

export interface OAuthConfiguration {
	clientMetadata: ConfidentialClientMetadata & { client_uri: string };
	releaseNsid: string;
	releaseScope: string;
	activeAssertionKeyId: string;
	assertionKeys: readonly P256AssertionPrivateJwk[];
	keyset: Keyset;
	hasAssertionKey(keyId: string): boolean;
}

export class ConfigurationError extends Error {
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super("Invalid release-service configuration");
		this.name = "ConfigurationError";
		this.issues = issues;
	}
}

function parseOrigin(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.origin !== value) return null;
		return url.origin;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(record);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isBase64UrlBytes(value: unknown, byteLength: number): value is string {
	if (typeof value !== "string" || !BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
		return false;
	}
	try {
		const binary = atob(
			value
				.replaceAll("-", "+")
				.replaceAll("_", "/")
				.padEnd(value.length + ((4 - (value.length % 4)) % 4), "="),
		);
		return binary.length === byteLength;
	} catch {
		return false;
	}
}

function parseRedirectUris(value: string, publicOrigin: string): readonly [string] | null {
	try {
		const parsed: unknown = JSON.parse(value);
		const expected = `${publicOrigin}/oauth/callback`;
		return Array.isArray(parsed) && parsed.length === 1 && parsed[0] === expected
			? [expected]
			: null;
	} catch {
		return null;
	}
}

async function parseAssertionKeyset(value: string): Promise<{
	active: string;
	keys: readonly P256AssertionPrivateJwk[];
	keyset: Keyset;
} | null> {
	try {
		if (value.length === 0 || value.length > MAX_ASSERTION_KEYSET_CHARS) return null;
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed) || !hasExactKeys(parsed, ["active", "keys"])) return null;
		if (
			typeof parsed["active"] !== "string" ||
			!Array.isArray(parsed["keys"]) ||
			parsed["keys"].length === 0 ||
			parsed["keys"].length > MAX_ASSERTION_KEYS
		) {
			return null;
		}
		const keys: P256AssertionPrivateJwk[] = [];
		const keyIds = new Set<string>();
		for (const entry of parsed["keys"]) {
			if (
				!isRecord(entry) ||
				!hasExactKeys(entry, ["kty", "crv", "x", "y", "d", "kid", "alg", "use"]) ||
				entry["kty"] !== "EC" ||
				entry["crv"] !== "P-256" ||
				entry["alg"] !== "ES256" ||
				entry["use"] !== "sig" ||
				typeof entry["kid"] !== "string" ||
				entry["kid"].length === 0 ||
				entry["kid"].length > 128 ||
				keyIds.has(entry["kid"]) ||
				!isBase64UrlBytes(entry["x"], 32) ||
				!isBase64UrlBytes(entry["y"], 32) ||
				!isBase64UrlBytes(entry["d"], 32)
			) {
				return null;
			}
			const key: P256AssertionPrivateJwk = {
				kty: "EC",
				crv: "P-256",
				x: entry["x"],
				y: entry["y"],
				d: entry["d"],
				kid: entry["kid"],
				alg: "ES256",
				use: "sig",
			};
			const algorithm = { name: "ECDSA", namedCurve: "P-256" };
			const privateKey = await crypto.subtle.importKey("jwk", key, algorithm, false, ["sign"]);
			const publicKey = await crypto.subtle.importKey(
				"jwk",
				{ kty: key.kty, crv: key.crv, x: key.x, y: key.y },
				algorithm,
				false,
				["verify"],
			);
			const challenge = new TextEncoder().encode("emdash-oauth-assertion-key-validation");
			const signature = await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				privateKey,
				challenge,
			);
			if (
				!(await crypto.subtle.verify(
					{ name: "ECDSA", hash: "SHA-256" },
					publicKey,
					signature,
					challenge,
				))
			) {
				return null;
			}
			keys.push(key);
			keyIds.add(key.kid);
		}
		if (!keyIds.has(parsed["active"])) return null;
		keys.sort(
			(left, right) =>
				Number(right.kid === parsed["active"]) - Number(left.kid === parsed["active"]),
		);
		return { active: parsed["active"], keys, keyset: new Keyset(keys) };
	} catch {
		return null;
	}
}

async function parseConfiguration(bindings: ConfigurationBindings): Promise<ServiceConfiguration> {
	const issues: string[] = [];
	const publicOrigin = parseOrigin(bindings.PUBLIC_ORIGIN);
	if (!publicOrigin) issues.push("PUBLIC_ORIGIN_INVALID");
	const deploymentId = DEPLOYMENT_ID_PATTERN.test(bindings.DEPLOYMENT_ID)
		? bindings.DEPLOYMENT_ID
		: null;
	if (!deploymentId) issues.push("DEPLOYMENT_ID_INVALID");
	const redirectUris = publicOrigin
		? parseRedirectUris(bindings.OAUTH_REDIRECT_URIS, publicOrigin)
		: null;
	if (!redirectUris) issues.push("OAUTH_REDIRECT_URIS_INVALID");
	const assertionKeyset = await parseAssertionKeyset(bindings.OAUTH_ASSERTION_KEYSET);
	if (!assertionKeyset) issues.push("OAUTH_ASSERTION_KEYSET_INVALID");
	if (!publicOrigin || !deploymentId || !redirectUris || !assertionKeyset || issues.length > 0) {
		throw new ConfigurationError(issues);
	}
	let encryption: EnvelopeEncryption;
	try {
		encryption = createEnvelopeEncryption(bindings.ENCRYPTION_KEYRING, deploymentId);
	} catch {
		throw new ConfigurationError(["ENCRYPTION_KEYRING_INVALID"]);
	}
	const permission = getDelegatedReleasePermission();
	const clientMetadata: OAuthConfiguration["clientMetadata"] = {
		client_id: `${publicOrigin}/.well-known/atproto-client-metadata.json`,
		client_name: "EmDash delegated release service",
		client_uri: publicOrigin,
		application_type: "web",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		redirect_uris: [...redirectUris],
		scope: permission.scope,
		jwks_uri: `${publicOrigin}/oauth/jwks.json`,
		dpop_bound_access_tokens: true,
		token_endpoint_auth_method: "private_key_jwt",
		token_endpoint_auth_signing_alg: "ES256",
	};
	return {
		publicOrigin,
		deploymentId,
		encryption,
		oauth: {
			clientMetadata,
			releaseNsid: permission.collection,
			releaseScope: permission.scope,
			activeAssertionKeyId: assertionKeyset.active,
			assertionKeys: assertionKeyset.keys,
			keyset: assertionKeyset.keyset,
			hasAssertionKey: (keyId) => assertionKeyset.keys.some((key) => key.kid === keyId),
		},
	};
}

function getConfigurationCache(): WeakMap<object, ConfigurationCacheEntry> {
	const target = globalThis as typeof globalThis & {
		[CONFIGURATION_CACHE_SYMBOL]?: WeakMap<object, ConfigurationCacheEntry>;
	};
	return (target[CONFIGURATION_CACHE_SYMBOL] ??= new WeakMap());
}

export async function loadConfiguration(
	bindings: ConfigurationBindings,
): Promise<ServiceConfiguration> {
	const snapshot = CONFIGURATION_BINDING_KEYS.map((key) => bindings[key]);
	const cache = getConfigurationCache();
	const cached = cache.get(bindings);
	let promise = cached?.snapshot.every((value, index) => value === snapshot[index])
		? cached.promise
		: null;
	if (!promise) {
		promise = parseConfiguration(bindings);
		cache.set(bindings, { snapshot, promise });
	}
	return promise;
}
