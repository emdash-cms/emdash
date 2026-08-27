import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { loadConfiguration } from "../src/config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../src/control-do/service-control-do.js";
import {
	handleCancelReleaseIntent,
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
	return structuredClone(releaseFixture) as PackageRelease.Main;
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
	it("submits asynchronously, replays with a fresh matching token, and never stores the token", async () => {
		await putPolicy();
		const configuration = await loadConfiguration(TEST_BINDINGS);
		const firstToken = await token();
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
			submitDependencies,
		);
		expect(first.status).toBe(202);
		expect(await first.json()).toMatchObject({
			data: { intent: { id: INTENT_ID, state: "received" }, replayed: false },
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

		const secondToken = await token();
		const replay = await handleSubmitReleaseIntent(
			request("/v1/release-intents", secondToken, {
				method: "POST",
				body,
				idempotencyKey: "github-run-100-attempt-1",
			}),
			"request-2",
			configuration,
			submitDependencies,
		);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			data: { intent: { id: INTENT_ID }, replayed: true },
		});

		const stored = await env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(
			PUBLISHER_DID,
			INTENT_ID,
		);
		expect(stored).not.toBeNull();
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
				await token(),
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
		expect(denied.status).toBe(403);

		const cancelled = await handleCancelReleaseIntent(
			request(
				`/v1/release-intents/${INTENT_ID}/cancel?publisher=${encodeURIComponent(PUBLISHER_DID)}`,
				await token(),
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
});
