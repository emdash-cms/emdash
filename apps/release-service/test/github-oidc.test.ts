import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { GITHUB_ACTIONS_ISSUER, verifyGitHubActionsToken } from "../src/workload/github-oidc.js";

const AUDIENCE = "https://release.example.com";
const KEY_ID = "github-actions-test-key";
const SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);

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

function claims(): Record<string, unknown> {
	return {
		jti: "f4b4a3d2-1111-4222-8333-abcdefabcdef",
		repository: "EmDash-CMS/EmDash",
		repository_id: "123456789",
		repository_owner: "EmDash-CMS",
		repository_owner_id: "987654321",
		workflow_ref: "EmDash-CMS/EmDash/.github/workflows/release.yml@refs/heads/main",
		workflow_sha: WORKFLOW_SHA,
		run_id: "10000000001",
		run_attempt: "2",
		actor: "release-bot",
		actor_id: "11223344",
		event_name: "workflow_dispatch",
		ref: "refs/heads/main",
		ref_type: "branch",
		sha: SHA,
		repository_visibility: "public",
		runner_environment: "github-hosted",
	};
}

async function token(
	options: {
		claims?: Record<string, unknown>;
		issuer?: string;
		audience?: string;
		issuedAt?: number;
		notBefore?: number;
		expiresAt?: number;
		subject?: string;
	} = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT(options.claims ?? claims())
		.setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
		.setIssuer(options.issuer ?? GITHUB_ACTIONS_ISSUER)
		.setAudience(options.audience ?? AUDIENCE)
		.setSubject(
			options.subject ??
				"repo:EmDash-CMS/EmDash:owner_id:987654321:repo_id:123456789:ref:refs/heads/main",
		)
		.setIssuedAt(options.issuedAt ?? now)
		.setNotBefore(options.notBefore ?? now - 1)
		.setExpirationTime(options.expiresAt ?? now + 300)
		.sign(privateKey);
}

describe("GitHub Actions OIDC verification", () => {
	it("verifies and normalizes a workload identity without retaining the token", async () => {
		const rawToken = await token();
		const identity = await verifyGitHubActionsToken(rawToken, AUDIENCE, keyResolver);

		expect(identity).toEqual({
			issuer: "github-actions",
			subject: "repo:EmDash-CMS/EmDash:owner_id:987654321:repo_id:123456789:ref:refs/heads/main",
			tokenId: "f4b4a3d2-1111-4222-8333-abcdefabcdef",
			repository: {
				name: "emdash-cms/emdash",
				id: "123456789",
				owner: "emdash-cms",
				ownerId: "987654321",
				visibility: "public",
			},
			workflow: {
				ref: "EmDash-CMS/EmDash/.github/workflows/release.yml@refs/heads/main",
				sha: WORKFLOW_SHA,
				jobRef: null,
				jobSha: null,
			},
			run: {
				id: "10000000001",
				attempt: 2,
				actor: "release-bot",
				actorId: "11223344",
				eventName: "workflow_dispatch",
				ref: "refs/heads/main",
				refType: "branch",
				commitSha: SHA,
				environment: null,
				runnerEnvironment: "github-hosted",
			},
			issuedAt: expect.any(Number),
			expiresAt: expect.any(Number),
		});
		expect(JSON.stringify(identity)).not.toContain(rawToken);
	});

	it("normalizes optional environment and reusable-workflow claims", async () => {
		const value = claims();
		value["environment"] = "production";
		value["job_workflow_ref"] =
			"EmDash-CMS/release-automation/.github/workflows/publish.yml@refs/tags/v1";
		value["job_workflow_sha"] = "c".repeat(40);

		await expect(
			verifyGitHubActionsToken(await token({ claims: value }), AUDIENCE, keyResolver),
		).resolves.toMatchObject({
			workflow: {
				jobRef: "EmDash-CMS/release-automation/.github/workflows/publish.yml@refs/tags/v1",
				jobSha: "c".repeat(40),
			},
			run: { environment: "production" },
		});
	});

	it("accepts GitHub App bot actor names", async () => {
		await expect(
			verifyGitHubActionsToken(
				await token({ claims: { ...claims(), actor: "dependabot[bot]" } }),
				AUDIENCE,
				keyResolver,
			),
		).resolves.toMatchObject({ run: { actor: "dependabot[bot]" } });
	});

	it.each([
		["repository owner mismatch", { repository_owner: "attacker" }],
		[
			"workflow repository mismatch",
			{ workflow_ref: "attacker/repo/.github/workflows/release.yml@refs/heads/main" },
		],
		["invalid workflow SHA", { workflow_sha: "not-a-sha" }],
		["zero run attempt", { run_attempt: "0" }],
		["invalid ref", { ref: "main" }],
		["invalid ref type", { ref_type: "pull_request" }],
		["invalid visibility", { repository_visibility: "secret" }],
		["invalid runner", { runner_environment: "unknown" }],
		[
			"invalid reusable workflow ref",
			{ job_workflow_ref: "not-a-workflow", job_workflow_sha: SHA },
		],
	] satisfies ReadonlyArray<readonly [string, Record<string, unknown>]>)(
		"rejects %s",
		async (_name, replacement) => {
			await expect(
				verifyGitHubActionsToken(
					await token({ claims: { ...claims(), ...replacement } }),
					AUDIENCE,
					keyResolver,
				),
			).rejects.toMatchObject({ code: "WORKLOAD_TOKEN_INVALID" });
		},
	);

	it("rejects a reusable workflow ref without its matching SHA", async () => {
		await expect(
			verifyGitHubActionsToken(
				await token({
					claims: {
						...claims(),
						job_workflow_ref:
							"EmDash-CMS/release-automation/.github/workflows/publish.yml@refs/heads/main",
					},
				}),
				AUDIENCE,
				keyResolver,
			),
		).rejects.toMatchObject({ code: "WORKLOAD_TOKEN_INVALID" });
	});

	it("rejects missing required normalized claims", async () => {
		const value = claims();
		delete value["repository_id"];

		await expect(
			verifyGitHubActionsToken(await token({ claims: value }), AUDIENCE, keyResolver),
		).rejects.toMatchObject({ code: "WORKLOAD_TOKEN_INVALID" });
	});

	it.each([
		["wrong issuer", { issuer: "https://issuer.example" }],
		["wrong audience", { audience: "https://other.example" }],
		["expired token", { expiresAt: 1 }],
		["future token", { notBefore: Math.floor(Date.now() / 1000) + 3600 }],
		["stale token", { issuedAt: Math.floor(Date.now() / 1000) - 3600 }],
	] satisfies ReadonlyArray<readonly [string, Parameters<typeof token>[0]]>)(
		"rejects a %s",
		async (_name, options) => {
			await expect(
				verifyGitHubActionsToken(await token(options), AUDIENCE, keyResolver),
			).rejects.toMatchObject({ code: "WORKLOAD_TOKEN_INVALID" });
		},
	);

	it("rejects invalid verifier configuration separately from the token", async () => {
		await expect(verifyGitHubActionsToken(await token(), "", keyResolver)).rejects.toMatchObject({
			code: "WORKLOAD_CONFIGURATION_INVALID",
		});
	});

	it("rejects a modified signature", async () => {
		const value = await token();
		const segments = value.split(".");
		const signature = segments[2];
		if (!signature) throw new Error("Expected JWT signature");
		segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;

		await expect(
			verifyGitHubActionsToken(segments.join("."), AUDIENCE, keyResolver),
		).rejects.toMatchObject({ code: "WORKLOAD_TOKEN_INVALID" });
	});
});
