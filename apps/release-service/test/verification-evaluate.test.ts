import type { PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import profileFixture from "../../../packages/registry-verification/fixtures/records/profile.json";
import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import type { ReleaseVerificationReport } from "../../release-verifier/src/verify.js";
import type { StoredIntent } from "../src/publisher-do/publisher-do.js";
import type { StoredWorkloadPolicy } from "../src/publisher-do/workload-policy.js";
import {
	evaluateWorkloadAttestation,
	evaluateVerifiedRelease,
	normalizeVerifierReport,
	parseNormalizedVerifierReport,
	prepareVerifierInput,
} from "../src/verification/evaluate.js";
import type { PublisherVerificationSnapshot } from "../src/verification/pds.js";
import { digestWorkloadIdentity } from "../src/workload/policy.js";
import type { VerifiedWorkloadIdentity } from "../src/workload/types.js";

const PUBLISHER_DID = "did:plc:publisher";
const ARTIFACT_CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const PROVENANCE = {
	predicateType: "https://slsa.dev/provenance/v1",
	url: "https://github.com/example/gallery/attestation.sigstore.json",
	checksum: "bciqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	sourceRepository: "https://github.com/example/gallery",
	builderId: "https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
} as const;
const WORKLOAD_IDENTITY: VerifiedWorkloadIdentity = {
	issuer: "github-actions",
	subject: "repo:example/gallery:ref:refs/heads/main",
	tokenId: "token-100",
	repository: {
		name: "example/gallery",
		id: "123456789",
		owner: "example",
		ownerId: "987654321",
		visibility: "public",
	},
	workflow: {
		ref: "example/gallery/.github/workflows/release.yml@refs/heads/main",
		sha: "a".repeat(40),
		jobRef: null,
		jobSha: null,
	},
	run: {
		id: "100",
		attempt: 1,
		actor: "release-bot",
		actorId: "2468",
		eventName: "push",
		ref: "refs/heads/main",
		refType: "branch",
		commitSha: "b".repeat(40),
		environment: null,
		runnerEnvironment: "github-hosted",
	},
	issuedAt: 1_800_000_000,
	expiresAt: 1_800_000_300,
};
const WORKLOAD_POLICY: StoredWorkloadPolicy = {
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
	createdAt: 1_800_000_000_000,
	updatedAt: 1_800_000_000_000,
};

function proposedRelease() {
	const release = structuredClone(releaseFixture) as PackageRelease.Main & {
		extensions: Record<
			string,
			{ declaredAccess: Record<string, unknown>; provenance?: typeof PROVENANCE }
		>;
	};
	release.artifacts.package.checksum = ARTIFACT_CHECKSUM;
	release.extensions["com.emdashcms.experimental.package.releaseExtension"]!.provenance =
		PROVENANCE;
	return release;
}

async function intent(
	release = proposedRelease(),
	identity: VerifiedWorkloadIdentity = WORKLOAD_IDENTITY,
): Promise<StoredIntent> {
	return {
		id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
		packageSlug: "gallery",
		version: "1.2.3",
		state: "verifying",
		stateGeneration: 2,
		workloadPolicyVersion: 1,
		workloadIdentityDigest: await digestWorkloadIdentity(identity),
		workloadIdempotencyDigest: "I".repeat(43),
		requestDigest: "B".repeat(43),
		workloadIdentityJson: JSON.stringify(identity),
		releaseInputJson: JSON.stringify({ release }),
		stateDataJson: "{}",
		workflowId: "01JABCDEFGHJKMNPQRSTVWXYZ0",
		expiresAt: 1_800_000_060_000,
		createdAt: 1_800_000_000_000,
		updatedAt: 1_800_000_000_001,
	};
}

function snapshot(
	profile: unknown = structuredClone(profileFixture),
): PublisherVerificationSnapshot {
	return {
		profile: {
			uri: `at://${PUBLISHER_DID}/com.emdashcms.experimental.package.profile/gallery`,
			cid: "bafyprofile",
			value: profile,
		},
		proposedRkey: "gallery:1.2.3",
		proposedReleaseAbsent: true,
		baseline: null,
		baselineVersion: null,
	};
}

function verifierReport(): ReleaseVerificationReport {
	return {
		success: true,
		value: {
			artifact: {
				requestedUrl: releaseFixture.artifacts.package.url,
				resolvedUrl: releaseFixture.artifacts.package.url,
				checksum: ARTIFACT_CHECKSUM,
				compressedBytes: 1024,
				manifest: { id: "gallery", version: "1.2.3", declaredAccess: {} },
				bundle: { backendBytes: 100, adminBytes: null },
			},
			provenance: {
				requestedUrl: PROVENANCE.url,
				resolvedUrl: PROVENANCE.url,
				checksum: PROVENANCE.checksum,
				documentBytes: 512,
				predicateType: PROVENANCE.predicateType,
				sourceRepository: PROVENANCE.sourceRepository,
				builderId: PROVENANCE.builderId,
				repositoryId: WORKLOAD_IDENTITY.repository.id,
				workflowRef: WORKLOAD_IDENTITY.workflow.ref.slice(
					WORKLOAD_IDENTITY.workflow.ref.lastIndexOf("@") + 1,
				),
				commitSha: WORKLOAD_IDENTITY.run.commitSha,
				invocationId: "https://github.com/example/gallery/actions/runs/100/attempts/1",
				artifactDigest: new Uint8Array(32),
			},
		},
	};
}

describe("verification evaluation", () => {
	it("prepares the isolated verifier request from signed inputs", async () => {
		expect(prepareVerifierInput(await intent(), snapshot())).toEqual({
			artifact: {
				url: releaseFixture.artifacts.package.url,
				checksum: ARTIFACT_CHECKSUM,
				packageSlug: "gallery",
				version: "1.2.3",
			},
			provenance: PROVENANCE,
			profileRepository: "https://github.com/example/gallery",
		});
	});

	it("accepts a fully matching automatic release and creates complete approval evidence", async () => {
		const result = await evaluateVerifiedRelease(
			PUBLISHER_DID,
			await intent(),
			snapshot(),
			WORKLOAD_POLICY,
			verifierReport(),
		);
		if (!result.success) throw new Error(`${result.code}:${result.reasonCode}`);
		expect(result).toMatchObject({
			success: true,
			value: {
				requiresApproval: false,
				accessDiff: { escalation: false, changes: [] },
				approvalEvidence: {
					publisherDid: PUBLISHER_DID,
					profileCid: "bafyprofile",
					baselineReleaseCid: null,
					verificationGeneration: 4,
					workloadIdentityDigest: await digestWorkloadIdentity(WORKLOAD_IDENTITY),
				},
			},
		});
	});

	it("accepts a workflow file ref that differs from the triggering run ref", async () => {
		const tagIdentity = structuredClone(WORKLOAD_IDENTITY);
		tagIdentity.run.ref = "refs/tags/v1.2.3";
		tagIdentity.run.refType = "tag";
		const tagPolicy = { ...WORKLOAD_POLICY, allowedRefs: ["refs/tags/*"] };

		await expect(
			evaluateVerifiedRelease(
				PUBLISHER_DID,
				await intent(proposedRelease(), tagIdentity),
				snapshot(),
				tagPolicy,
				verifierReport(),
			),
		).resolves.toMatchObject({ success: true });
	});

	it("preserves GitHub repository casing for builder and invocation identity", async () => {
		const mixedCaseIdentity = structuredClone(WORKLOAD_IDENTITY);
		mixedCaseIdentity.workflow.ref =
			"Example/Gallery/.github/workflows/release.yml@refs/heads/main";
		const report = verifierReport();
		if (!report.success) throw new Error("Expected successful fixture");
		report.value.provenance.sourceRepository = "https://github.com/Example/Gallery";
		report.value.provenance.builderId =
			"https://github.com/Example/Gallery/.github/workflows/release.yml@refs/heads/main";
		report.value.provenance.invocationId =
			"https://github.com/Example/Gallery/actions/runs/100/attempts/1";

		await expect(
			evaluateWorkloadAttestation(
				await intent(proposedRelease(), mixedCaseIdentity),
				WORKLOAD_POLICY,
				report.value.provenance,
			),
		).resolves.toEqual({ ok: true });
	});

	it("binds signed request URLs while retaining verified redirect destinations", async () => {
		const report = verifierReport();
		if (!report.success) throw new Error("Expected successful fixture");
		report.value.artifact.resolvedUrl = "https://cdn.example.test/gallery.tgz";
		report.value.provenance.resolvedUrl = "https://cdn.example.test/gallery.sigstore.json";
		const normalized = normalizeVerifierReport(report);
		const persisted = parseNormalizedVerifierReport(JSON.stringify(normalized));
		if (!persisted?.success) throw new Error("Expected persisted verifier report");

		await expect(
			evaluateVerifiedRelease(
				PUBLISHER_DID,
				await intent(),
				snapshot(),
				WORKLOAD_POLICY,
				persisted,
			),
		).resolves.toMatchObject({
			success: true,
			value: {
				verifier: {
					artifact: { resolvedUrl: "https://cdn.example.test/gallery.tgz" },
					provenance: {
						resolvedUrl: "https://cdn.example.test/gallery.sigstore.json",
					},
				},
			},
		});
	});

	it("requires approval when the signed profile says always", async () => {
		const profile = structuredClone(profileFixture) as PackageProfile.Main & {
			extensions: Record<string, { repository: string; releasePolicy?: Record<string, unknown> }>;
		};
		profile.extensions["com.emdashcms.experimental.package.profileExtension"]!.releasePolicy = {
			confirmation: "always",
			approvers: ["did:plc:approver"],
		};

		const result = await evaluateVerifiedRelease(
			PUBLISHER_DID,
			await intent(),
			snapshot(profile),
			WORKLOAD_POLICY,
			verifierReport(),
		);
		if (!result.success) throw new Error(`${result.code}:${result.reasonCode}`);
		expect(result).toMatchObject({ success: true, value: { requiresApproval: true } });
	});

	it("rejects verifier, artifact-manifest, and record substitutions", async () => {
		await expect(
			evaluateVerifiedRelease(PUBLISHER_DID, await intent(), snapshot(), WORKLOAD_POLICY, {
				success: false,
				error: { code: "CHECKSUM_MISMATCH", message: "mismatch" },
			}),
		).resolves.toMatchObject({ success: false, code: "VERIFIER_REJECTED" });
		const mismatched = verifierReport();
		if (!mismatched.success) throw new Error("Expected successful fixture");
		mismatched.value.artifact.manifest.declaredAccess = { network: { request: {} } };
		await expect(
			evaluateVerifiedRelease(
				PUBLISHER_DID,
				await intent(),
				snapshot(),
				WORKLOAD_POLICY,
				mismatched,
			),
		).resolves.toMatchObject({ success: false, code: "ARTIFACT_RECORD_MISMATCH" });
	});

	it.each([
		["repository ID", "repositoryId", "999999999", "ATTESTED_REPOSITORY_MISMATCH"],
		[
			"workflow",
			"builderId",
			`${PROVENANCE.sourceRepository}/.github/workflows/weaker.yml@refs/heads/main`,
			"ATTESTED_WORKFLOW_MISMATCH",
		],
		["ref", "workflowRef", "refs/heads/weaker", "ATTESTED_REF_MISMATCH"],
		["commit", "commitSha", "c".repeat(40), "ATTESTED_COMMIT_MISMATCH"],
		[
			"invocation",
			"invocationId",
			`${PROVENANCE.sourceRepository}/actions/runs/999/attempts/1`,
			"ATTESTED_INVOCATION_MISMATCH",
		],
	] as const)("rejects a mismatched attested %s", async (_name, field, value, reasonCode) => {
		const report = verifierReport();
		if (!report.success) throw new Error("Expected successful fixture");
		report.value.provenance[field] = value;

		await expect(
			evaluateVerifiedRelease(PUBLISHER_DID, await intent(), snapshot(), WORKLOAD_POLICY, report),
		).resolves.toMatchObject({ success: false, reasonCode });
	});

	it("rejects a mismatched run identity", async () => {
		const otherRun = structuredClone(WORKLOAD_IDENTITY);
		otherRun.run.id = "999";
		await expect(
			evaluateVerifiedRelease(
				PUBLISHER_DID,
				await intent(proposedRelease(), otherRun),
				snapshot(),
				WORKLOAD_POLICY,
				verifierReport(),
			),
		).resolves.toMatchObject({ success: false, reasonCode: "ATTESTED_INVOCATION_MISMATCH" });
	});

	it.each([
		["malformed", '{"issuer":"github-actions"}', null],
		["non-canonical", JSON.stringify(WORKLOAD_IDENTITY, null, 2), null],
		["digest-mismatched", JSON.stringify(WORKLOAD_IDENTITY), "A".repeat(43)],
	] as const)("rejects %s stored workload identity state", async (_name, json, digestOverride) => {
		const invalid = await intent();
		invalid.workloadIdentityJson = json;
		invalid.workloadIdentityDigest =
			digestOverride ?? (await digestWorkloadIdentity(WORKLOAD_IDENTITY));
		await expect(
			evaluateVerifiedRelease(
				PUBLISHER_DID,
				invalid,
				snapshot(),
				WORKLOAD_POLICY,
				verifierReport(),
			),
		).resolves.toMatchObject({ success: false, reasonCode: "WORKLOAD_IDENTITY_INVALID" });
	});
});
