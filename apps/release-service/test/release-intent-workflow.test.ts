import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { NSID } from "@emdash-cms/registry-lexicons";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import profileFixture from "../../../packages/registry-verification/fixtures/records/profile.json";
import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { startReleaseIntentWorkflow } from "../src/workflows/start.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const ARTIFACT_CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const PROVENANCE = {
	predicateType: "https://slsa.dev/provenance/v1",
	url: "https://github.com/example/gallery/attestation.sigstore.json",
	checksum: "bciqkkpvkbtfcwq6kjkbq3kgjxe5j6ihzkxlfxkzqhwzaaaa3wkbq3a",
	sourceRepository: "https://github.com/example/gallery",
	builderId: "https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
} as const;

function releaseRecord() {
	const release = structuredClone(releaseFixture) as PackageRelease.Main & {
		extensions: Record<
			string,
			{ declaredAccess: Record<string, unknown>; provenance?: typeof PROVENANCE }
		>;
	};
	release.artifacts.package.checksum = ARTIFACT_CHECKSUM;
	release.extensions[NSID.packageReleaseExtension]!.provenance = PROVENANCE;
	return release;
}

function workflowNetwork(profile: Record<string, unknown> = structuredClone(profileFixture)) {
	return async (input: RequestInfo | URL): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.hostname === "cloudflare-dns.com") {
			return Response.json({
				Status: 0,
				Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [],
			});
		}
		if (url.hostname === "publisher.example.com" && url.pathname === "/.well-known/did.json") {
			return Response.json({
				id: PUBLISHER_DID,
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
			});
		}
		if (url.hostname === "pds.example.com" && url.pathname === "/xrpc/com.atproto.repo.getRecord") {
			return Response.json({
				uri: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
				cid: "bafyprofile",
				value: {
					...profile,
					id: `at://${PUBLISHER_DID}/${NSID.packageProfile}/gallery`,
				},
			});
		}
		if (
			url.hostname === "pds.example.com" &&
			url.pathname === "/xrpc/com.atproto.repo.listRecords"
		) {
			return Response.json({ records: [] });
		}
		throw new Error(`Unexpected request: ${url.toString()}`);
	};
}

async function createVerifyingIntent(transitionToVerifying = true) {
	const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
	await publisher.putWorkloadPolicy({
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
		now: NOW,
	});
	await publisher.createIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		packageSlug: "gallery",
		version: "1.2.3",
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		idempotencyKey: "github-run-100-attempt-1",
		requestDigest: "B".repeat(43),
		workloadIdentityJson: JSON.stringify({ issuer: "github-actions", runId: "100" }),
		releaseInputJson: JSON.stringify({ release: releaseRecord() }),
		expiresAt: NOW + 60_000,
		now: NOW + 1,
	});
	if (!transitionToVerifying) return;
	await publisher.transitionIntent({
		publisherDid: PUBLISHER_DID,
		intentId: INTENT_ID,
		expectedState: "received",
		expectedGeneration: 1,
		toState: "verifying",
		transitionDigest: "C".repeat(43),
		actorRealm: "system",
		actorIdentity: "release-service",
		reasonCode: null,
		stateDataJson: "{}",
		workflowId: INTENT_ID,
		now: NOW + 2,
	});
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await reset();
});

describe("ReleaseIntentWorkflow", () => {
	it("persists every verification stage and makes a valid non-escalating intent ready", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "ready",
			reasonCode: null,
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "ready", stateGeneration: 4 });
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).listVerificationSteps(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject([
			{ name: "authoritative-profile" },
			{ name: "release-absence" },
			{ name: "access-baseline" },
			{ name: "artifact-provenance" },
			{ name: "policy-decision" },
		]);
	});

	it("waits for a canonical approval transition and resumes from its event", async () => {
		const profile: Record<string, unknown> = {
			...structuredClone(profileFixture),
			extensions: {
				...structuredClone(profileFixture.extensions),
				[NSID.packageProfileExtension]: {
					...structuredClone(profileFixture.extensions[NSID.packageProfileExtension]),
					releasePolicy: {
						confirmation: "always",
						approvers: ["did:plc:approver"],
					},
				},
			},
		};
		vi.stubGlobal("fetch", workflowNetwork(profile));
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		const instance = await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStepResult({ name: "await-approval" });
		const awaiting = await env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(
			PUBLISHER_DID,
			INTENT_ID,
		);
		expect(awaiting).toMatchObject({ state: "awaiting_approval", stateGeneration: 4 });
		if (!awaiting) throw new Error("Expected awaiting intent");
		await env.PUBLISHER_DO.getByName(PUBLISHER_DID).transitionIntent({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			expectedState: "awaiting_approval",
			expectedGeneration: awaiting.stateGeneration,
			toState: "ready",
			transitionDigest: "Z".repeat(43),
			actorRealm: "approver",
			actorIdentity: "did:plc:approver",
			reasonCode: "APPROVED",
			stateDataJson: JSON.stringify({ approved: true }),
		});
		await instance.sendEvent({ type: "approval-decision", payload: { decision: "approve" } });
		await introspector.waitForStatus("complete");
		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "ready",
			reasonCode: null,
		});
	});

	it("starts one deterministic Workflow instance and reuses it on replay", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent(false);
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);

		await expect(
			startReleaseIntentWorkflow(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				PUBLISHER_DID,
				INTENT_ID,
			),
		).resolves.toEqual({ ok: true, workflowId: INTENT_ID, created: true });
		await introspector.waitForStatus("complete");
		await expect(
			startReleaseIntentWorkflow(
				env.RELEASE_INTENT_WORKFLOW,
				env.PUBLISHER_DO,
				PUBLISHER_DID,
				INTENT_ID,
			),
		).resolves.toEqual({ ok: true, workflowId: INTENT_ID, created: false });
	});

	it("persists a verifier rejection and terminates the intent as invalid", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent();
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await introspector.modify(async (modifier) => {
			await modifier.mockStepResult(
				{ name: "isolated-verifier" },
				JSON.stringify({
					success: false,
					error: { code: "CHECKSUM_MISMATCH", message: "Artifact verification failed" },
				}),
			);
		});
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("complete");

		await expect(introspector.getOutput()).resolves.toEqual({
			intentId: INTENT_ID,
			state: "invalid",
			reasonCode: "CHECKSUM_MISMATCH",
		});
		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({ state: "invalid" });
	});
});
