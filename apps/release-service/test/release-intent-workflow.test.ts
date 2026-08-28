import type { PackageRelease } from "@emdash-cms/registry-lexicons";
import { NSID } from "@emdash-cms/registry-lexicons";
import { introspectWorkflowInstance, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import { startReleaseIntentWorkflow } from "../src/workflows/start.js";

const PUBLISHER_DID = "did:web:publisher.example.com";
const INTENT_ID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const NOW = 1_800_000_000_000;
const ARTIFACT_CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIgDvmOi+nZTPwAHpDNlC2y2J7fUQ1ApZKJRa48jp934NBndmVyc2lvbgHdAQFxEiAO+Y6L6dlM/AAekM2ULbLYnt9RDUClkolFrjyOn3fg0KZjZGlkeB1kaWQ6d2ViOnB1Ymxpc2hlci5leGFtcGxlLmNvbWNyZXZtM211NXFhZHRwazIybWNzaWdYQKq7vfiaEIAWBU/mBxVb+dRselfs/o/vLWgXiiWtBrrBIT9LTKTG8Ylh5LuryHBu1Xx0m0Zu/FeAL7dzSrbBs9tkZGF0YdgqWCUAAXESICPWWGKAvX12s+8YBNB6iLwFl8YMr6smSZpFoaG8aBsnZHByZXb2Z3ZlcnNpb24DkwEBcRIgI9ZYYoC9fXaz7xgE0HqIvAWXxgyvqyZJmkWhobxoGyeiYWWBpGFrWDJjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWFwAGF09mF22CpYJQABcRIg75HAxLI29zFxT2IAMP+6xED3Uxy3mslLTuujJkBV1nphbPbQAwFxEiDvkcDEsjb3MXFPYgAw/7rEQPdTHLeayUtO66MmQFXWeqhiaWR4VWF0Oi8vZGlkOndlYjpwdWJsaXNoZXIuZXhhbXBsZS5jb20vY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlL2dhbGxlcnlkbmFtZWdHYWxsZXJ5ZHR5cGVtZW1kYXNoLXBsdWdpbmUkdHlwZXgqY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlZ2F1dGhvcnOBoWRuYW1lcUV4YW1wbGUgUHVibGlzaGVyZ2xpY2Vuc2VjTUlUaHNlY3VyaXR5gaFlZW1haWx0c2VjdXJpdHlAZXhhbXBsZS5jb21qZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbqJlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbmpyZXBvc2l0b3J5eCJodHRwczovL2dpdGh1Yi5jb20vZXhhbXBsZS9nYWxsZXJ5";
const APPROVAL_PROFILE_PROOF =
	"OqJlcm9vdHOB2CpYJQABcRIgt4Be/ylpOhy2o33XFr7JATwH2VmFRzL6VB4p2I0MSzVndmVyc2lvbgHdAQFxEiC3gF7/KWk6HLajfdcWvskBPAfZWYVHMvpUHinYjQxLNaZjZGlkeB1kaWQ6d2ViOnB1Ymxpc2hlci5leGFtcGxlLmNvbWNyZXZtM211NXFhZHR6Y2sybWNzaWdYQBg2vVFiuGjkb1Q9TukMNZFbFZ/xXo5d8a6UZnGNnq/FIGQMPMH+RiEl+yhSvATZ9KnIQ2ujZ5q5qkjKyu5t6XhkZGF0YdgqWCUAAXESIGduRlvZ/Lua96nilhYmPVcpLg+ZjEa4kIialhQmHwB0ZHByZXb2Z3ZlcnNpb24DkwEBcRIgZ25GW9n8u5r3qeKWFiY9VykuD5mMRriQiJqWFCYfAHSiYWWBpGFrWDJjb20uZW1kYXNoY21zLmV4cGVyaW1lbnRhbC5wYWNrYWdlLnByb2ZpbGUvZ2FsbGVyeWFwAGF09mF22CpYJQABcRIgrKiSWBl9zSDvo1PXTnK3qUZGccnZeweHtjm0xemh2J5hbPaPBAFxEiCsqJJYGX3NIO+jU9dOcrepRkZxydl7B4e2ObTF6aHYnqhiaWR4VWF0Oi8vZGlkOndlYjpwdWJsaXNoZXIuZXhhbXBsZS5jb20vY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlL2dhbGxlcnlkbmFtZWdHYWxsZXJ5ZHR5cGVtZW1kYXNoLXBsdWdpbmUkdHlwZXgqY29tLmVtZGFzaGNtcy5leHBlcmltZW50YWwucGFja2FnZS5wcm9maWxlZ2F1dGhvcnOBoWRuYW1lcUV4YW1wbGUgUHVibGlzaGVyZ2xpY2Vuc2VjTUlUaHNlY3VyaXR5gaFlZW1haWx0c2VjdXJpdHlAZXhhbXBsZS5jb21qZXh0ZW5zaW9uc6F4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbqNlJHR5cGV4M2NvbS5lbWRhc2hjbXMuZXhwZXJpbWVudGFsLnBhY2thZ2UucHJvZmlsZUV4dGVuc2lvbmpyZXBvc2l0b3J5eCJodHRwczovL2dpdGh1Yi5jb20vZXhhbXBsZS9nYWxsZXJ5bXJlbGVhc2VQb2xpY3miaWFwcHJvdmVyc4FwZGlkOnBsYzphcHByb3Zlcmxjb25maXJtYXRpb25mYWx3YXlz";
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

function workflowNetwork(profileProof = PROFILE_PROOF) {
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
				verificationMethod: [
					{
						id: `${PUBLISHER_DID}#atproto`,
						type: "Multikey",
						controller: PUBLISHER_DID,
						publicKeyMultibase: "zDnaeq9feE9D74uYD5jynoyyQPbhhWU2vStcmC8W1xQHG3fWe",
					},
				],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example.com",
					},
				],
			});
		}
		if (url.hostname === "pds.example.com" && url.pathname === "/xrpc/com.atproto.sync.getRecord") {
			return new Response(
				Uint8Array.from(atob(profileProof), (character) => character.charCodeAt(0)),
				{ headers: { "content-type": "application/vnd.ipld.car" } },
			);
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

async function createVerifyingIntent(
	transitionToVerifying = true,
	releaseInputJson = JSON.stringify({ release: releaseRecord() }),
) {
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
		releaseInputJson,
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
	it("fails the intent when a verification step conflicts", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent();
		const publisher = env.PUBLISHER_DO.getByName(PUBLISHER_DID);
		await publisher.putVerificationStep({
			publisherDid: PUBLISHER_DID,
			intentId: INTENT_ID,
			name: "authoritative-profile",
			inputDigest: "Z".repeat(43),
			resultJson: '{"profileCid":"conflicting"}',
		});
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("errored");

		await expect(publisher.getIntent(PUBLISHER_DID, INTENT_ID)).resolves.toMatchObject({
			state: "failed",
			stateDataJson: '{"code":"VERIFICATION_STEP_CONFLICT"}',
		});
	});

	it("fails the intent when the verifier input is invalid", async () => {
		vi.stubGlobal("fetch", workflowNetwork());
		await createVerifyingIntent(true, "{}");
		await using introspector = await introspectWorkflowInstance(
			env.RELEASE_INTENT_WORKFLOW,
			INTENT_ID,
		);
		await env.RELEASE_INTENT_WORKFLOW.create({
			id: INTENT_ID,
			params: { publisherDid: PUBLISHER_DID, intentId: INTENT_ID },
		});
		await introspector.waitForStatus("errored");

		await expect(
			env.PUBLISHER_DO.getByName(PUBLISHER_DID).getIntent(PUBLISHER_DID, INTENT_ID),
		).resolves.toMatchObject({
			state: "failed",
			stateDataJson: '{"code":"VERIFIER_INPUT_INVALID"}',
		});
	});

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
		vi.stubGlobal("fetch", workflowNetwork(APPROVAL_PROFILE_PROOF));
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
