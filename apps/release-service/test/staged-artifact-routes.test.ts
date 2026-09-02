import { computeMultihash } from "@emdash-cms/registry-verification";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import { handleUploadWorkloadArtifact } from "../src/publishing/workload-staging-routes.js";
import { GITHUB_ACTIONS_ISSUER } from "../src/workload/github-oidc.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const KEY_ID = "github-actions-upload-route-test";
const BYTES = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01]);
let privateKey: CryptoKey;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
	const keys = await generateKeyPair("RS256", { extractable: true });
	privateKey = keys.privateKey;
	const publicJwk = await exportJWK(keys.publicKey);
	publicJwk.kid = KEY_ID;
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

afterEach(async () => {
	await reset();
});

async function token(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		jti: crypto.randomUUID(),
		repository: "example/gallery",
		repository_id: "123456789",
		repository_owner: "example",
		repository_owner_id: "987654321",
		workflow_ref: "example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
		workflow_sha: "b".repeat(40),
		run_id: "10000000001",
		run_attempt: "1",
		actor: "release-bot",
		actor_id: "11223344",
		event_name: "workflow_dispatch",
		ref: "refs/heads/main",
		ref_type: "branch",
		sha: "a".repeat(40),
		repository_visibility: "private",
		runner_environment: "github-hosted",
	})
		.setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
		.setIssuer(GITHUB_ACTIONS_ISSUER)
		.setAudience(TEST_BINDINGS.PUBLIC_ORIGIN)
		.setSubject("repo:example/gallery:ref:refs/heads/main")
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

async function putPolicy(): Promise<void> {
	await env.PUBLISHER_DO.getByName(PUBLISHER_DID).putWorkloadPolicy({
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
	});
}

async function uploadRequest(
	overrides: Partial<Record<string, string>> = {},
	body = BYTES,
): Promise<Request> {
	const checksumResult = await computeMultihash(body);
	if (!checksumResult.success) throw new Error(checksumResult.error.code);
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/staged-artifacts`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${await token()}`,
			"content-length": String(body.byteLength),
			"content-type": "application/gzip",
			"idempotency-key": "github-upload-package-0001",
			"x-emdash-publisher-did": PUBLISHER_DID,
			"x-emdash-package": "gallery",
			"x-emdash-version": "1.2.3",
			"x-emdash-artifact-slot": "package",
			"x-emdash-checksum": checksumResult.value,
			...overrides,
		},
		body,
	});
}

describe("workload staging routes", () => {
	it("accepts bounded artifacts only from an approved GitHub workflow", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const first = await handleUploadWorkloadArtifact(
			await uploadRequest(),
			"request-upload-1",
			configuration,
			{ keyResolver },
		);
		const replay = await handleUploadWorkloadArtifact(
			await uploadRequest(),
			"request-upload-2",
			configuration,
			{ keyResolver },
		);

		expect(first.status).toBe(201);
		await expect(first.json()).resolves.toMatchObject({
			data: {
				replayed: false,
				artifact: {
					slot: "package",
					contentType: "application/gzip",
					size: BYTES.byteLength,
					sourceUrl: expect.stringMatching(
						/^https:\/\/release\.example\.com\/v1\/staged-artifacts\/package\/b/,
					),
				},
			},
		});
		expect(replay.status).toBe(200);
		await expect(replay.json()).resolves.toMatchObject({ data: { replayed: true } });
	});

	it("rejects uploads before the workflow is approved", async () => {
		const response = await handleUploadWorkloadArtifact(
			await uploadRequest(),
			"request-upload-denied",
			await loadConfiguration(TEST_BINDINGS),
			{ keyResolver },
		);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "WORKLOAD_NOT_ALLOWED" },
		});
		expect((await env.PUBLICATION_STAGING.list()).objects).toHaveLength(0);
	});

	it("rejects invalid size and checksum headers before writing", async () => {
		await putPolicy();
		const response = await handleUploadWorkloadArtifact(
			await uploadRequest({ "content-length": "999999999", "x-emdash-checksum": "invalid" }),
			"request-upload-invalid",
			await loadConfiguration(TEST_BINDINGS),
			{ keyResolver },
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_REQUEST" } });
		expect((await env.PUBLICATION_STAGING.list()).objects).toHaveLength(0);
	});
});
