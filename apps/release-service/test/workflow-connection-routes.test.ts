import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadConfiguration } from "../src/config.js";
import { createPublisherApplicationSession } from "../src/publisher-session/session.js";
import {
	handleConfirmWorkflowConnection,
	handleCreateWorkflowConnectionInvitation,
	handleListWorkflowConnections,
	handleRejectWorkflowConnection,
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

async function publisherHeaders(
	mutationKey = "workflow-connection-confirm-0001",
): Promise<Headers> {
	const session = await createPublisherApplicationSession(env.PUBLISHER_DO, PUBLISHER_DID, NOW);
	const csrf = cookieValue(session.setCookieHeaders[1]).split("=", 2)[1] ?? "";
	return new Headers({
		cookie: session.setCookieHeaders.map(cookieValue).join("; "),
		"content-type": "application/json",
		"idempotency-key": mutationKey,
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

async function workloadToken(
	options: {
		ref?: string;
		repository?: string;
		repositoryId?: string;
		repositoryOwnerId?: string;
	} = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const ref = options.ref ?? "refs/tags/v1.2.3";
	const repository = options.repository ?? "example/gallery";
	const repositoryOwner = repository.split("/", 1)[0]!;
	return new SignJWT({
		jti: crypto.randomUUID(),
		repository,
		repository_id: options.repositoryId ?? "123456789",
		repository_owner: repositoryOwner,
		repository_owner_id: options.repositoryOwnerId ?? "987654321",
		workflow_ref: `${repository}/.github/workflows/release.yml@refs/heads/main`,
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
		.setSubject(`repo:${repository}:ref:${ref}`)
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

function workflowRequest(
	token: string,
	options: {
		invitationToken?: string;
		mutationKey?: string;
		packageSlug?: string;
	} = {},
) {
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/workflow-connections`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"idempotency-key": options.mutationKey ?? "workflow-connection-request-0001",
		},
		body: JSON.stringify({
			publisherDid: PUBLISHER_DID,
			packageSlug: options.packageSlug ?? "gallery",
			...(options.invitationToken ? { invitationToken: options.invitationToken } : {}),
		}),
	});
}

async function createInvitation(
	configuration: Awaited<ReturnType<typeof loadConfiguration>>,
	options: { packageSlug?: string; now?: number; token?: string } = {},
): Promise<string> {
	const token = options.token ?? `ewci1_${"I".repeat(43)}`;
	const response = await handleCreateWorkflowConnectionInvitation(
		new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-connection-invitations`, {
			method: "POST",
			headers: await publisherHeaders("workflow-connection-invitation-0001"),
			body: JSON.stringify({ packageSlug: options.packageSlug ?? "gallery" }),
		}),
		"request-invitation",
		configuration,
		{ now: () => options.now ?? NOW, invitationToken: () => token },
	);
	expect(response.status).toBe(201);
	await expect(response.clone().json()).resolves.toMatchObject({
		data: {
			invitationToken: token,
			packageSlug: options.packageSlug ?? "gallery",
		},
	});
	return token;
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

	it("prevents unrelated GitHub principals from consuming the publisher onboarding queue", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await publisherHeaders();
		await enablePublishing();
		const invitationToken = await createInvitation(configuration);

		for (let index = 0; index < 10; index += 1) {
			const response = await handleRequestWorkflowConnection(
				workflowRequest(
					await workloadToken({
						repository: `unrelated${index}/spam${index}`,
						repositoryId: String(200_000_000 + index),
						repositoryOwnerId: String(300_000_000 + index),
					}),
					{
						mutationKey: `workflow-connection-spam-${index.toString().padStart(4, "0")}`,
						packageSlug: `spam${index}`,
					},
				),
				`request-spam-${index}`,
				configuration,
				{
					keyResolver,
					now: () => NOW + index,
					requestId: () => `01JABCDEFGHJKMNPQRSTVWXY${index.toString(36).toUpperCase()}0`,
				},
			);
			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toMatchObject({
				error: { code: "WORKFLOW_CONNECTION_INVITATION_REQUIRED" },
			});
		}

		const legitimate = await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken(), { invitationToken }),
			"request-legitimate",
			configuration,
			{ keyResolver, now: () => NOW + 10, requestId: () => REQUEST_ID },
		);
		expect(legitimate.status).toBe(202);
		await expect(legitimate.json()).resolves.toMatchObject({
			data: { status: "pending", request: { packageSlug: "gallery" } },
		});
	});

	it("consumes invitations once and rejects expired invitations", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await publisherHeaders();
		await enablePublishing();
		const invitationToken = await createInvitation(configuration);
		const [firstAttempt, secondAttempt] = await Promise.all([
			handleRequestWorkflowConnection(
				workflowRequest(await workloadToken(), { invitationToken }),
				"request-accepted",
				configuration,
				{ keyResolver, now: () => NOW + 1, requestId: () => REQUEST_ID },
			),
			handleRequestWorkflowConnection(
				workflowRequest(
					await workloadToken({
						repository: "unrelated/gallery",
						repositoryId: "223456789",
						repositoryOwnerId: "287654321",
					}),
					{
						invitationToken,
						mutationKey: "workflow-connection-request-0002",
					},
				),
				"request-replay",
				configuration,
				{
					keyResolver,
					now: () => NOW + 2,
					requestId: () => "01JABCDEFGHJKMNPQRSTVWXYZ1",
				},
			),
		]);
		expect(
			[firstAttempt.status, secondAttempt.status].toSorted((left, right) => left - right),
		).toEqual([202, 403]);
		const replayedByAnotherPrincipal = firstAttempt.status === 403 ? firstAttempt : secondAttempt;
		expect(replayedByAnotherPrincipal.status).toBe(403);
		await expect(replayedByAnotherPrincipal.json()).resolves.toMatchObject({
			error: { code: "WORKFLOW_CONNECTION_INVITATION_INVALID" },
		});

		const expiringToken = await createInvitation(configuration, {
			token: `ewci1_${"E".repeat(43)}`,
		});
		const expired = await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken(), {
				invitationToken: expiringToken,
				mutationKey: "workflow-connection-request-0003",
			}),
			"request-expired",
			configuration,
			{
				keyResolver,
				now: () => NOW + 30 * 60_000 + 1,
				requestId: () => "01JABCDEFGHJKMNPQRSTVWXYZ2",
			},
		);
		expect(expired.status).toBe(410);
		await expect(expired.json()).resolves.toMatchObject({
			error: { code: "WORKFLOW_CONNECTION_INVITATION_EXPIRED" },
		});
	});

	it("lets the publisher reject a pending workflow connection", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await publisherHeaders();
		await enablePublishing();
		const invitationToken = await createInvitation(configuration);
		await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken(), { invitationToken }),
			"request-accepted",
			configuration,
			{ keyResolver, now: () => NOW + 1, requestId: () => REQUEST_ID },
		);

		const rejected = await handleRejectWorkflowConnection(
			new Request(
				`${TEST_BINDINGS.PUBLIC_ORIGIN}/v1/publisher/workflow-connections/${REQUEST_ID}`,
				{
					method: "DELETE",
					headers: await publisherHeaders("workflow-connection-reject-0001"),
					body: "{}",
				},
			),
			"request-reject",
			configuration,
			{ requestId: REQUEST_ID },
			{ now: () => NOW + 2 },
		);
		expect(rejected.status).toBe(200);
		await expect(rejected.json()).resolves.toMatchObject({ data: { rejected: true } });
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).listWorkflowConnectionRequests(
				PUBLISHER_DID,
				20,
				NOW + 3,
			),
		).resolves.toEqual([]);
	});

	it("lets the first permanent workflow request publisher confirmation", async () => {
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await publisherHeaders();
		await enablePublishing();
		const invitationToken = await createInvitation(configuration);
		const requested = await handleRequestWorkflowConnection(
			workflowRequest(await workloadToken(), { invitationToken }),
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
			workflowRequest(await workloadToken({ ref: "refs/tags/v2.0.0" }), {
				mutationKey: "workflow-connection-request-0002",
			}),
			"request-connected",
			configuration,
			{ keyResolver, now: () => NOW + 3, requestId: () => "01JABCDEFGHJKMNPQRSTVWXYZ1" },
		);
		expect(await connected.json()).toMatchObject({
			data: { status: "connected", policy: { allowedRefs: ["refs/tags/*"] } },
		});
	});
});
