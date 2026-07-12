import {
	base64url,
	createLocalJWKSet,
	decodeProtectedHeader,
	errors,
	importJWK,
	jwtVerify,
	type JSONWebKeySet,
	type JWTPayload,
} from "jose";

import type {
	VerifiedWorkload,
	WorkloadIssuer,
	WorkloadVerificationErrorCode,
	WorkloadVerificationOptions,
	WorkloadVerificationResult,
} from "./types.js";

const ALGORITHM = "RS256";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 100_000;
const DEFAULT_MAX_TOKEN_BYTES = 16_384;
const DEFAULT_MAX_TOKEN_AGE_SECONDS = 600;
const ERROR_MESSAGE = "Workload identity verification failed" as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const DECIMAL_ID_PATTERN = /^[1-9]\d*$/;
const REPOSITORY_PATTERN =
	/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})\/[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REF_PREFIX_PATTERN = /^refs\/(?:heads|tags|pull)\//;
const WORKFLOW_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.ya?ml$/;

interface DiscoveryMetadata {
	issuer: string;
	jwks_uri: string;
	id_token_signing_alg_values_supported: string[];
}

export interface GitHubActionsIssuerOptions {
	issuer: string;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
	maxResponseBytes?: number;
	maxTokenBytes?: number;
	maxTokenAgeSeconds?: number;
}

class VerificationFailure extends Error {
	constructor(readonly code: WorkloadVerificationErrorCode) {
		super(ERROR_MESSAGE);
	}
}

function failure(code: WorkloadVerificationErrorCode): WorkloadVerificationResult {
	return { success: false, error: { code, message: ERROR_MESSAGE } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeText(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 31 || code === 127) return false;
	}
	return true;
}

function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
	return value;
}

function parseTrustedIssuer(value: string): URL {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		value !== url.origin
	) {
		throw new TypeError("issuer must be a canonical HTTPS origin");
	}
	return url;
}

function composeAbortSignal(
	timeoutMs: number,
	externalSignal?: AbortSignal,
): { signal: AbortSignal; cleanup(): void } {
	const controller = new AbortController();
	const abortFromExternal = () => controller.abort(externalSignal?.reason);
	if (externalSignal?.aborted) abortFromExternal();
	else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timeout);
			externalSignal?.removeEventListener("abort", abortFromExternal);
		},
	};
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const declaredLength = response.headers.get("content-length");
	if (declaredLength !== null) {
		const parsedLength = Number(declaredLength);
		if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
			await response.body?.cancel();
			throw new Error("response size invalid");
		}
	}
	if (!response.body) throw new Error("response body missing");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new Error("response too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

function parseDiscovery(value: unknown, issuer: URL): DiscoveryMetadata {
	if (!isRecord(value)) throw new VerificationFailure("WORKLOAD_DISCOVERY_INVALID");
	const metadataIssuer = value["issuer"];
	const jwksUri = value["jwks_uri"];
	const algorithms = value["id_token_signing_alg_values_supported"];
	if (
		metadataIssuer !== issuer.origin ||
		typeof jwksUri !== "string" ||
		!Array.isArray(algorithms) ||
		!algorithms.every((algorithm) => typeof algorithm === "string") ||
		!algorithms.includes(ALGORITHM)
	) {
		throw new VerificationFailure("WORKLOAD_DISCOVERY_INVALID");
	}
	let jwksUrl: URL;
	try {
		jwksUrl = new URL(jwksUri);
	} catch {
		throw new VerificationFailure("WORKLOAD_DISCOVERY_INVALID");
	}
	if (
		jwksUrl.protocol !== "https:" ||
		jwksUrl.origin !== issuer.origin ||
		jwksUrl.username ||
		jwksUrl.password ||
		jwksUrl.hash
	) {
		throw new VerificationFailure("WORKLOAD_DISCOVERY_INVALID");
	}
	return {
		issuer: metadataIssuer,
		jwks_uri: jwksUrl.href,
		id_token_signing_alg_values_supported: algorithms,
	};
}

function decodeRsaInteger(value: string): Uint8Array {
	if (!BASE64URL_PATTERN.test(value)) {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
	let decoded: Uint8Array;
	try {
		decoded = base64url.decode(value);
	} catch {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
	if (decoded.length === 0 || decoded[0] === 0 || base64url.encode(decoded) !== value) {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
	return decoded;
}

function validateRsaMaterial(modulus: string, exponent: string): void {
	const modulusBytes = decodeRsaInteger(modulus);
	if (
		modulusBytes.byteLength < 256 ||
		(modulusBytes.byteLength === 256 && (modulusBytes[0] ?? 0) < 0x80)
	) {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
	const exponentBytes = decodeRsaInteger(exponent);
	if (exponentBytes.byteLength > 4) {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
	let exponentValue = 0;
	for (const byte of exponentBytes) exponentValue = exponentValue * 256 + byte;
	if (exponentValue < 3 || exponentValue % 2 === 0) {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
}

async function parseJwks(value: unknown): Promise<JSONWebKeySet> {
	if (!isRecord(value) || !Array.isArray(value["keys"]) || value["keys"].length === 0) {
		throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
	}
	const keyIds = new Set<string>();
	const keys: JSONWebKeySet["keys"] = [];
	for (const key of value["keys"]) {
		if (
			!isRecord(key) ||
			key["kty"] !== "RSA" ||
			typeof key["kid"] !== "string" ||
			key["kid"].length === 0 ||
			typeof key["n"] !== "string" ||
			typeof key["e"] !== "string" ||
			("alg" in key && key["alg"] !== ALGORITHM) ||
			("use" in key && key["use"] !== "sig") ||
			"d" in key
		) {
			throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
		}
		const keyOperations = key["key_ops"];
		if (
			keyOperations !== undefined &&
			(!Array.isArray(keyOperations) || keyOperations.length !== 1 || keyOperations[0] !== "verify")
		) {
			throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
		}
		if (keyIds.has(key["kid"])) throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
		keyIds.add(key["kid"]);
		validateRsaMaterial(key["n"], key["e"]);
		const validatedKey = {
			kty: "RSA",
			kid: key["kid"],
			n: key["n"],
			e: key["e"],
			alg: ALGORITHM,
			use: "sig",
			...(keyOperations === undefined ? {} : { key_ops: ["verify"] }),
		};
		try {
			await importJWK(validatedKey, ALGORITHM);
		} catch {
			throw new VerificationFailure("WORKLOAD_JWKS_INVALID");
		}
		keys.push(validatedKey);
	}
	return { keys };
}

function isSignatureFailure(error: unknown): boolean {
	return (
		error instanceof errors.JWKSNoMatchingKey ||
		error instanceof errors.JWSSignatureVerificationFailed
	);
}

function classifyJwtError(error: unknown): WorkloadVerificationErrorCode {
	if (error instanceof errors.JWTExpired) return "WORKLOAD_TOKEN_EXPIRED";
	if (error instanceof errors.JWTClaimValidationFailed && error.claim === "nbf") {
		return "WORKLOAD_TOKEN_NOT_ACTIVE";
	}
	if (isSignatureFailure(error)) return "WORKLOAD_TOKEN_SIGNATURE_INVALID";
	return "WORKLOAD_TOKEN_MALFORMED";
}

function requiredString(payload: JWTPayload, claim: string, maxLength = 1024): string {
	const value = payload[claim];
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		!isSafeText(value)
	) {
		throw new VerificationFailure("WORKLOAD_CLAIMS_INVALID");
	}
	return value;
}

function optionalString(payload: JWTPayload, claim: string, maxLength = 255): string | undefined {
	if (payload[claim] === undefined) return undefined;
	return requiredString(payload, claim, maxLength);
}

function canonicalId(payload: JWTPayload, claim: string): string {
	const value = requiredString(payload, claim, 32);
	if (!DECIMAL_ID_PATTERN.test(value)) {
		throw new VerificationFailure("WORKLOAD_CLAIMS_INVALID");
	}
	return value;
}

function validRef(value: string): boolean {
	if (
		value.length > 1024 ||
		!isSafeText(value) ||
		!REF_PREFIX_PATTERN.test(value) ||
		value.includes("..") ||
		value.includes("@{") ||
		value.includes("//") ||
		value.endsWith("/") ||
		value.endsWith(".")
	) {
		return false;
	}
	for (const character of value) {
		if (" ~^:?*[\\".includes(character)) return false;
	}
	return value.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

function validWorkflowRef(value: string, expectedRepository?: string): boolean {
	const marker = "/.github/workflows/";
	const markerIndex = value.indexOf(marker);
	const separatorIndex = value.indexOf("@", markerIndex + marker.length);
	if (markerIndex <= 0 || separatorIndex <= markerIndex + marker.length) return false;
	const repository = value.slice(0, markerIndex);
	const workflowPath = value.slice(markerIndex + marker.length, separatorIndex);
	const workflowVersion = value.slice(separatorIndex + 1);
	return (
		REPOSITORY_PATTERN.test(repository) &&
		(!expectedRepository || repository === expectedRepository) &&
		WORKFLOW_PATH_PATTERN.test(workflowPath) &&
		!workflowPath.split("/").includes("..") &&
		(validRef(workflowVersion) || SHA_PATTERN.test(workflowVersion))
	);
}

function normalizePayload(
	payload: JWTPayload,
	issuer: string,
	expectedAudience: string,
	now: number,
	maxTokenAgeSeconds: number,
): VerifiedWorkload {
	if (payload.iss !== issuer) throw new VerificationFailure("WORKLOAD_TOKEN_ISSUER_INVALID");
	if (payload.aud !== expectedAudience) {
		throw new VerificationFailure("WORKLOAD_TOKEN_AUDIENCE_INVALID");
	}
	const expiresAt = payload.exp;
	if (!Number.isSafeInteger(expiresAt)) {
		throw new VerificationFailure("WORKLOAD_CLAIMS_INVALID");
	}
	if (expiresAt === undefined || expiresAt <= now) {
		throw new VerificationFailure("WORKLOAD_TOKEN_EXPIRED");
	}
	if (payload.nbf !== undefined && !Number.isSafeInteger(payload.nbf)) {
		throw new VerificationFailure("WORKLOAD_CLAIMS_INVALID");
	}
	if (payload.nbf !== undefined && payload.nbf > now) {
		throw new VerificationFailure("WORKLOAD_TOKEN_NOT_ACTIVE");
	}
	const issuedAt = payload.iat;
	if (
		!Number.isSafeInteger(issuedAt) ||
		issuedAt === undefined ||
		issuedAt > now ||
		issuedAt < now - maxTokenAgeSeconds
	) {
		throw new VerificationFailure("WORKLOAD_TOKEN_IAT_INVALID");
	}
	const repository = requiredString(payload, "repository", 201);
	if (!REPOSITORY_PATTERN.test(repository)) {
		throw new VerificationFailure("WORKLOAD_CLAIMS_INVALID");
	}
	const workflowRef = requiredString(payload, "workflow_ref", 1024);
	const jobWorkflowRef = optionalString(payload, "job_workflow_ref", 1024);
	const environment = optionalString(payload, "environment");
	const ref = requiredString(payload, "ref", 1024);
	const sha = requiredString(payload, "sha", 40);
	if (
		!validWorkflowRef(workflowRef, repository) ||
		(jobWorkflowRef !== undefined && !validWorkflowRef(jobWorkflowRef)) ||
		!validRef(ref) ||
		!SHA_PATTERN.test(sha)
	) {
		throw new VerificationFailure("WORKLOAD_CLAIMS_INVALID");
	}
	return {
		issuer,
		subject: requiredString(payload, "sub"),
		repository,
		repositoryId: canonicalId(payload, "repository_id"),
		repositoryOwnerId: canonicalId(payload, "repository_owner_id"),
		workflowRef,
		...(jobWorkflowRef === undefined ? {} : { jobWorkflowRef }),
		ref,
		sha,
		runId: canonicalId(payload, "run_id"),
		runAttempt: canonicalId(payload, "run_attempt"),
		...(environment === undefined ? {} : { environment }),
		expiresAt,
	};
}

export class GitHubActionsIssuer implements WorkloadIssuer {
	readonly #issuer: URL;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #maxTokenBytes: number;
	readonly #maxTokenAgeSeconds: number;

	constructor(options: GitHubActionsIssuerOptions) {
		this.#issuer = parseTrustedIssuer(options.issuer);
		const transport = options.fetch ?? fetch;
		this.#fetch = (input, init) => transport(input, init);
		this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
		this.#timeoutMs = requirePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
		this.#maxResponseBytes = requirePositiveInteger(
			options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
			"maxResponseBytes",
		);
		this.#maxTokenBytes = requirePositiveInteger(
			options.maxTokenBytes ?? DEFAULT_MAX_TOKEN_BYTES,
			"maxTokenBytes",
		);
		this.#maxTokenAgeSeconds = requirePositiveInteger(
			options.maxTokenAgeSeconds ?? DEFAULT_MAX_TOKEN_AGE_SECONDS,
			"maxTokenAgeSeconds",
		);
	}

	async verify(
		token: string,
		expectedAudience: string,
		options: WorkloadVerificationOptions = {},
	): Promise<WorkloadVerificationResult> {
		if (
			typeof token !== "string" ||
			token.length === 0 ||
			token.length > this.#maxTokenBytes ||
			typeof expectedAudience !== "string"
		) {
			return failure("WORKLOAD_TOKEN_MALFORMED");
		}
		if (expectedAudience.length === 0 || !isSafeText(expectedAudience)) {
			return failure("WORKLOAD_TOKEN_AUDIENCE_INVALID");
		}
		try {
			const header = decodeProtectedHeader(token);
			if (header.alg !== ALGORITHM) return failure("WORKLOAD_TOKEN_UNSUPPORTED_ALGORITHM");
			if (typeof header.kid !== "string" || header.kid.length === 0) {
				return failure("WORKLOAD_TOKEN_MALFORMED");
			}
		} catch {
			return failure("WORKLOAD_TOKEN_MALFORMED");
		}

		const abort = composeAbortSignal(this.#timeoutMs, options.signal);
		try {
			if (abort.signal.aborted) throw new VerificationFailure("WORKLOAD_ISSUER_UNAVAILABLE");
			const metadata = await this.#fetchJson(
				new URL("/.well-known/openid-configuration", this.#issuer),
				abort.signal,
				"WORKLOAD_DISCOVERY_INVALID",
			);
			const discovery = parseDiscovery(metadata, this.#issuer);
			let jwks = await this.#fetchJwks(discovery.jwks_uri, abort.signal);
			let payload: JWTPayload;
			try {
				payload = await this.#verifySignature(token, jwks);
			} catch (error) {
				if (!isSignatureFailure(error)) throw error;
				jwks = await this.#fetchJwks(discovery.jwks_uri, abort.signal);
				try {
					payload = await this.#verifySignature(token, jwks);
				} catch (retryError) {
					if (isSignatureFailure(retryError)) {
						throw new VerificationFailure("WORKLOAD_TOKEN_SIGNATURE_INVALID");
					}
					throw retryError;
				}
			}
			if (abort.signal.aborted) {
				throw new VerificationFailure("WORKLOAD_ISSUER_UNAVAILABLE");
			}
			const workload = normalizePayload(
				payload,
				this.#issuer.origin,
				expectedAudience,
				this.#now(),
				this.#maxTokenAgeSeconds,
			);
			if (abort.signal.aborted) {
				throw new VerificationFailure("WORKLOAD_ISSUER_UNAVAILABLE");
			}
			return {
				success: true,
				workload,
			};
		} catch (error) {
			if (error instanceof VerificationFailure) return failure(error.code);
			if (abort.signal.aborted) return failure("WORKLOAD_ISSUER_UNAVAILABLE");
			return failure(classifyJwtError(error));
		} finally {
			abort.cleanup();
		}
	}

	async #verifySignature(token: string, jwks: JSONWebKeySet): Promise<JWTPayload> {
		const result = await jwtVerify(token, createLocalJWKSet(jwks), {
			algorithms: [ALGORITHM],
			currentDate: new Date(this.#now() * 1000),
			clockTolerance: 0,
		});
		return result.payload;
	}

	async #fetchJwks(url: string, signal: AbortSignal): Promise<JSONWebKeySet> {
		const value = await this.#fetchJson(new URL(url), signal, "WORKLOAD_JWKS_INVALID");
		return await parseJwks(value);
	}

	async #fetchJson(
		url: URL,
		signal: AbortSignal,
		invalidCode: "WORKLOAD_DISCOVERY_INVALID" | "WORKLOAD_JWKS_INVALID",
	): Promise<unknown> {
		let response: Response;
		try {
			response = await this.#fetch(url.href, {
				method: "GET",
				headers: { accept: "application/json" },
				redirect: "manual",
				signal,
			});
		} catch {
			throw new VerificationFailure("WORKLOAD_ISSUER_UNAVAILABLE");
		}
		try {
			if (!response.ok) {
				await response.body?.cancel();
				throw new VerificationFailure(invalidCode);
			}
			return await readBoundedJson(response, this.#maxResponseBytes);
		} catch (error) {
			if (signal.aborted) throw new VerificationFailure("WORKLOAD_ISSUER_UNAVAILABLE");
			if (error instanceof VerificationFailure) throw error;
			throw new VerificationFailure(invalidCode);
		}
	}
}
