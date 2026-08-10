import type { PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import { describe, expect, it, vi } from "vitest";

import profileFixture from "../fixtures/records/profile.json";
import releaseFixture from "../fixtures/records/release.json";
import type {
	ProvenanceVerifier,
	RecordVerificationInput,
	ReleaseProvenance,
	VerifiedProvenance,
} from "../src/index.js";
import { verifyPackageReleaseRecords } from "../src/index.js";

const publisherDid = "did:plc:publisher";
const packageSlug = "gallery";
const version = "1.2.3";
const rkey = `${packageSlug}:${version}`;
const repository = "https://github.com/example/gallery";
const provenance: ReleaseProvenance = {
	predicateType: "https://slsa.dev/provenance/v1",
	url: "https://github.com/example/gallery/attestation.sigstore.json",
	checksum: "bciqkkpvkbtfcwq6kjkbq3kgjxe5j6ihzkxlfxkzqhwzaaaa3wkbq3a",
	sourceRepository: repository,
	builderId: `${repository}/.github/workflows/release.yml@refs/heads/main`,
};
const artifactChecksum = "bciqcz4snxjp3biyoe3udwkwfxhrj4gywdzob7j2clzzqim3csofzqja";
const artifactDigest = Uint8Array.of(
	44,
	242,
	77,
	186,
	95,
	176,
	163,
	14,
	38,
	232,
	59,
	42,
	197,
	185,
	226,
	158,
	27,
	22,
	30,
	92,
	31,
	167,
	66,
	94,
	115,
	4,
	51,
	98,
	147,
	139,
	152,
	36,
);
const provenanceDocument = Uint8Array.of(4, 5, 6);

describe("verifyPackageReleaseRecords", () => {
	it("validates records and normalizes an absent policy to its defaults", async () => {
		const report = await verify();

		expect(report).toMatchObject({
			success: true,
			status: "unattested",
			code: "PROVENANCE_ABSENT_OPTIONAL",
			provenance: { status: "absent-optional" },
			value: {
				repository,
				policy: {
					requireProvenance: false,
					confirmation: "escalation-only",
					approvers: [],
				},
			},
		});
	});

	it.each([
		["profile", { profile: { nope: true } }, "PROFILE_LEXICON_INVALID"],
		["release", { release: { nope: true } }, "RELEASE_LEXICON_INVALID"],
	])("fails closed on malformed %s data", async (_name, override, code) => {
		expect(await verify(override)).toMatchObject({ success: false, status: "failed", code });
	});

	it("requires the profile id to resolve to the expected signed record", async () => {
		const profile = cloneProfile();
		profile.id = profile.id.replace("/gallery", "/other");
		expect(await verify({ profile })).toMatchObject({
			success: false,
			code: "PROFILE_ID_MISMATCH",
		});
	});

	it.each([
		["package", { release: { ...releaseFixture, package: "other" } }, "RELEASE_PACKAGE_MISMATCH"],
		["rkey", { rkey: "gallery:9.9.9" }, "RELEASE_RKEY_MISMATCH"],
		["version", { version: "9.9.9" }, "RELEASE_VERSION_MISMATCH"],
	])("rejects a release %s mismatch", async (_name, override, code) => {
		expect(await verify(override)).toMatchObject({ success: false, code });
	});

	it("rejects malformed semver even when the rkey matches", async () => {
		const release = cloneRelease();
		release.version = "01.2.3";
		expect(await verify({ release, version: "01.2.3", rkey: "gallery:01.2.3" })).toMatchObject({
			success: false,
			code: "RELEASE_VERSION_INVALID",
		});
	});

	it("rejects semver that cannot participate in baseline comparison", async () => {
		const unsafeVersion = "9007199254740992.0.0";
		const release = cloneRelease();
		release.version = unsafeVersion;
		expect(
			await verify({ release, version: unsafeVersion, rkey: `gallery:${unsafeVersion}` }),
		).toMatchObject({
			success: false,
			code: "RELEASE_VERSION_INVALID",
		});
	});

	it.each([
		"http://github.com/example/gallery",
		"https://github.com/example/gallery/",
		"https://GITHUB.com/example/gallery",
		"https://github.com/example/gallery?ref=main",
	])("rejects a non-canonical repository anchor: %s", async (repositoryValue) => {
		const profile = cloneProfile();
		profile.extensions["com.emdashcms.experimental.package.profileExtension"].repository =
			repositoryValue;
		expect(await verify({ profile })).toMatchObject({
			success: false,
			code: "PROFILE_REPOSITORY_INVALID",
		});
	});

	it("rejects unknown policy values and duplicate approvers", async () => {
		const profile = cloneProfile();
		profile.extensions["com.emdashcms.experimental.package.profileExtension"].releasePolicy = {
			confirmation: "manual-review",
			approvers: [publisherDid, publisherDid],
		};
		expect(await verify({ profile })).toMatchObject({
			success: false,
			code: "PROFILE_POLICY_INVALID",
		});
	});

	it("distinguishes absent required provenance", async () => {
		const profile = cloneProfile();
		profile.extensions["com.emdashcms.experimental.package.profileExtension"].releasePolicy = {
			requireProvenance: true,
		};
		expect(await verify({ profile })).toMatchObject({
			success: false,
			code: "PROVENANCE_REQUIRED",
			provenance: { status: "absent-required" },
		});
	});

	it("accepts present and valid provenance", async () => {
		const release = withProvenance();
		const verifier = verifierReturning({
			success: true,
			value: {
				predicateType: "https://slsa.dev/provenance/v1",
				artifactDigest,
				sourceRepository: repository,
				builderId: provenance.builderId,
			},
		});

		const report = await verify({
			release,
			provenance: { document: provenanceDocument, artifactDigest, verifier },
		});

		expect(report).toMatchObject({
			success: true,
			status: "verified",
			code: "VERIFIED",
			provenance: { status: "verified" },
		});
		expect(verifier.verify).toHaveBeenCalledWith({
			document: provenanceDocument,
			reference: provenance,
			artifactDigest,
			profileRepository: repository,
		});
	});

	it("binds provenance evidence to the signed package artifact checksum", async () => {
		const verifier = verifierReturning({
			success: true,
			value: {
				predicateType: "https://slsa.dev/provenance/v1",
				artifactDigest,
				sourceRepository: repository,
				builderId: provenance.builderId,
			},
		});

		expect(
			await verify({
				release: withProvenance(),
				provenance: {
					document: provenanceDocument,
					artifactDigest: Uint8Array.of(1, 2, 3),
					verifier,
				},
			}),
		).toMatchObject({ success: false, code: "CHECKSUM_MISMATCH" });
		expect(verifier.verify).not.toHaveBeenCalled();
	});

	it.each([
		["missing verification evidence", undefined],
		[
			"failed verifier result",
			{
				document: provenanceDocument,
				artifactDigest,
				verifier: verifierReturning({
					success: false,
					error: {
						code: "PROVENANCE_UNVERIFIABLE",
						message: "The supplied provenance could not be verified.",
					},
				}),
			},
		],
	] as const)("rejects present provenance with %s", async (_name, evidence) => {
		expect(await verify({ release: withProvenance(), provenance: evidence })).toMatchObject({
			success: false,
			code: "PROVENANCE_UNVERIFIABLE",
			provenance: { status: "failed" },
		});
	});

	it("converts a throwing provenance adapter into the stable failed report", async () => {
		const verifier: ProvenanceVerifier = {
			verify: vi.fn().mockRejectedValue(new Error("upstream details")),
		};
		expect(
			await verify({
				release: withProvenance(),
				provenance: { document: provenanceDocument, artifactDigest, verifier },
			}),
		).toMatchObject({
			success: false,
			code: "PROVENANCE_UNVERIFIABLE",
			provenance: { status: "failed" },
		});
	});
});

function verify(override: Partial<RecordVerificationInput> = {}) {
	return verifyPackageReleaseRecords({
		publisherDid,
		package: packageSlug,
		version,
		rkey,
		profile: cloneProfile(),
		release: cloneRelease(),
		...override,
	});
}

function cloneProfile() {
	return structuredClone(profileFixture) as PackageProfile.Main & {
		extensions: Record<
			string,
			{
				repository: string;
				releasePolicy?: {
					requireProvenance?: boolean;
					confirmation?: string;
					approvers?: string[];
				};
			}
		>;
	};
}

function cloneRelease() {
	return structuredClone(releaseFixture) as PackageRelease.Main & {
		extensions: Record<string, { provenance?: ReleaseProvenance }>;
	};
}

function withProvenance() {
	const release = cloneRelease();
	release.artifacts.package.checksum = artifactChecksum;
	release.extensions["com.emdashcms.experimental.package.releaseExtension"].provenance = provenance;
	return release;
}

function verifierReturning(
	result:
		| { success: true; value: VerifiedProvenance }
		| {
				success: false;
				error: {
					code: "PROVENANCE_UNVERIFIABLE";
					message: string;
				};
		  },
): ProvenanceVerifier & { verify: ReturnType<typeof vi.fn> } {
	return { verify: vi.fn().mockResolvedValue(result) };
}
