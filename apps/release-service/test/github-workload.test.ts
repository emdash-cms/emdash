import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
	GitHubActionsIssuer,
	type GitHubActionsIssuerOptions,
} from "../src/workload/github-actions.js";
import type {
	VerifiedWorkload,
	WorkloadMatcher,
	WorkloadVerificationErrorCode,
} from "../src/workload/types.js";

const ISSUER = "https://token.actions.example.invalid";
const AUDIENCE = "https://release.example.invalid";
const NOW = 2_000_000_000;
const GENERIC_MESSAGE = "Workload identity verification failed";

let signingKey: CryptoKey;
let rotatedSigningKey: CryptoKey;
let jwk: Record<string, unknown>;
let rotatedJwk: Record<string, unknown>;

const BASE_CLAIMS = {
	iss: ISSUER,
	aud: AUDIENCE,
	sub: "repo:emdash-cms/emdash:ref:refs/heads/main",
	exp: NOW + 300,
	nbf: NOW - 10,
	iat: NOW - 10,
	repository: "emdash-cms/emdash",
	repository_id: "123456789",
	repository_owner_id: "987654321",
	workflow_ref: "emdash-cms/emdash/.github/workflows/release.yml@refs/heads/main",
	ref: "refs/heads/main",
	sha: "0123456789abcdef0123456789abcdef01234567",
	run_id: "1122334455",
	run_attempt: "2",
} as const;

beforeAll(async () => {
	const current = await generateKeyPair("RS256");
	const rotated = await generateKeyPair("RS256");
	signingKey = current.privateKey;
	rotatedSigningKey = rotated.privateKey;
	jwk = { ...(await exportJWK(current.publicKey)), kid: "current", use: "sig", alg: "RS256" };
	rotatedJwk = {
		...(await exportJWK(rotated.publicKey)),
		kid: "rotated",
		use: "sig",
		alg: "RS256",
	};
});

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	const headers = new Headers(init?.headers);
	headers.set("content-type", "application/json");
	return new Response(JSON.stringify(value), {
		...init,
		headers,
	});
}

function discovery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		issuer: ISSUER,
		jwks_uri: `${ISSUER}/.well-known/jwks`,
		id_token_signing_alg_values_supported: ["RS256"],
		...overrides,
	};
}

function createFetch(
	options: {
		metadata?: unknown;
		jwks?: unknown;
		metadataResponse?: Response;
		jwksResponse?: Response;
	} = {},
): { fetch: typeof fetch; calls: Request[] } {
	const calls: Request[] = [];
	let jwksCall = 0;
	const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		calls.push(request);
		if (request.url.endsWith("/.well-known/openid-configuration")) {
			return options.metadataResponse ?? jsonResponse(options.metadata ?? discovery());
		}
		const configured = options.jwks ?? { keys: [jwk] };
		const value = Array.isArray(configured)
			? configured[Math.min(jwksCall++, configured.length - 1)]
			: configured;
		return options.jwksResponse ?? jsonResponse(value);
	});
	return { fetch: transport as typeof fetch, calls };
}

function createIssuer(
	transport = createFetch().fetch,
	overrides: Partial<GitHubActionsIssuerOptions> = {},
): GitHubActionsIssuer {
	return new GitHubActionsIssuer({
		issuer: ISSUER,
		fetch: transport,
		now: () => NOW,
		timeoutMs: 100,
		...overrides,
	});
}

async function sign(
	claims: Record<string, unknown> = {},
	options: { key?: CryptoKey; kid?: string; alg?: string } = {},
): Promise<string> {
	return new SignJWT({ ...BASE_CLAIMS, ...claims })
		.setProtectedHeader({ alg: options.alg ?? "RS256", kid: options.kid ?? "current", typ: "JWT" })
		.sign(options.key ?? signingKey);
}

async function expectFailure(
	promise: Promise<Awaited<ReturnType<GitHubActionsIssuer["verify"]>>>,
	code: WorkloadVerificationErrorCode,
): Promise<void> {
	const result = await promise;
	expect(result).toEqual({ success: false, error: { code, message: GENERIC_MESSAGE } });
	expect(JSON.stringify(result)).not.toContain(BASE_CLAIMS.repository);
}

describe("issuer-neutral workload contract", () => {
	it("supports a non-persistent matcher without issuer-specific policy types", () => {
		const matcher: WorkloadMatcher<{ repositoryId: string }> = {
			matches(workload, policy) {
				return workload.repositoryId === policy.repositoryId;
			},
		};
		const workload = {
			issuer: ISSUER,
			subject: BASE_CLAIMS.sub,
			repository: BASE_CLAIMS.repository,
			repositoryId: BASE_CLAIMS.repository_id,
			repositoryOwnerId: BASE_CLAIMS.repository_owner_id,
			workflowRef: BASE_CLAIMS.workflow_ref,
			ref: BASE_CLAIMS.ref,
			sha: BASE_CLAIMS.sha,
			runId: BASE_CLAIMS.run_id,
			runAttempt: BASE_CLAIMS.run_attempt,
			expiresAt: BASE_CLAIMS.exp,
		} satisfies VerifiedWorkload;
		expect(matcher.matches(workload, { repositoryId: "123456789" })).toBe(true);
	});
});

describe("GitHub Actions workload verification", () => {
	it("returns only normalized verified claims", async () => {
		const token = await sign({
			job_workflow_ref:
				"emdash-cms/automation/.github/workflows/publish.yml@0123456789abcdef0123456789abcdef01234567",
			environment: "production",
			actor: "untrusted-display-name",
			jti: "never-persist-this",
		});
		const result = await createIssuer().verify(token, AUDIENCE);
		expect(result).toEqual({
			success: true,
			workload: {
				issuer: ISSUER,
				subject: BASE_CLAIMS.sub,
				repository: BASE_CLAIMS.repository,
				repositoryId: BASE_CLAIMS.repository_id,
				repositoryOwnerId: BASE_CLAIMS.repository_owner_id,
				workflowRef: BASE_CLAIMS.workflow_ref,
				jobWorkflowRef:
					"emdash-cms/automation/.github/workflows/publish.yml@0123456789abcdef0123456789abcdef01234567",
				ref: BASE_CLAIMS.ref,
				sha: BASE_CLAIMS.sha,
				runId: BASE_CLAIMS.run_id,
				runAttempt: BASE_CLAIMS.run_attempt,
				environment: "production",
				expiresAt: BASE_CLAIMS.exp,
			},
		});
		expect(JSON.stringify(result)).not.toContain(token);
		expect(JSON.stringify(result)).not.toContain("untrusted-display-name");
	});

	it("accepts absent optional claims", async () => {
		const result = await createIssuer().verify(await sign(), AUDIENCE);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.workload).not.toHaveProperty("jobWorkflowRef");
			expect(result.workload).not.toHaveProperty("environment");
		}
	});

	it("accepts canonical Git refs with valid punctuation", async () => {
		const ref = "refs/heads/release+candidate@v2";
		const result = await createIssuer().verify(
			await sign({
				ref,
				workflow_ref: `emdash-cms/emdash/.github/workflows/release.yml@${ref}`,
			}),
			AUDIENCE,
		);
		expect(result.success).toBe(true);
	});

	it.each(["not-a-jwt", "a.b", "a.b.c.d"])("rejects malformed token %s", async (token) => {
		await expectFailure(createIssuer().verify(token, AUDIENCE), "WORKLOAD_TOKEN_MALFORMED");
	});

	it("rejects an oversized token before making network requests", async () => {
		const { fetch, calls } = createFetch();
		await expectFailure(
			createIssuer(fetch, { maxTokenBytes: 100 }).verify("a".repeat(101), AUDIENCE),
			"WORKLOAD_TOKEN_MALFORMED",
		);
		expect(calls).toHaveLength(0);
	});

	it("rejects an empty expected audience before making network requests", async () => {
		const { fetch, calls } = createFetch();
		await expectFailure(
			createIssuer(fetch).verify(await sign(), ""),
			"WORKLOAD_TOKEN_AUDIENCE_INVALID",
		);
		expect(calls).toHaveLength(0);
	});

	it.each([
		["none", "eyJhbGciOiJub25lIiwia2lkIjoiY3VycmVudCJ9.e30."],
		["HS256", null],
	])("rejects unsupported %s tokens", async (algorithm, staticToken) => {
		const token =
			staticToken ??
			(await new SignJWT(BASE_CLAIMS)
				.setProtectedHeader({ alg: "HS256", kid: "current" })
				.sign(new TextEncoder().encode("not-a-public-key")));
		await expectFailure(
			createIssuer().verify(token, AUDIENCE),
			"WORKLOAD_TOKEN_UNSUPPORTED_ALGORITHM",
		);
	});

	it("rejects malformed protected headers", async () => {
		const token = await new SignJWT(BASE_CLAIMS)
			.setProtectedHeader({ alg: "RS256" })
			.sign(signingKey);
		await expectFailure(createIssuer().verify(token, AUDIENCE), "WORKLOAD_TOKEN_MALFORMED");
	});

	it("rejects a bad signature", async () => {
		const token = await sign({}, { key: rotatedSigningKey });
		await expectFailure(createIssuer().verify(token, AUDIENCE), "WORKLOAD_TOKEN_SIGNATURE_INVALID");
	});

	it("rejects the wrong issuer", async () => {
		await expectFailure(
			createIssuer().verify(await sign({ iss: `${ISSUER}/lookalike` }), AUDIENCE),
			"WORKLOAD_TOKEN_ISSUER_INVALID",
		);
	});

	it.each([
		"https://other.example.invalid",
		[AUDIENCE],
		[AUDIENCE, "https://other.example.invalid"],
	])("rejects a wrong or ambiguous audience", async (aud) => {
		await expectFailure(
			createIssuer().verify(await sign({ aud }), AUDIENCE),
			"WORKLOAD_TOKEN_AUDIENCE_INVALID",
		);
	});

	it.each([
		["expired", { exp: NOW - 1 }, "WORKLOAD_TOKEN_EXPIRED"],
		["early", { nbf: NOW + 1 }, "WORKLOAD_TOKEN_NOT_ACTIVE"],
		["stale", { iat: NOW - 601 }, "WORKLOAD_TOKEN_IAT_INVALID"],
		["future", { iat: NOW + 1 }, "WORKLOAD_TOKEN_IAT_INVALID"],
		["missing exp", { exp: undefined }, "WORKLOAD_CLAIMS_INVALID"],
		["fractional exp", { exp: NOW + 0.5 }, "WORKLOAD_CLAIMS_INVALID"],
	] as const)("rejects %s token times", async (_name, claims, code) => {
		await expectFailure(createIssuer().verify(await sign(claims), AUDIENCE), code);
	});

	it.each(["repository_id", "repository_owner_id", "run_id", "run_attempt"])(
		"requires canonical decimal string %s",
		async (claim) => {
			for (const value of [123, "01", "+1", "1.0", "0", "9007199254740993.0"]) {
				await expectFailure(
					createIssuer().verify(await sign({ [claim]: value }), AUDIENCE),
					"WORKLOAD_CLAIMS_INVALID",
				);
			}
		},
	);

	it.each([
		["repository", "owner only"],
		["repository", "owner/repo/extra"],
		["ref", "main"],
		["ref", "refs/heads/../main"],
		["sha", "ABCDEF6789abcdef0123456789abcdef01234567"],
		["sha", "deadbeef"],
		["workflow_ref", "emdash-cms/emdash/.github/workflows/release.yml"],
		["workflow_ref", "other/repo/.github/workflows/release.yml@refs/heads/main"],
		["workflow_ref", "emdash-cms/emdash/.github/workflows/../release.yml@refs/heads/main"],
		["job_workflow_ref", "not-a-workflow"],
		["environment", ""],
		["environment", "production\nforged"],
	])("rejects malformed %s", async (claim, value) => {
		await expectFailure(
			createIssuer().verify(await sign({ [claim]: value }), AUDIENCE),
			"WORKLOAD_CLAIMS_INVALID",
		);
	});

	it("rejects missing required claims", async () => {
		for (const claim of [
			"sub",
			"repository",
			"repository_id",
			"repository_owner_id",
			"workflow_ref",
			"ref",
			"sha",
			"run_id",
			"run_attempt",
		]) {
			await expectFailure(
				createIssuer().verify(await sign({ [claim]: undefined }), AUDIENCE),
				"WORKLOAD_CLAIMS_INVALID",
			);
		}
	});
});

describe("GitHub issuer metadata and transport", () => {
	it("treats the configured issuer as the discovery trust anchor", async () => {
		const { fetch, calls } = createFetch();
		const result = await createIssuer(fetch).verify(await sign(), AUDIENCE);
		expect(calls[0]?.url).toBe(`${ISSUER}/.well-known/openid-configuration`);
		expect(calls.every((request) => request.redirect === "manual")).toBe(true);
		expect(result.success).toBe(true);
	});

	it.each([
		["issuer mismatch", discovery({ issuer: `${ISSUER}/other` })],
		["missing signing algorithm", discovery({ id_token_signing_alg_values_supported: ["ES256"] })],
		["HTTP JWKS", discovery({ jwks_uri: "http://token.actions.example.invalid/keys" })],
		["cross-origin JWKS", discovery({ jwks_uri: "https://attacker.invalid/keys" })],
		[
			"credentialed JWKS",
			discovery({ jwks_uri: "https://user@token.actions.example.invalid/keys" }),
		],
	])("rejects unsafe discovery: %s", async (_name, metadata) => {
		await expectFailure(
			createIssuer(createFetch({ metadata }).fetch).verify(await sign(), AUDIENCE),
			"WORKLOAD_DISCOVERY_INVALID",
		);
	});

	it.each([
		["malformed metadata", jsonResponse("not-an-object")],
		["invalid metadata JSON", new Response("{")],
		["redirect", new Response(null, { status: 302, headers: { location: `${ISSUER}/other` } })],
		["server error", new Response(null, { status: 503 })],
	])("rejects %s without following it", async (_name, metadataResponse) => {
		await expectFailure(
			createIssuer(createFetch({ metadataResponse }).fetch).verify(await sign(), AUDIENCE),
			"WORKLOAD_DISCOVERY_INVALID",
		);
	});

	it("rejects a JWKS redirect without following it", async () => {
		const redirect = new Response(null, {
			status: 302,
			headers: { location: "https://attacker.invalid/keys" },
		});
		const { fetch, calls } = createFetch({ jwksResponse: redirect });
		await expectFailure(
			createIssuer(fetch).verify(await sign(), AUDIENCE),
			"WORKLOAD_JWKS_INVALID",
		);
		expect(calls).toHaveLength(2);
	});

	it.each([
		["missing keys", {}],
		["non-array keys", { keys: "invalid" }],
		["symmetric key", { keys: [{ kty: "oct", k: "c2VjcmV0", kid: "current" }] }],
	])("rejects malformed JWKS: %s", async (_name, keys) => {
		await expectFailure(
			createIssuer(createFetch({ jwks: keys }).fetch).verify(await sign(), AUDIENCE),
			"WORKLOAD_JWKS_INVALID",
		);
	});

	it.each([
		["non-verification", ["encrypt"]],
		["mixed", ["verify", "sign"]],
		["duplicate", ["verify", "verify"]],
		["malformed", ["verify", 1]],
	])("rejects %s key operations", async (_name, keyOperations) => {
		const keys = { keys: [{ ...jwk, key_ops: keyOperations }] };
		await expectFailure(
			createIssuer(createFetch({ jwks: keys }).fetch).verify(await sign(), AUDIENCE),
			"WORKLOAD_JWKS_INVALID",
		);
	});

	it("accepts an explicit verify-only key operation", async () => {
		const result = await createIssuer(
			createFetch({ jwks: { keys: [{ ...jwk, key_ops: ["verify"] }] } }).fetch,
		).verify(await sign(), AUDIENCE);
		expect(result.success).toBe(true);
	});

	it.each([
		["invalid modulus encoding", { n: "not+base64url" }],
		["invalid exponent encoding", { e: "not+base64url" }],
		["unusable exponent", { e: "AQ" }],
		["unacceptable key material", { n: "AQ" }],
	])("classifies %s as invalid JWKS", async (_name, overrides) => {
		const invalidKey = { ...jwk, ...overrides };
		await expectFailure(
			createIssuer(createFetch({ jwks: { keys: [invalidKey] } }).fetch).verify(
				await sign(),
				AUDIENCE,
			),
			"WORKLOAD_JWKS_INVALID",
		);
	});

	it("rejects an RSA modulus shorter than 2048 significant bits", async () => {
		const modulus = base64url.decode(jwk["n"] as string);
		modulus[0] = 1;
		const invalidKey = { ...jwk, n: base64url.encode(modulus) };
		await expectFailure(
			createIssuer(createFetch({ jwks: { keys: [invalidKey] } }).fetch).verify(
				await sign(),
				AUDIENCE,
			),
			"WORKLOAD_JWKS_INVALID",
		);
	});

	it("rejects duplicate JWKS key IDs", async () => {
		const keys = { keys: [jwk, { ...rotatedJwk, kid: "current" }] };
		await expectFailure(
			createIssuer(createFetch({ jwks: keys }).fetch).verify(await sign(), AUDIENCE),
			"WORKLOAD_JWKS_INVALID",
		);
	});

	it.each(["metadata", "JWKS"])("rejects oversized %s by declared length", async (resource) => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{}"));
			},
			cancel() {
				cancelled = true;
			},
		});
		const oversized = new Response(body, {
			headers: { "content-length": "100001", "content-type": "application/json" },
		});
		const transport = createFetch(
			resource === "metadata" ? { metadataResponse: oversized } : { jwksResponse: oversized },
		).fetch;
		await expectFailure(
			createIssuer(transport, { maxResponseBytes: 100_000 }).verify(await sign(), AUDIENCE),
			resource === "metadata" ? "WORKLOAD_DISCOVERY_INVALID" : "WORKLOAD_JWKS_INVALID",
		);
		expect(cancelled).toBe(true);
	});

	it("rejects oversized streamed metadata and cancels the body", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(60));
				controller.enqueue(new Uint8Array(60));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expectFailure(
			createIssuer(createFetch({ metadataResponse: new Response(body) }).fetch, {
				maxResponseBytes: 100,
			}).verify(await sign(), AUDIENCE),
			"WORKLOAD_DISCOVERY_INVALID",
		);
		expect(cancelled).toBe(true);
	});

	it("rejects oversized streamed JWKS and cancels the body", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(200));
				controller.enqueue(new Uint8Array(200));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expectFailure(
			createIssuer(createFetch({ jwksResponse: new Response(body) }).fetch, {
				maxResponseBytes: 300,
			}).verify(await sign(), AUDIENCE),
			"WORKLOAD_JWKS_INVALID",
		);
		expect(cancelled).toBe(true);
	});

	it("times out stalled transport and aborts the request", async () => {
		let observedAbort = false;
		const stalled = ((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			})) as typeof fetch;
		await expectFailure(
			createIssuer(stalled, { timeoutMs: 10 }).verify(await sign(), AUDIENCE),
			"WORKLOAD_ISSUER_UNAVAILABLE",
		);
		expect(observedAbort).toBe(true);
	});

	it("applies the same total timeout while reading a stalled body", async () => {
		let observedAbort = false;
		const transport = ((_input: RequestInfo | URL, init?: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener(
						"abort",
						() => {
							observedAbort = true;
							controller.error(init.signal?.reason);
						},
						{ once: true },
					);
				},
			});
			return Promise.resolve(new Response(body));
		}) as typeof fetch;
		await expectFailure(
			createIssuer(transport, { timeoutMs: 10 }).verify(await sign(), AUDIENCE),
			"WORKLOAD_ISSUER_UNAVAILABLE",
		);
		expect(observedAbort).toBe(true);
	});

	it("maps transport failures to a stable unavailable error", async () => {
		const transport = (() => Promise.reject(new Error("DNS resolver detail"))) as typeof fetch;
		await expectFailure(
			createIssuer(transport).verify(await sign(), AUDIENCE),
			"WORKLOAD_ISSUER_UNAVAILABLE",
		);
	});

	it("composes caller abort and removes listeners after success", async () => {
		const controller = new AbortController();
		const addListener = vi.spyOn(controller.signal, "addEventListener");
		const removeListener = vi.spyOn(controller.signal, "removeEventListener");
		const { fetch } = createFetch();
		const issuer = createIssuer(fetch);
		const result = await issuer.verify(await sign(), AUDIENCE, { signal: controller.signal });
		expect(result.success).toBe(true);
		expect(addListener).toHaveBeenCalledTimes(1);
		expect(removeListener).toHaveBeenCalledTimes(1);
		controller.abort(new Error("late abort must be detached"));
		expect(result.success).toBe(true);
	});

	it("returns a generic unavailable error for caller abort", async () => {
		const controller = new AbortController();
		controller.abort(new Error("sensitive caller reason"));
		const result = await createIssuer().verify(await sign(), AUDIENCE, {
			signal: controller.signal,
		});
		expect(result).toEqual({
			success: false,
			error: { code: "WORKLOAD_ISSUER_UNAVAILABLE", message: GENERIC_MESSAGE },
		});
		expect(JSON.stringify(result)).not.toContain("sensitive caller reason");
	});

	it("does not return success when aborted after signature verification", async () => {
		const controller = new AbortController();
		let clockReads = 0;
		const issuer = createIssuer(createFetch().fetch, {
			now() {
				clockReads += 1;
				if (clockReads === 2) controller.abort(new Error("post-signature abort"));
				return NOW;
			},
		});
		await expectFailure(
			issuer.verify(await sign(), AUDIENCE, { signal: controller.signal }),
			"WORKLOAD_ISSUER_UNAVAILABLE",
		);
		expect(clockReads).toBe(2);
	});

	it("refetches JWKS once when a rotated key is first unknown", async () => {
		const { fetch, calls } = createFetch({
			jwks: [{ keys: [jwk] }, { keys: [rotatedJwk] }],
		});
		const token = await sign({}, { key: rotatedSigningKey, kid: "rotated" });
		const result = await createIssuer(fetch).verify(token, AUDIENCE);
		expect(result.success).toBe(true);
		expect(calls.filter((request) => request.url.endsWith("/.well-known/jwks"))).toHaveLength(2);
		expect(calls.filter((request) => request.url.includes("openid-configuration"))).toHaveLength(1);
	});

	it("does not repeatedly refetch JWKS after one failed rotation retry", async () => {
		const { fetch, calls } = createFetch({ jwks: { keys: [jwk] } });
		const token = await sign({}, { key: rotatedSigningKey, kid: "rotated" });
		await expectFailure(
			createIssuer(fetch).verify(token, AUDIENCE),
			"WORKLOAD_TOKEN_SIGNATURE_INVALID",
		);
		expect(calls.filter((request) => request.url.endsWith("/.well-known/jwks"))).toHaveLength(2);
	});
});
