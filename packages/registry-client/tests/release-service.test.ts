import { NSID } from "@emdash-cms/registry-lexicons";
import { describe, expect, it, vi } from "vitest";

import {
	ReleaseServiceClient,
	ReleaseServiceError,
	ReleaseServiceOperatorClient,
	createReleaseIdempotencyKey,
} from "../src/release-service/index.js";

const SERVICE = "https://release.example.com";
const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const CONNECTION_ID = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const CONNECTION_INVITATION = `ewci1_${"I".repeat(43)}`;
const CSRF = "C".repeat(43);
const CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";

function sourceRelease() {
	return {
		$type: "com.emdashcms.experimental.package.release" as const,
		package: "gallery",
		version: "1.2.3",
		artifacts: {
			package: { url: "https://example.com/gallery.tgz", checksum: CHECKSUM },
		},
		extensions: {
			[NSID.packageReleaseExtension]: {
				$type: NSID.packageReleaseExtension,
				declaredAccess: {},
				provenance: {
					url: "https://example.com/provenance.json",
					checksum: CHECKSUM,
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: "https://github.com/example/gallery",
					builderId:
						"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
				},
			},
		},
	};
}

function intent(state = "received", service = SERVICE) {
	return {
		id: INTENT_ID,
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		version: "1.2.3",
		state,
		stateGeneration: 2,
		reasonCode: null,
		workflowId: INTENT_ID,
		expiresAt: 1_800_000_000_000,
		createdAt: 1_799_999_000_000,
		updatedAt: 1_799_999_500_000,
		result: null,
		approvalUrl:
			state === "awaiting_approval"
				? `${service}/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`
				: null,
	};
}

function policy() {
	return {
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		active: true,
		stateVersion: 1,
		authorizedBy: PUBLISHER_DID,
		createdAt: 1_799_999_000_000,
		updatedAt: 1_799_999_000_000,
	};
}

function connection(state: "confirmed" | "pending") {
	return {
		id: CONNECTION_ID,
		packageSlug: "gallery",
		state,
		claim: {
			repository: "example/gallery",
			repositoryId: "123456789",
			repositoryOwner: "example",
			repositoryOwnerId: "987654321",
			repositoryVisibility: "private",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			ref: "refs/tags/v1.2.3",
			environment: "production",
		},
		refScope: state === "confirmed" ? "version_tags" : null,
		expiresAt: 1_800_000_900_000,
		createdAt: 1_800_000_000_000,
		confirmedAt: state === "confirmed" ? 1_800_000_002_000 : null,
	};
}

function success(data: unknown, status = 200): Response {
	return Response.json(
		{ data, requestId: "request-1" },
		{ status, headers: { "x-request-id": "request-1" } },
	);
}

describe("ReleaseServiceClient", () => {
	it("allows only explicit loopback HTTP origins for local development", () => {
		expect(
			new ReleaseServiceClient({
				serviceUrl: "http://127.0.0.1:5175",
				workloadToken: "header.payload.signature",
			}),
		).toBeInstanceOf(ReleaseServiceClient);
		expect(
			() =>
				new ReleaseServiceClient({
					serviceUrl: "http://release.example.com",
					workloadToken: "header.payload.signature",
				}),
		).toThrow("HTTPS origin or a loopback");
	});

	it("accepts an approval URL on the configured loopback origin", async () => {
		const service = "http://127.0.0.1:5175";
		const client = new ReleaseServiceClient({
			serviceUrl: service,
			fetch: async () => success({ intent: intent("awaiting_approval", service) }),
			workloadToken: "header.payload.signature",
		});

		await expect(client.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			approvalUrl: `${service}/approvals/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`,
		});
	});

	it("submits a typed intent without retaining or exposing the workload token", async () => {
		const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
		const workloadToken = "header.payload.signature";
		const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
			calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
			return success({ intent: intent(), replayed: false }, 202);
		});
		const client = new ReleaseServiceClient({ serviceUrl: SERVICE, fetch, workloadToken });
		const release = sourceRelease();
		const result = await client.submitIntent(
			{ publisherDid: PUBLISHER_DID, packageSlug: "gallery", version: "1.2.3", release },
			{ idempotencyKey: "github-run-100-attempt-1" },
		);

		expect(result).toMatchObject({ intent: { id: INTENT_ID }, replayed: false });
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0]!.url).pathname).toBe("/v1/release-intents");
		const headers = new Headers(calls[0]!.init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${workloadToken}`);
		expect(headers.get("idempotency-key")).toBe("github-run-100-attempt-1");
		expect(JSON.stringify(result)).not.toContain(workloadToken);
	});

	it("uploads exact release bytes through workload OIDC before intent submission", async () => {
		let request: Request | null = null;
		const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			workloadToken: "header.payload.signature",
			fetch: async (input, init) => {
				request = new Request(input, init);
				return success(
					{
						artifact: {
							slot: "package",
							checksum: CHECKSUM,
							contentType: "application/gzip",
							size: bytes.byteLength,
							sourceUrl: `${SERVICE}/v1/staged-artifacts/package/${CHECKSUM}`,
						},
						replayed: false,
					},
					201,
				);
			},
		});

		await expect(
			client.uploadReleaseArtifact(
				{
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					slot: "package",
					checksum: CHECKSUM,
					contentType: "application/gzip",
					bytes,
				},
				{ idempotencyKey: "github-upload-package-0001" },
			),
		).resolves.toMatchObject({ artifact: { slot: "package", size: bytes.byteLength } });
		expect(request?.url).toBe(`${SERVICE}/v1/staged-artifacts`);
		expect(request?.headers.get("authorization")).toBe("Bearer header.payload.signature");
		expect(request?.headers.get("content-length")).toBe(String(bytes.byteLength));
		expect(request?.headers.get("x-emdash-checksum")).toBe(CHECKSUM);
		expect(new Uint8Array(await request!.arrayBuffer())).toEqual(bytes);
	});

	it("rejects invalid source records before acquiring a workload token", async () => {
		const release = sourceRelease();
		Object.assign(release.artifacts.package, {
			blob: {
				$type: "blob",
				ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
				mimeType: "application/gzip",
				size: 128,
			},
		});
		const token = vi.fn(() => "header.payload.signature");
		const fetch = vi.fn<typeof globalThis.fetch>();
		const client = new ReleaseServiceClient({ serviceUrl: SERVICE, fetch, workloadToken: token });

		await expect(
			client.submitIntent(
				{ publisherDid: PUBLISHER_DID, packageSlug: "gallery", version: "1.2.3", release },
				{ idempotencyKey: "github-run-100-attempt-1" },
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(token).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("dry-runs workload admission without an idempotency key", async () => {
		let request: Request | null = null;
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			workloadToken: "header.payload.signature",
			fetch: async (input, init) => {
				request = new Request(input, init);
				return success({
					allowed: true,
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					workloadPolicyVersion: 2,
					workloadIdentityDigest: "W".repeat(43),
					requestDigest: "R".repeat(43),
				});
			},
		});
		const release = sourceRelease();

		await expect(
			client.dryRunIntent({
				publisherDid: PUBLISHER_DID,
				packageSlug: "gallery",
				version: "1.2.3",
				release,
			}),
		).resolves.toMatchObject({ allowed: true, workloadPolicyVersion: 2 });
		expect(request?.url).toBe(`${SERVICE}/v1/release-intents/dry-run`);
		expect(request?.headers.get("authorization")).toBe("Bearer header.payload.signature");
		expect(request?.headers.has("idempotency-key")).toBe(false);
	});

	it("rejects invalid dry-run source records before acquiring a workload token", async () => {
		const release = sourceRelease();
		Object.assign(release.artifacts.package, {
			blob: {
				$type: "blob",
				ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
				mimeType: "application/gzip",
				size: 128,
			},
		});
		const token = vi.fn(() => "header.payload.signature");
		const fetch = vi.fn<typeof globalThis.fetch>();
		const client = new ReleaseServiceClient({ serviceUrl: SERVICE, fetch, workloadToken: token });

		await expect(
			client.dryRunIntent({
				publisherDid: PUBLISHER_DID,
				packageSlug: "gallery",
				version: "1.2.3",
				release,
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(token).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("maps stable server errors, retry hints, and network failures", async () => {
		const workloadToken = "header.payload.signature";
		const pausedFetch: typeof globalThis.fetch = async () =>
			Response.json(
				{
					error: { code: "SERVICE_PAUSED", message: "Release admission is paused" },
					requestId: "request-paused",
				},
				{ status: 503, headers: { "retry-after": "2" } },
			);
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: pausedFetch,
			workloadToken,
		});
		await expect(client.getIntent(PUBLISHER_DID, INTENT_ID)).rejects.toMatchObject({
			code: "SERVICE_PAUSED",
			status: 503,
			requestId: "request-paused",
			retryable: true,
			retryAfterMs: 2_000,
		});
		try {
			await client.getIntent(PUBLISHER_DID, INTENT_ID);
			expect.fail("expected release service error");
		} catch (error) {
			expect(error).toBeInstanceOf(ReleaseServiceError);
			expect(JSON.stringify(error)).not.toContain(workloadToken);
		}

		const offline = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: async () => {
				throw new TypeError("offline with sensitive provider details");
			},
			workloadToken,
		});
		await expect(offline.getIntent(PUBLISHER_DID, INTENT_ID)).rejects.toMatchObject({
			code: "NETWORK_ERROR",
			message: "Release service request failed",
			retryable: true,
		});
	});

	it("polls with a fresh token and stops at approval by default", async () => {
		const tokens: string[] = [];
		let responseIndex = 0;
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			tokens.push(new Headers(init?.headers).get("authorization") ?? "");
			const state = responseIndex++ === 0 ? "verifying" : "awaiting_approval";
			return success({ intent: intent(state) });
		};
		let tokenIndex = 0;
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch,
			workloadToken: () => `token-${++tokenIndex}`,
		});
		const updates: string[] = [];
		const result = await client.waitForIntent(PUBLISHER_DID, INTENT_ID, {
			pollIntervalMs: 0,
			maxWaitMs: 1_000,
			onUpdate: (value) => {
				updates.push(value.state);
			},
		});

		expect(result.state).toBe("awaiting_approval");
		expect(result.approvalUrl).toContain(INTENT_ID);
		expect(tokens).toEqual(["Bearer token-1", "Bearer token-2"]);
		expect(updates).toEqual(["verifying", "awaiting_approval"]);
	});

	it("parses expired intents whose state was updated after the deadline", async () => {
		const expired = {
			...intent("expired"),
			reasonCode: "APPROVAL_EXPIRED",
			updatedAt: 1_800_000_001_000,
		};
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: async () => success({ intent: expired }),
			workloadToken: "header.payload.signature",
		});

		await expect(client.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			state: "expired",
			reasonCode: "APPROVAL_EXPIRED",
			updatedAt: expired.updatedAt,
		});
	});

	it("rejects malformed success envelopes at the client trust boundary", async () => {
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: async () => success({ intent: { id: INTENT_ID } }),
			workloadToken: "header.payload.signature",
		});
		await expect(client.getIntent(PUBLISHER_DID, INTENT_ID)).rejects.toMatchObject({
			code: "CLIENT_RESPONSE_INVALID",
			status: 502,
		});

		const unsafeLink = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: async () =>
				success({
					intent: {
						...intent("awaiting_approval"),
						approvalUrl: "https://attacker.example/approve",
					},
				}),
			workloadToken: "header.payload.signature",
		});
		await expect(unsafeLink.getIntent(PUBLISHER_DID, INTENT_ID)).rejects.toMatchObject({
			code: "CLIENT_RESPONSE_INVALID",
		});
	});

	it("uses cookie credentials and double-submit CSRF only for publisher mutations", async () => {
		const calls: RequestInit[] = [];
		const fetch: typeof globalThis.fetch = async (input, init = {}) => {
			calls.push(init);
			const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
			if (path === "/v1/publisher") {
				return success({ publisher: { did: PUBLISHER_DID, delegation: null } });
			}
			return success({ policy: policy(), replayed: false }, 201);
		};
		const client = new ReleaseServiceClient({ serviceUrl: SERVICE, fetch, csrfToken: CSRF });
		await client.getPublisher();
		await client.putWorkload(
			{
				packageSlug: "gallery",
				repository: "example/gallery",
				repositoryId: "123456789",
				repositoryOwnerId: "987654321",
				workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
				allowedRefs: ["refs/heads/main"],
				allowedEnvironments: [],
				expectedVersion: null,
			},
			{ idempotencyKey: "publisher-workload-0001" },
		);

		expect(calls[0]?.credentials).toBe("include");
		expect(new Headers(calls[0]?.headers).has("authorization")).toBe(false);
		expect(calls[1]?.credentials).toBe("include");
		const mutationHeaders = new Headers(calls[1]?.headers);
		expect(mutationHeaders.get("x-emdash-request")).toBe("1");
		expect(mutationHeaders.get("x-emdash-csrf")).toBe(CSRF);
		expect(mutationHeaders.has("authorization")).toBe(false);
	});

	it("requests a GitHub workflow connection from OIDC and confirms it in the browser", async () => {
		const calls: Request[] = [];
		let workloadRequests = 0;
		const fetch: typeof globalThis.fetch = async (input, init = {}) => {
			const request = new Request(input, init);
			calls.push(request);
			if (request.url.endsWith("/workflow-connection-invitations")) {
				return success({
					invitationToken: CONNECTION_INVITATION,
					packageSlug: "gallery",
					expiresAt: 1_800_000_900_000,
				});
			}
			if (request.method === "DELETE") return success({ rejected: true });
			if (request.url.endsWith("/confirm")) {
				return success({ request: connection("confirmed"), policy: policy(), replayed: false });
			}
			if (request.method === "GET") return success({ items: [connection("pending")] });
			workloadRequests += 1;
			return workloadRequests === 1
				? success(
						{
							status: "pending",
							request: connection("pending"),
							approvalUrl: `${SERVICE}/publisher?connection=${CONNECTION_ID}`,
							replayed: false,
						},
						202,
					)
				: success({ status: "connected", policy: policy() });
		};
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch,
			csrfToken: CSRF,
			workloadToken: "header.payload.signature",
		});

		await expect(
			client.createWorkflowConnectionInvitation("gallery", {
				idempotencyKey: "workflow-connection-invitation-0001",
			}),
		).resolves.toEqual({
			invitationToken: CONNECTION_INVITATION,
			packageSlug: "gallery",
			expiresAt: 1_800_000_900_000,
		});
		await expect(
			client.requestWorkflowConnection(
				{
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					invitationToken: CONNECTION_INVITATION,
				},
				{
					idempotencyKey: "workflow-connection-request-0001",
				},
			),
		).resolves.toMatchObject({ status: "pending", request: { state: "pending" } });
		await expect(client.listWorkflowConnections()).resolves.toMatchObject([
			{ id: CONNECTION_ID, state: "pending" },
		]);
		await expect(
			client.rejectWorkflowConnection(CONNECTION_ID, {
				idempotencyKey: "workflow-connection-reject-0001",
			}),
		).resolves.toBeUndefined();
		await expect(
			client.confirmWorkflowConnection(CONNECTION_ID, "version_tags", {
				idempotencyKey: "workflow-connection-confirm-0001",
			}),
		).resolves.toMatchObject({ request: { state: "confirmed" }, policy: { active: true } });
		await expect(
			client.requestWorkflowConnection(
				{ publisherDid: PUBLISHER_DID, packageSlug: "gallery" },
				{ idempotencyKey: "workflow-connection-request-0002" },
			),
		).resolves.toMatchObject({ status: "connected", policy: { active: true } });

		expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
			"/v1/publisher/workflow-connection-invitations",
			"/v1/workflow-connections",
			"/v1/publisher/workflow-connections",
			`/v1/publisher/workflow-connections/${CONNECTION_ID}`,
			`/v1/publisher/workflow-connections/${CONNECTION_ID}/confirm`,
			"/v1/workflow-connections",
		]);
		expect(calls[0]?.credentials).toBe("include");
		expect(calls[1]?.headers.get("authorization")).toBe("Bearer header.payload.signature");
		expect(await calls[1]?.json()).toEqual({
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			invitationToken: CONNECTION_INVITATION,
		});
		expect(calls[2]?.credentials).toBe("include");
		expect(calls[3]?.headers.get("x-emdash-csrf")).toBe(CSRF);
		expect(calls[4]?.headers.get("x-emdash-csrf")).toBe(CSRF);
		expect(calls[5]?.headers.get("authorization")).toBe("Bearer header.payload.signature");
	});

	it("lists only the authenticated publisher audit", async () => {
		let captured = "";
		let capturedSignal: AbortSignal | null | undefined;
		const controller = new AbortController();
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: async (input, init) => {
				captured = input instanceof Request ? input.url : input.toString();
				capturedSignal = init?.signal;
				return success({
					items: [
						{
							sequence: 3,
							eventType: "workload-policy-stored",
							actorRealm: "publisher",
							actorIdentity: PUBLISHER_DID,
							actorHandle: "publisher.example.com",
							subject: "gallery",
							reasonCode: null,
							createdAt: 1_800_000_000_000,
						},
					],
					nextCursor: "3",
				});
			},
		});

		await expect(
			client.listPublisherAudit({ cursor: "2", limit: 1, signal: controller.signal }),
		).resolves.toMatchObject({
			items: [{ sequence: 3, actorRealm: "publisher", actorHandle: "publisher.example.com" }],
			nextCursor: "3",
		});
		expect(captured).toBe(`${SERVICE}/v1/publisher/audit?cursor=2&limit=1`);
		expect(capturedSignal).toBe(controller.signal);
		await expect(client.listPublisherAudit({ cursor: "0" })).rejects.toMatchObject({
			code: "CLIENT_RESPONSE_INVALID",
		});
		await expect(client.listPublisherAudit({ cursor: "01" })).rejects.toMatchObject({
			code: "CLIENT_RESPONSE_INVALID",
		});
	});

	it("reads publisher-visible approver readiness", async () => {
		let captured = "";
		const client = new ReleaseServiceClient({
			serviceUrl: SERVICE,
			fetch: async (input) => {
				captured = input instanceof Request ? input.url : input.toString();
				return success({
					packageSlug: "gallery",
					profileCid: "bafyprofile",
					items: [
						{
							did: "did:plc:approver",
							handle: "approver.example.com",
							status: "enrolled",
						},
					],
				});
			},
		});

		await expect(client.getPublisherApproverStatus("gallery")).resolves.toEqual({
			packageSlug: "gallery",
			profileCid: "bafyprofile",
			items: [{ did: "did:plc:approver", handle: "approver.example.com", status: "enrolled" }],
		});
		expect(captured).toBe(`${SERVICE}/v1/publisher/workloads/gallery/approvers`);
	});

	it("creates valid collision-resistant idempotency keys", () => {
		const first = createReleaseIdempotencyKey("github action");
		const second = createReleaseIdempotencyKey("github action");
		expect(first).toMatch(/^github-action-[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});
});

describe("ReleaseServiceOperatorClient", () => {
	it("paginates sanitized service-control audit events", async () => {
		let captured = "";
		const client = new ReleaseServiceOperatorClient({
			serviceUrl: SERVICE,
			fetch: async (input) => {
				captured = input instanceof Request ? input.url : input.toString();
				return success({
					items: [
						{
							sequence: 7,
							eventType: "service-mode-changed",
							actorRealm: "access",
							actorIdentity: "operator-subject",
							actorRole: "admin",
							subject: "publication-paused",
							reasonCode: "MAINTENANCE",
							createdAt: 1_800_000_000_000,
						},
					],
					nextCursor: "7",
				});
			},
		});

		await expect(client.listAudit({ cursor: "6", limit: 1 })).resolves.toMatchObject({
			items: [{ sequence: 7, actorRole: "admin" }],
			nextCursor: "7",
		});
		expect(captured).toBe(`${SERVICE}/admin/api/audit?after=6&limit=1`);
	});

	it("lists one bounded operations-directory shard", async () => {
		let captured = "";
		const fetch: typeof globalThis.fetch = async (input) => {
			captured = input instanceof Request ? input.url : input.toString();
			return success({
				items: [
					{
						kind: "publisher",
						did: PUBLISHER_DID,
						shard: "7f",
						registeredAt: 1_800_000_000_000,
						lastSeenAt: 1_800_000_000_001,
					},
				],
				nextCursor: "cursor-next",
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.listDirectory("publisher", { cursor: "cursor-current", limit: 25 }),
		).resolves.toMatchObject({
			items: [{ did: PUBLISHER_DID, kind: "publisher", shard: "7f" }],
			nextCursor: "cursor-next",
		});
		const url = new URL(captured);
		expect(url.pathname).toBe("/admin/api/directory");
		expect(url.searchParams.get("kind")).toBe("publisher");
		expect(url.searchParams.get("cursor")).toBe("cursor-current");
		expect(url.searchParams.get("limit")).toBe("25");
	});

	it("uses Access cookie credentials and roleless operator paths", async () => {
		const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			calls.push({ url: input instanceof Request ? input.url : input.toString(), init });
			return success({
				publisher: {
					did: PUBLISHER_DID,
					delegation: null,
					control: {
						publisherDid: PUBLISHER_DID,
						status: "suspended",
						reasonCode: "ABUSE_REVIEW",
						changedBy: "admin@example.com",
						changedAt: 1_800_000_000_000,
					},
				},
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		const result = await client.getPublisher(PUBLISHER_DID);

		expect(result.control.status).toBe("suspended");
		expect(new URL(calls[0]!.url).pathname).toBe(
			`/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}`,
		);
		expect(calls[0]!.init?.credentials).toBe("include");
	});

	it("adds idempotency and mutation headers to reconciliation", async () => {
		let captured: { init: RequestInit | undefined; url: string } | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured = { url: input instanceof Request ? input.url : input.toString(), init };
			return success({ intent: intent("reconciling"), restarted: true }, 202);
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		const result = await client.reconcileIntent(PUBLISHER_DID, INTENT_ID, {
			idempotencyKey: "operator-reconcile-0001",
		});

		expect(result.restarted).toBe(true);
		expect(new URL(captured!.url).pathname).toBe(`/admin/api/intents/${INTENT_ID}/reconcile`);
		const headers = new Headers(captured!.init?.headers);
		expect(headers.get("idempotency-key")).toBe("operator-reconcile-0001");
		expect(headers.get("x-emdash-request")).toBe("1");
		expect(captured!.init?.credentials).toBe("include");
	});

	it("pages publisher and approver encryption rotation through Access", async () => {
		const calls: Array<{ body: string | null; path: string }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			calls.push({ path: url.pathname, body: typeof init?.body === "string" ? init.body : null });
			return success({
				ownerDid: url.pathname.includes("/approvers/") ? "did:plc:approver" : PUBLISHER_DID,
				targetKeyVersion: 2,
				scanned: 1,
				rotated: 0,
				raced: 0,
				nextCursor: null,
				complete: true,
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.rotatePublisherEncryption(
				PUBLISHER_DID,
				{ afterCursor: null, limit: 25 },
				{ idempotencyKey: "operator-publisher-rotation-0001" },
			),
		).resolves.toMatchObject({ ownerDid: PUBLISHER_DID, targetKeyVersion: 2, complete: true });
		await expect(
			client.rotateApproverEncryption(
				"did:plc:approver",
				{
					afterCursor: "identity-transaction:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
					limit: 10,
				},
				{ idempotencyKey: "operator-approver-rotation-0001" },
			),
		).resolves.toMatchObject({ ownerDid: "did:plc:approver", rotated: 0 });

		expect(calls).toEqual([
			{
				path: `/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}/encryption/rotate`,
				body: '{"afterCursor":null,"limit":25}',
			},
			{
				path: "/admin/api/approvers/did%3Aplc%3Aapprover/encryption/rotate",
				body: '{"afterCursor":"identity-transaction:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG","limit":10}',
			},
		]);
	});

	it("reads, activates, and retires encryption key lifecycle state", async () => {
		const calls: Array<{ body: string | null; path: string }> = [];
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			calls.push({ path: url.pathname, body: typeof init?.body === "string" ? init.body : null });
			if (init?.method === "GET") {
				return success({
					configured: { activeVersion: 2, versions: [1, 2] },
					keys: [
						{
							version: 1,
							status: "readable",
							activatedAt: 0,
							retiredAt: null,
							changedBy: "system:bootstrap",
							updatedAt: 100,
						},
						{
							version: 2,
							status: "active",
							activatedAt: 100,
							retiredAt: null,
							changedBy: "operator",
							updatedAt: 100,
						},
					],
					verification: null,
				});
			}
			if (url.pathname.endsWith("/verify")) {
				return success({ workflowId: "V".repeat(43), created: true });
			}
			const retiring = url.pathname.endsWith("/retire");
			return success({
				key: {
					version: retiring ? 1 : 2,
					status: retiring ? "retired" : "active",
					activatedAt: retiring ? 0 : 100,
					retiredAt: retiring ? 200 : null,
					changedBy: "operator",
					updatedAt: retiring ? 200 : 100,
				},
				replayed: false,
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(client.getEncryptionKeyStatus()).resolves.toMatchObject({
			configured: { activeVersion: 2 },
			keys: [
				{ version: 1, status: "readable" },
				{ version: 2, status: "active" },
			],
		});
		await expect(
			client.activateEncryptionKey(2, { idempotencyKey: "operator-key-activate-0001" }),
		).resolves.toMatchObject({ value: { version: 2, status: "active" }, replayed: false });
		await expect(
			client.startEncryptionVerification(1, {
				idempotencyKey: "operator-key-verification-0001",
			}),
		).resolves.toEqual({ workflowId: "V".repeat(43), created: true });
		await expect(
			client.retireEncryptionKey(1, { idempotencyKey: "operator-key-retire-0001" }),
		).resolves.toMatchObject({ value: { version: 1, status: "retired" }, replayed: false });
		expect(calls).toEqual([
			{ path: "/admin/api/encryption/keys", body: null },
			{ path: "/admin/api/encryption/keys/activate", body: '{"version":2}' },
			{ path: "/admin/api/encryption/verify", body: '{"retiringVersion":1}' },
			{ path: "/admin/api/encryption/keys/1/retire", body: "{}" },
		]);
	});

	it("resumes encrypted publisher archive pages through Access", async () => {
		let captured: { init: RequestInit | undefined; url: string } | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured = { url: input instanceof Request ? input.url : input.toString(), init };
			return success({
				archiveId: "publisher-archive-0001",
				ownerHash: "A".repeat(43),
				page: 2,
				kind: "intents",
				nextCursor: "audit:0",
				nextPage: 3,
				replayed: false,
				complete: false,
				manifestWritten: false,
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.archivePublisher(
				PUBLISHER_DID,
				{ archiveId: "publisher-archive-0001", cursor: "intents:", page: 2 },
				{ idempotencyKey: "operator-publisher-archive-0001" },
			),
		).resolves.toMatchObject({ kind: "intents", nextCursor: "audit:0", nextPage: 3 });
		expect(new URL(captured!.url).pathname).toBe(
			`/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}/archive`,
		);
		expect(captured!.init?.body).toBe(
			'{"archiveId":"publisher-archive-0001","cursor":"intents:","page":2}',
		);
	});

	it("starts a durable publisher archive Workflow through Access", async () => {
		let captured: { init: RequestInit | undefined; url: string } | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured = { url: input instanceof Request ? input.url : input.toString(), init };
			return success(
				{
					archiveId: "publisher-archive-0001",
					workflowId: "W".repeat(43),
					created: true,
				},
				202,
			);
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.startPublisherArchive(PUBLISHER_DID, "publisher-archive-0001", {
				idempotencyKey: "operator-publisher-archive-start-0001",
			}),
		).resolves.toMatchObject({ workflowId: "W".repeat(43), created: true });
		expect(new URL(captured!.url).pathname).toBe(
			`/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}/archive/start`,
		);
		expect(captured!.init?.body).toBe('{"archiveId":"publisher-archive-0001"}');
	});

	it("applies suspended publisher restore pages through Access", async () => {
		let captured: { init: RequestInit | undefined; url: string } | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured = { url: input instanceof Request ? input.url : input.toString(), init };
			return success({
				archiveId: "publisher-archive-0001",
				ownerHash: "A".repeat(43),
				page: 3,
				kind: "audit-events",
				nextPage: 4,
				totalPages: 4,
				replayed: false,
				complete: true,
				authorityStatus: "reauthorization_required",
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.restorePublisher(
				PUBLISHER_DID,
				{ archiveId: "publisher-archive-0001", page: 3 },
				{ idempotencyKey: "operator-publisher-restore-0001" },
			),
		).resolves.toMatchObject({ complete: true, authorityStatus: "reauthorization_required" });
		expect(new URL(captured!.url).pathname).toBe(
			`/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}/restore`,
		);
		expect(captured!.init?.body).toBe('{"archiveId":"publisher-archive-0001","page":3}');
	});

	it("prepares a suspended shard for restore with exact DID confirmation", async () => {
		let captured: { init: RequestInit | undefined; url: string } | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured = { url: input instanceof Request ? input.url : input.toString(), init };
			return success({
				archiveId: "publisher-archive-0001",
				publisherDid: PUBLISHER_DID,
				prepared: true,
				deletedIntents: 3,
				deletedWorkloads: 1,
				replayed: false,
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.preparePublisherRestore(PUBLISHER_DID, "publisher-archive-0001", {
				idempotencyKey: "operator-publisher-restore-prepare-0001",
			}),
		).resolves.toMatchObject({ prepared: true, deletedIntents: 3, replayed: false });
		expect(new URL(captured!.url).pathname).toBe(
			`/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}/restore/prepare`,
		);
		expect(captured!.init?.body).toBe(
			`{"archiveId":"publisher-archive-0001","confirmPublisherDid":"${PUBLISHER_DID}"}`,
		);
	});

	it("aborts a suspended shard restore with exact DID confirmation", async () => {
		let captured: { init: RequestInit | undefined; url: string } | null = null;
		const fetch: typeof globalThis.fetch = async (input, init) => {
			captured = { url: input instanceof Request ? input.url : input.toString(), init };
			return success({
				archiveId: "publisher-archive-0001",
				publisherDid: PUBLISHER_DID,
				aborted: true,
				replayed: false,
			});
		};
		const client = new ReleaseServiceOperatorClient({ serviceUrl: SERVICE, fetch });
		await expect(
			client.abortPublisherRestore(PUBLISHER_DID, "publisher-archive-0001", {
				idempotencyKey: "operator-publisher-restore-abort-0001",
			}),
		).resolves.toMatchObject({ aborted: true, replayed: false });
		expect(new URL(captured!.url).pathname).toBe(
			`/admin/api/publishers/${encodeURIComponent(PUBLISHER_DID)}/restore/abort`,
		);
		expect(captured!.init?.body).toBe(
			`{"archiveId":"publisher-archive-0001","confirmPublisherDid":"${PUBLISHER_DID}"}`,
		);
	});
});
