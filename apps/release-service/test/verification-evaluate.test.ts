import type { PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it } from "vitest";

import profileFixture from "../../../packages/registry-verification/fixtures/records/profile.json";
import releaseFixture from "../../../packages/registry-verification/fixtures/records/release.json";
import type { ReleaseVerificationReport } from "../../release-verifier/src/verify.js";
import type { StoredIntent } from "../src/publisher-do/publisher-do.js";
import {
	evaluateVerifiedRelease,
	normalizeVerifierReport,
	parseNormalizedVerifierReport,
	prepareVerifierInput,
} from "../src/verification/evaluate.js";
import type { PublisherVerificationSnapshot } from "../src/verification/pds.js";

const PUBLISHER_DID = "did:plc:publisher";
const ARTIFACT_CHECKSUM = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const PROVENANCE = {
	predicateType: "https://slsa.dev/provenance/v1",
	url: "https://github.com/example/gallery/attestation.sigstore.json",
	checksum: "bciqkkpvkbtfcwq6kjkbq3kgjxe5j6ihzkxlfxkzqhwzaaaa3wkbq3a",
	sourceRepository: "https://github.com/example/gallery",
	builderId: "https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main",
} as const;

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

function intent(release = proposedRelease()): StoredIntent {
	return {
		id: "01JABCDEFGHJKMNPQRSTVWXYZ0",
		packageSlug: "gallery",
		version: "1.2.3",
		state: "verifying",
		stateGeneration: 2,
		workloadPolicyVersion: 1,
		workloadIdentityDigest: "A".repeat(43),
		requestDigest: "B".repeat(43),
		workloadIdentityJson: JSON.stringify({ issuer: "github-actions" }),
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
				artifactDigest: new Uint8Array(32),
			},
		},
	};
}

describe("verification evaluation", () => {
	it("prepares the isolated verifier request from signed inputs", () => {
		expect(prepareVerifierInput(intent(), snapshot())).toEqual({
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
			intent(),
			snapshot(),
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
					workloadIdentityDigest: "A".repeat(43),
				},
			},
		});
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
			evaluateVerifiedRelease(PUBLISHER_DID, intent(), snapshot(), persisted),
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
			intent(),
			snapshot(profile),
			verifierReport(),
		);
		if (!result.success) throw new Error(`${result.code}:${result.reasonCode}`);
		expect(result).toMatchObject({ success: true, value: { requiresApproval: true } });
	});

	it("rejects verifier, artifact-manifest, and record substitutions", async () => {
		await expect(
			evaluateVerifiedRelease(PUBLISHER_DID, intent(), snapshot(), {
				success: false,
				error: { code: "CHECKSUM_MISMATCH", message: "mismatch" },
			}),
		).resolves.toMatchObject({ success: false, code: "VERIFIER_REJECTED" });
		const mismatched = verifierReport();
		if (!mismatched.success) throw new Error("Expected successful fixture");
		mismatched.value.artifact.manifest.declaredAccess = { network: { request: {} } };
		await expect(
			evaluateVerifiedRelease(PUBLISHER_DID, intent(), snapshot(), mismatched),
		).resolves.toMatchObject({ success: false, code: "ARTIFACT_RECORD_MISMATCH" });
	});
});
