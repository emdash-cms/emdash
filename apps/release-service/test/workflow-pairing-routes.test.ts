import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import { createPublisherApplicationSession } from "../src/publisher-session/session.js";
import {
	handleClaimWorkflowPairing,
	handleConfirmWorkflowPairing,
	handleCreateWorkflowPairing,
	handleGetWorkflowPairing,
} from "../src/workflow-pairing/routes.js";
import { GITHUB_ACTIONS_ISSUER } from "../src/workload/github-oidc.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const PAIRING_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const PAIRING_TOKEN = "T".repeat(43);
const NOW = 1_800_000_000_000;
const KEY_ID = "github-actions-pairing-test";

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

function cookieValue(header: string): string {
	return header.split(";", 1)[0] ?? "";
}

async function publisherHeaders(): Promise<Headers> {
	const session = await createPublisherApplicationSession(env.PUBLISHER_DO, PUBLISHER_DID, NOW);
	const csrf = cookieValue(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
	return new Headers({
		cookie: session.setCookieHeaders.map(cookieValue).join("; "),
		"content-type": "application/json",
		"idempotency-key": "workflow-pairing-request-0001",
		origin: TEST_BINDINGS.PUBLIC_ORIGIN,
		"x-emdash-request": "1",
		"x-emdash-csrf": csrf,
	});
}

async function workloadToken(): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		jti: crypto.randomUUID(),
		repository: "example/gallery",
		repository_id: "123456789",
		repository_owner: "example",
		repository_owner_id: "987654321",
		workflow_ref: "example/gallery/.github/workflows/release.yml@refs/heads/main",
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
		environment: "production",
	})
		.setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
		.setIssuer(GITHUB_ACTIONS_ISSUER)
		.setAudience(TEST_BINDINGS.PUBLIC_ORIGIN)
		.setSubject("repo:example/gallery:environment:production")
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

describe("GitHub workflow pairing routes", () => {
	it("pairs a signed workflow only after account confirmation", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const headers = await publisherHeaders();
		const created = await handleCreateWorkflowPairing(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-pairings`, {
				method: "POST",
				headers,
				body: JSON.stringify({ packageSlug: "gallery" }),
			}),
			"request-create",
			configuration,
			{
				now: () => NOW,
				pairingId: () => PAIRING_ID,
				pairingToken: () => PAIRING_TOKEN,
			},
		);
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			data: {
				pairingToken: PAIRING_TOKEN,
				pairing: { id: PAIRING_ID, packageSlug: "gallery", state: "pending" },
			},
		});

		const claimed = await handleClaimWorkflowPairing(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/workflow-pairings/${PAIRING_ID}/claim`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${await workloadToken()}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ publisherDid: PUBLISHER_DID, pairingToken: PAIRING_TOKEN }),
			}),
			"request-claim",
			configuration,
			{ pairingId: PAIRING_ID },
			{ keyResolver, now: () => NOW + 1 },
		);
		expect(claimed.status).toBe(200);
		expect(await claimed.json()).toMatchObject({
			data: {
				pairing: {
					state: "claimed",
					claim: {
						repository: "example/gallery",
						workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
						ref: "refs/heads/main",
						environment: "production",
					},
				},
			},
		});

		const current = await handleGetWorkflowPairing(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-pairings/${PAIRING_ID}`, {
				headers,
			}),
			"request-get",
			configuration,
			{ pairingId: PAIRING_ID },
			{ now: () => NOW + 2 },
		);
		expect(current.status).toBe(200);
		expect(await current.json()).toMatchObject({
			data: { pairing: { state: "claimed", claim: { repository: "example/gallery" } } },
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getWorkloadPolicy(PUBLISHER_DID, "gallery"),
		).resolves.toBeNull();

		const confirmed = await handleConfirmWorkflowPairing(
			new Request(
				`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-pairings/${PAIRING_ID}/confirm`,
				{ method: "POST", headers, body: "{}" },
			),
			"request-confirm",
			configuration,
			{ pairingId: PAIRING_ID },
			{ now: () => NOW + 3 },
		);
		expect(confirmed.status).toBe(200);
		expect(await confirmed.json()).toMatchObject({
			data: {
				pairing: { state: "confirmed" },
				policy: {
					repository: "example/gallery",
					repositoryId: "123456789",
					repositoryOwnerId: "987654321",
					allowedRefs: ["refs/heads/main"],
					allowedEnvironments: ["production"],
				},
			},
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getWorkloadPolicy(PUBLISHER_DID, "gallery"),
		).resolves.toMatchObject({
			repository: "example/gallery",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		});
	});
});
