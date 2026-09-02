import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import { createPublisherApplicationSession } from "../src/publisher-session/session.js";
import {
	handleConfirmWorkflowConnection,
	handleListWorkflowConnections,
	handleRequestWorkflowConnection,
} from "../src/workflow-connection/routes.js";
import { GITHUB_ACTIONS_ISSUER } from "../src/workload/github-oidc.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const REQUEST_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const KEY_ID = "github-actions-connection-test";

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
		"idempotency-key": "workflow-connection-confirm-0001",
		origin: TEST_BINDINGS.PUBLIC_ORIGIN,
		"x-emdash-request": "1",
		"x-emdash-csrf": csrf,
	});
}

async function enablePublishing() {
	await env.PUBLISHER_DO.getByName(PUBLISHER_DID).putDelegation({
		publisherDid: PUBLISHER_DID,
		releaseNsid: "com.emdashcms.experimental.package.release",
		scope:
			"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		clientKeyId: "test-key",
		encryptedSession: "encrypted-session",
		encryptionKeyVersion: 1,
		issuer: "https://authorization.example.com",
		pdsUrl: "https://pds.example.com",
		expiresAt: null,
		refreshBefore: null,
		expectedVersion: null,
	});
}

async function workloadToken(ref = "refs/tags/v1.2.3"): Promise<string> {
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
		event_name: "push",
		ref,
		ref_type: "tag",
		sha: "a".repeat(40),
		repository_visibility: "private",
		runner_environment: "github-hosted",
		environment: "production",
	})
		.setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
		.setIssuer(GITHUB_ACTIONS_ISSUER)
		.setAudience(TEST_BINDINGS.PUBLIC_ORIGIN)
		.setSubject(`repo:example/gallery:ref:${ref}`)
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

function workflowRequest(token: string, mutationKey = "workflow-connection-request-0001") {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/workflow-connections`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"idempotency-key": mutationKey,
		},
		body: JSON.stringify({ publisherDid: PUBLISHER_DID, packageSlug: "gallery" }),
	});
}

describe("GitHub workflow connection routes", () => {
	it("does not initialize a publisher shard before the account authorizes publishing", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const response = await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken()),
			"request-unconfigured",
			configuration,
			{ keyResolver, now: () => NOW, requestId: () => REQUEST_ID },
		);
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "DELEGATION_REQUIRED" },
		});
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(PUBLISHER_DID), (_instance, state) => ({
				publishers: state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publisher")
					.one().count,
				requests: state.storage.sql
					.exec<{ count: number }>("SELECT COUNT(*) AS count FROM workflow_connection_requests")
					.one().count,
			})),
		).resolves.toEqual({ publishers: 0, requests: 0 });
	});

	it("lets the first permanent workflow request publisher confirmation", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await publisherHeaders();
		await enablePublishing();
		const requested = await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken()),
			"request-create",
			configuration,
			{ keyResolver, now: () => NOW, requestId: () => REQUEST_ID },
		);
		expect(requested.status).toBe(202);
		expect(await requested.json()).toMatchObject({
			data: {
				status: "pending",
				request: {
					id: REQUEST_ID,
					packageSlug: "gallery",
					state: "pending",
					claim: {
						repository: "example/gallery",
						ref: "refs/tags/v1.2.3",
					},
				},
				approvalUrl: `${TEST_BINDINGS.PUBLIC_ORIGIN}/publisher?connection=${REQUEST_ID}`,
			},
		});

		const headers = await publisherHeaders();
		const listed = await handleListWorkflowConnections(
			new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-connections`, {
				headers,
			}),
			"request-list",
			configuration,
			{ now: () => NOW + 1 },
		);
		expect(await listed.json()).toMatchObject({
			data: { items: [{ id: REQUEST_ID, state: "pending" }] },
		});

		const confirmed = await handleConfirmWorkflowConnection(
			new Request(
				`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-connections/${REQUEST_ID}/confirm`,
				{ method: "POST", headers, body: JSON.stringify({ refScope: "version_tags" }) },
			),
			"request-confirm",
			configuration,
			{ requestId: REQUEST_ID },
			{ now: () => NOW + 2 },
		);
		expect(await confirmed.json()).toMatchObject({
			data: {
				request: { state: "confirmed", refScope: "version_tags" },
				policy: { allowedRefs: ["refs/tags/*"] },
			},
		});

		const connected = await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken("refs/tags/v2.0.0"), "workflow-connection-request-0002"),
			"request-connected",
			configuration,
			{ keyResolver, now: () => NOW + 3, requestId: () => "01JABCDEFGHJKMNPQRSTVWXYZ1" },
		);
		expect(await connected.json()).toMatchObject({
			data: { status: "connected", policy: { allowedRefs: ["refs/tags/*"] } },
		});
	});
});
