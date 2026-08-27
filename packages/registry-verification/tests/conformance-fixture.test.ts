import { describe, expect, it } from "vitest";

import { createDelegatedReleaseConformanceFixture } from "../fixtures/conformance/delegated-release.js";
import {
	validatePluginBundle,
	verifyMultihash,
	verifyPackageReleaseRecords,
} from "../src/index.js";

describe("delegated release conformance fixture", () => {
	it("passes the shared service and installer verification contracts", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		await expect(
			verifyMultihash(fixture.artifactBytes, fixture.artifactChecksum),
		).resolves.toMatchObject({ success: true });
		await expect(
			validatePluginBundle(fixture.artifactBytes, {
				expectedSlug: fixture.packageSlug,
				expectedVersion: fixture.version,
			}),
		).resolves.toMatchObject({
			success: true,
			value: {
				declaredAccess: { content: { read: {} } },
			},
		});
		await expect(
			verifyPackageReleaseRecords({
				publisherDid: fixture.publisherDid,
				package: fixture.packageSlug,
				version: fixture.version,
				rkey: fixture.packageSlug + ":" + fixture.version,
				profile: fixture.profile,
				release: fixture.release,
				provenance: {
					document: fixture.provenanceDocument,
					artifactDigest: fixture.artifactDigest,
					verifier: fixture.provenanceVerifier,
				},
			}),
		).resolves.toMatchObject({
			success: true,
			status: "verified",
			value: {
				repository: fixture.expected.repository,
				verifiedProvenance: {
					builderId: fixture.expected.builderId,
					predicateType: fixture.expected.predicateType,
				},
			},
		});
	});

	it("fails when the signed release substitutes provenance source identity", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture({
			provenance: { sourceRepository: "https://github.com/attacker/gallery" },
		});
		await expect(
			verifyPackageReleaseRecords({
				publisherDid: fixture.publisherDid,
				package: fixture.packageSlug,
				version: fixture.version,
				rkey: fixture.packageSlug + ":" + fixture.version,
				profile: fixture.profile,
				release: fixture.release,
				provenance: {
					document: fixture.provenanceDocument,
					artifactDigest: fixture.artifactDigest,
					verifier: fixture.provenanceVerifier,
				},
			}),
		).resolves.toMatchObject({ success: false, code: "PROVENANCE_UNVERIFIABLE" });
	});
});
