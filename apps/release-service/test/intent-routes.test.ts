import { NSID, type PackageRelease } from "@emdash-cms/registry-lexicons";
import { reset, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { ulid } from "ulidx";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { loadConfiguration } from "../src/config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import {
	handleCancelReleaseIntent,
	handleDryRunReleaseIntent,
	handleGetReleaseIntent,
	handleSubmitReleaseIntent,
} from "../src/intents/routes.js";
import { GITHUB_ACTIONS_ISSUER } from "../src/workload/github-oidc.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const KEY_ID = "github-actions-route-test";
const SHA = "a".repeat(40);
const WORKFLOW_SHA = "b".repeat(40);
const CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";

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

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		jti: crypto.randomUUID(),
		repository: "example/gallery",
		repository_id: "123456789",
		repository_owner: "example",
		repository_owner_id: "987654321",
		workflow_ref: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		workflow_sha: WORKFLOW_SHA,
		run_id: "10000000001",
		run_attempt: "1",
		actor: "release-bot",
		actor_id: "11223344",
		event_name: "workflow_dispatch",
		ref: "refs/heads/main",
		ref_type: "branch",
		sha: SHA,
		repository_visibility: "public",
		runner_environment: "github-hosted",
		...overrides,
	};
}

async function token(overrides: Record<string, unknown> = {}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT(claims(overrides))
		.setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
		.setIssuer(GITHUB_ACTIONS_ISSUER)
		.setAudience(TEST_BINDINGS.PUBLIC_ORIGIN)
		.setSubject("repo:example/gallery:ref:refs/heads/main")
		.setIssuedAt(now)
		.setNotBefore(now - 1)
		.setExpirationTime(now + 300)
		.sign(privateKey);
}

function release(): PackageRelease.Main {
	const value = structuredClone(releaseFixture) as PackageRelease.Main;
	value.artifacts.package.checksum = CHECKSUM;
	value.extensions = {
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
	};
	return value;
}

function request(
	path: string,
	workloadToken: string,
	init: { body?: unknown; idempotencyKey?: string; method?: string } = {},
): Request {
	const headers = new Headers({ authorization: `Bearer ${workloadToken}` });
	if (init.body !== undefined) headers.set("content-type", "application/json");
	if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
	return new Request(`${TEST_BINDINGS.PUBLIC_ORIGIN}${path}`, {
		method: init.method ?? "GET",
		headers,
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
}

async function putPolicy() {
	await env.PUBLISHER_DO.getByName(PUBLISHER_DID).putWorkloadPolicy({
		publisherDid: PUBLISHER_DID,
		packageSlug: "gallery",
		repository: "example/gallery",
		repositoryId: "123456789",
		repositoryOwnerId: "987654321",
		workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		allowedRefs: ["refs/heads/main"],
		allowedEnvironments: [],
		active: true,
		expectedVersion: null,
		now: NOW - 1,
	});
}

const submitDependencies = {
	get keyResolver() {
		return keyResolver;
	},
	now: () => NOW,
	intentId: () => INTENT_ID,
	startWorkflow: async () => ({ ok: true, workflowId: INTENT_ID, created: true }) as const,
};

afterEach(async () => {
	await reset();
});

describe("release intent API", () => {
	it("rejects invalid source records before reserving or starting a Workflow", async () => {
		const invalidRelease = release();
		Object.assign(invalidRelease.artifacts.package, {
			blob: {
				$type: "blob",
				ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
				mimeType: "application/gzip",
				size: 128,
			},
		});
		let workflowStarted = false;
		const response = await handleSubmitReleaseIntent(
			request("/v1/release-intents", await token(), {
				method: "POST",
				body: {
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					release: invalidRelease,
				},
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-invalid-source",
			await loadConfiguration(TEST_BINDINGS),
			{
				...submitDependencies,
				startWorkflow: async () => {
					workflowStarted = true;
					return { ok: true, workflowId: INTENT_ID, created: true };
				},
			},
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
		expect(workflowStarted).toBe(false);
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(PUBLISHER_DID), (_instance, state) =>
				state.storage.sql
					.exec<{ intents: number; reservations: number }>(
						`SELECT
							(SELECT COUNT(*) FROM intents) AS intents,
							(SELECT COUNT(*) FROM release_reservations) AS reservations`,
					)
					.one(),
			),
		).resolves.toEqual({ intents: 0, reservations: 0 });
	});

	it("dry-runs admission without reserving, rate limiting, or starting a Workflow", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const response = await handleDryRunReleaseIntent(
			request("/v1/release-intents/dry-run", await token(), {
				method: "POST",
				body: {
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					release: release(),
				},
			}),
			"request-dry-run",
			configuration,
			{ keyResolver },
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			data: {
				allowed: true,
				publisherDid: PUBLISHER_DID,
				packageSlug: "gallery",
				version: "1.2.3",
				workloadPolicyVersion: 1,
				workloadIdentityDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
				requestDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			},
		});
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(PUBLISHER_DID), (_instance, state) =>
				state.storage.sql
					.exec<{ intents: number; reservations: number; rate_windows: number }>(
						`SELECT
							(SELECT COUNT(*) FROM intents) AS intents,
							(SELECT COUNT(*) FROM release_reservations) AS reservations,
							(SELECT COUNT(*) FROM intent_rate_windows) AS rate_windows`,
					)
					.one(),
			),
		).resolves.toEqual({ intents: 0, reservations: 0, rate_windows: 0 });
	});

	it("rejects an invalid dry-run source before admission state", async () => {
		const invalidRelease = release();
		Object.assign(invalidRelease.artifacts.package, {
			blob: {
				$type: "blob",
				ref: { $link: "bafkreicoew2cifs6fwqhqpkvkezdokuvpquj6p7aosznuf7jhxkehsltpe" },
				mimeType: "application/gzip",
				size: 128,
			},
		});
		const response = await handleDryRunReleaseIntent(
			request("/v1/release-intents/dry-run", await token(), {
				method: "POST",
				body: {
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					release: invalidRelease,
				},
			}),
			"request-invalid-dry-run",
			await loadConfiguration(TEST_BINDINGS),
			{ keyResolver },
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "INVALID_REQUEST" },
		});
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(PUBLISHER_DID), (_instance, state) =>
				state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publisher").one(),
			),
		).resolves.toEqual({ count: 0 });
	});

	it("does not initialize an unknown publisher shard during dry-run", async () => {
		const publisherDid = "did:plc:unknownpublisher";
		const response = await handleDryRunReleaseIntent(
			request("/v1/release-intents/dry-run", await token(), {
				method: "POST",
				body: {
					publisherDid,
					packageSlug: "gallery",
					version: "1.2.3",
					release: release(),
				},
			}),
			"request-unknown-dry-run",
			await loadConfiguration(TEST_BINDINGS),
			{ keyResolver },
		);

		expect(response.status).toBe(403);
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(publisherDid), (_instance, state) =>
				state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publisher").one(),
			),
		).resolves.toEqual({ count: 0 });
	});

	it("does not reveal publisher suspension before workload authorization", async () => {
		await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setPublisherControl({
			actor: {
				realm: "access",
				identity: "admin@example.com",
				email: "admin@example.com",
				role: "admin",
			},
			idempotencyKey: "suspend-unrelated-workload",
			requestDigest: "S".repeat(43),
			publisherDid: PUBLISHER_DID,
			status: "suspended",
			reasonCode: "SECURITY_REVIEW",
			now: NOW,
		});
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const body = {
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			version: "1.2.3",
			release: release(),
		};
		const dryRun = await handleDryRunReleaseIntent(
			request("/v1/release-intents/dry-run", await token(), { method: "POST", body }),
			"request-suspension-probe-dry-run",
			configuration,
			{ keyResolver },
		);
		const submission = await handleSubmitReleaseIntent(
			request("/v1/release-intents", await token(), {
				method: "POST",
				body,
				idempotencyKey: "suspension-probe-submit",
			}),
			"request-suspension-probe-submit",
			configuration,
			submitDependencies,
		);

		for (const response of [dryRun, submission]) {
			expect(response.status).toBe(403);
			await expect(response.json()).resolves.toMatchObject({
				error: { code: "WORKLOAD_NOT_ALLOWED" },
			});
		}
	});

	it("reports publisher suspension to an authorized workload", async () => {
		await putPolicy();
		await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setPublisherControl({
			actor: {
				realm: "access",
				identity: "admin@example.com",
				email: "admin@example.com",
				role: "admin",
			},
			idempotencyKey: "suspend-authorized-workload",
			requestDigest: "S".repeat(43),
			publisherDid: PUBLISHER_DID,
			status: "suspended",
			reasonCode: "SECURITY_REVIEW",
			now: NOW,
		});
		const response = await handleDryRunReleaseIntent(
			request("/v1/release-intents/dry-run", await token(), {
				method: "POST",
				body: {
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					release: release(),
				},
			}),
			"request-authorized-suspended",
			await loadConfiguration(TEST_BINDINGS),
			{ keyResolver },
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "PUBLISHER_SUSPENDED" },
		});
	});

	it("rejects a failed-start replay after the workload is disabled and never stores the token", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const firstToken = await token();
		let workflowStarts = 0;
		const dependencies = {
			...submitDependencies,
			startWorkflow: async () => {
				workflowStarts += 1;
				return { ok: false, code: "WORKFLOW_UNAVAILABLE" } as const;
			},
		};
		const body = {
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			version: "1.2.3",
			release: release(),
		};
		const first = await handleSubmitReleaseIntent(
			request("/v1/release-intents", firstToken, {
				method: "POST",
				body,
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-1",
			configuration,
			dependencies,
		);
		expect(first.status).toBe(503);
		expect(await first.json()).toMatchObject({
			error: { code: "WORKFLOW_UNAVAILABLE" },
		});
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).putWorkloadPolicy({
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			repository: "example/gallery",
			repositoryId: "123456789",
			repositoryOwnerId: "987654321",
			workflowRef: "example/gallery/.github/workflows/release.yml@refs/heads/main",
			allowedRefs: ["refs/heads/main"],
			allowedEnvironments: [],
			active: false,
			expectedVersion: 1,
			now: NOW + 1,
		});

		const secondToken = await token({ run_attempt: "2" });
		const replay = await handleSubmitReleaseIntent(
			request("/v1/release-intents", secondToken, {
				method: "POST",
				body,
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-2",
			configuration,
			dependencies,
		);
		expect(replay.status).toBe(403);
		expect(await replay.json()).toMatchObject({
			error: { code: "WORKLOAD_NOT_ALLOWED" },
		});
		expect(workflowStarts).toBe(1);

		const stored = await env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(
			PUBLISHER_DID,
			INTENT_ID,
		);
		expect(stored).toMatchObject({
			state: "invalid",
			stateDataJson: '{"reasonCode":"WORKLOAD_POLICY_CHANGED"}',
		});
		expect(JSON.stringify(stored)).not.toContain(firstToken);
		expect(JSON.stringify(stored)).not.toContain(secondToken);
	});

	it("rejects a changed request under the same workload and idempotency key", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const workloadToken = await token();
		const body = {
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			version: "1.2.3",
			release: release(),
		};
		await handleSubmitReleaseIntent(
			request("/v1/release-intents", workloadToken, {
				method: "POST",
				body,
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-1",
			configuration,
			submitDependencies,
		);
		const changed = structuredClone(body);
		changed.release.artifacts.package.url = "https://example.com/changed.tgz";
		const response = await handleSubmitReleaseIntent(
			request("/v1/release-intents", await token(), {
				method: "POST",
				body: changed,
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-2",
			configuration,
			submitDependencies,
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "IDEMPOTENCY_CONFLICT" },
		});
	});

	it("reads and cancels only with the same normalized workload identity", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const body = {
			publisherDid: PUBLISHER_DID,
			packageSlug: "gallery",
			version: "1.2.3",
			release: release(),
		};
		await handleSubmitReleaseIntent(
			request("/v1/release-intents", await token(), {
				method: "POST",
				body,
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-1",
			configuration,
			submitDependencies,
		);

		const status = await handleGetReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`,
				await token({ run_attempt: "2" }),
			),
			"request-2",
			configuration,
			{ intentId: INTENT_ID },
			keyResolver,
		);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ data: { intent: { state: "received" } } });

		const denied = await handleGetReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}?publisher=${encodeURIComponent(PUBLISHER_DID)}`,
				await token({ run_id: "20000000002" }),
			),
			"request-3",
			configuration,
			{ intentId: INTENT_ID },
			keyResolver,
		);
		expect(denied.status).toBe(404);
		await expect(denied.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });

		const cancelled = await handleCancelReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}/cancel?publisher=${encodeURIComponent(PUBLISHER_DID)}`,
				await token({ run_attempt: "2" }),
				{ method: "POST", body: {}, idempotencyKey: "cancel-run-100-attempt-1" },
			),
			"request-4",
			configuration,
			{ intentId: INTENT_ID },
			keyResolver,
		);
		expect(cancelled.status).toBe(200);
		expect(await cancelled.json()).toMatchObject({
			data: { intent: { state: "cancelled", reasonCode: "CANCELLED" } },
		});
		const stored = await env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(
			PUBLISHER_DID,
			INTENT_ID,
		);
		const transitions = await env.PUBLISHER_DO.getByName(PUBLISHER_DID).listIntentTransitions(
			PUBLISHER_DID,
			INTENT_ID,
		);
		expect(transitions.at(-1)).toMatchObject({
			actorRealm: "oidc",
			actorIdentity: stored?.workloadIdentityDigest,
		});
	});

	it("authenticates bearer requests before looking up intent state", async () => {
		const publisherDid = "did:x:unauthenticated";
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const getResponse = await handleGetReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}?publisher=${encodeURIComponent(publisherDid)}`,
				"invalid-token",
			),
			"request-unauthenticated-get",
			configuration,
			{ intentId: INTENT_ID },
			keyResolver,
		);
		const cancelResponse = await handleCancelReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}/cancel?publisher=${encodeURIComponent(publisherDid)}`,
				"invalid-token",
				{ method: "POST", body: {}, idempotencyKey: "cancel-unauthenticated" },
			),
			"request-unauthenticated-cancel",
			configuration,
			{ intentId: INTENT_ID },
			keyResolver,
		);

		expect(getResponse.status).toBe(401);
		expect(cancelResponse.status).toBe(401);
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(publisherDid), (_instance, state) =>
				state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publisher").one(),
			),
		).resolves.toEqual({ count: 0 });
	});

	it("does not claim an absent publisher identity while looking up an intent", async () => {
		const publisherDid = "did:x:absent-intent";
		const response = await handleGetReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}?publisher=${encodeURIComponent(publisherDid)}`,
				await token(),
			),
			"request-absent-intent",
			await loadConfiguration(TEST_BINDINGS),
			{ intentId: INTENT_ID },
			keyResolver,
		);

		expect(response.status).toBe(404);
		await expect(
			runInDurableObject(env.PUBLISHER_DO.getByName(publisherDid), (_instance, state) =>
				state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publisher").one(),
			),
		).resolves.toEqual({ count: 0 });
	});

	it("fails closed when admission is paused", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		await env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME).setServiceMode({
			actor: {
				realm: "access",
				identity: "admin@example.com",
				email: "admin@example.com",
				role: "admin",
			},
			idempotencyKey: "pause-release-intents",
			requestDigest: "P".repeat(43),
			mode: "admission-paused",
			reasonCode: "MAINTENANCE",
			now: NOW,
		});
		const response = await handleSubmitReleaseIntent(
			request("/v1/release-intents", await token(), {
				method: "POST",
				body: {
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.3",
					release: release(),
				},
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-1",
			configuration,
			submitDependencies,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: { code: "SERVICE_PAUSED" } });
	});

	it("rate limits one workload without consuming another publisher shard", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const workloadToken = await token();
		for (let index = 0; index < 30; index += 1) {
			const version = `1.2.${index}`;
			const value = release();
			value.version = version;
			const response = await handleSubmitReleaseIntent(
				request("/v1/release-intents", workloadToken, {
					method: "POST",
					body: {
						publisherDid: PUBLISHER_DID,
						packageSlug: "gallery",
						version,
						release: value,
					},
					idempotencyKey: `github-rate-limit-${String(index).padStart(4, "0")}`,
				}),
				`request-${index}`,
				configuration,
				{ ...submitDependencies, intentId: () => ulid(NOW + index) },
			);
			expect(response.status).toBe(202);
		}
		const blockedRelease = release();
		blockedRelease.version = "1.2.30";
		const blocked = await handleSubmitReleaseIntent(
			request("/v1/release-intents", workloadToken, {
				method: "POST",
				body: {
					publisherDid: PUBLISHER_DID,
					packageSlug: "gallery",
					version: "1.2.30",
					release: blockedRelease,
				},
				idempotencyKey: "github-rate-limit-over-limit",
			}),
			"request-blocked",
			configuration,
			{ ...submitDependencies, intentId: () => ulid(NOW + 31) },
		);
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("retry-after")).toBe("60");
		await expect(blocked.json()).resolves.toMatchObject({
			error: { code: "WORKLOAD_RATE_LIMITED" },
		});

		await expect(
			env.PUBLISHER_DO.getByName("did:plc:other").consumeIntentRateLimit({
				publisherDid: "did:plc:other",
				repositoryId: "123456789",
				workloadKey: "Z".repeat(43),
				idempotencyKey: "other-publisher-rate-limit",
				expiresAt: NOW + 24 * 60 * 60_000,
				now: NOW,
			}),
		).resolves.toMatchObject({ ok: true });
	});
});
