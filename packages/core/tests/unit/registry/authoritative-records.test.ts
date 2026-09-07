import {
	createFakePublisherFixture,
	type FakePublisher,
	type FakePublisherFixture,
} from "@emdash-cms/atproto-test-utils";
import type { ProvenanceVerifier } from "@emdash-cms/registry-verification";
import { computeMultihash, decodeMultihash } from "@emdash-cms/registry-verification/checksum";
import { describe, expect, it, vi } from "vitest";

import {
	readAuthoritativePackageRelease,
	verifyAuthoritativePackageRelease,
	type AuthoritativeRecordReadOptions,
} from "../../../src/registry/authoritative-records.js";
import { hasCurrentRecordLabel } from "../../../src/registry/record-labels.js";

const PUBLISHER_DID = "did:plc:records0000000000000000";
const PROFILE_NSID = "com.emdashcms.experimental.package.profile";
const RELEASE_NSID = "com.emdashcms.experimental.package.release";
const PROVENANCE_URL = "https://artifacts.example.test/provenance.json";
const REPOSITORY = "https://github.com/example/gallery";
const BUILDER_ID =
	"https://github.com/example/gallery/.github/workflows/release.yml@refs/heads/main";
const encoder = new TextEncoder();

interface RecordHarness {
	fixture: FakePublisherFixture;
	publisher: FakePublisher;
	options: AuthoritativeRecordReadOptions;
}

async function createHarness(records?: {
	profile?: Record<string, unknown>;
	release?: Record<string, unknown>;
}): Promise<RecordHarness> {
	const fixture = createFakePublisherFixture();
	const publisher = await fixture.createPublisher({ did: PUBLISHER_DID });
	const profile = records?.profile ?? profileRecord();
	const release = records?.release ?? releaseRecord();
	await publisher.repo.putRecord(PROFILE_NSID, "gallery", profile);
	await publisher.repo.putRecord(RELEASE_NSID, "gallery:1.0.0", release);
	const options: AuthoritativeRecordReadOptions = {
		didDocumentResolver: {
			async resolve(did) {
				const document = fixture.didResolver.resolve(did);
				if (!document) throw new Error("DID not found");
				return document;
			},
		},
		fetch: async (input, init) => {
			const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
			return fixture.pds.handle(`${url.pathname}${url.search}`, init);
		},
	};
	return { fixture, publisher, options };
}

function profileRecord(
	overrides: Record<string, unknown> = {},
	policy: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		$type: PROFILE_NSID,
		id: `at://${PUBLISHER_DID}/${PROFILE_NSID}/gallery`,
		slug: "gallery",
		type: "emdash-plugin",
		name: "Gallery",
		license: "MIT",
		authors: [{ name: "Test Publisher" }],
		security: [{ email: "security@example.test" }],
		extensions: {
			"com.emdashcms.experimental.package.profileExtension": {
				$type: "com.emdashcms.experimental.package.profileExtension",
				repository: "https://github.com/example/gallery",
				releasePolicy: policy,
			},
		},
		...overrides,
	};
}

function releaseRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		$type: RELEASE_NSID,
		package: "gallery",
		version: "1.0.0",
		artifacts: {
			package: {
				url: "https://artifacts.example.test/gallery-1.0.0.tar.gz",
				checksum: "bciqexample",
			},
		},
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess: { content: { read: {} } },
			},
		},
		...overrides,
	};
}

async function checksumAndDigest(bytes: Uint8Array): Promise<{
	checksum: string;
	digest: Uint8Array;
}> {
	const computed = await computeMultihash(bytes);
	if (!computed.success) throw new Error(computed.error.message);
	const decoded = decodeMultihash(computed.value);
	if (!decoded.success) throw new Error(decoded.error.message);
	return { checksum: computed.value, digest: decoded.value.digest };
}

function releaseWithProvenance(
	artifactChecksum: string,
	provenanceChecksum: string,
	provenanceUrl = PROVENANCE_URL,
): Record<string, unknown> {
	return releaseRecord({
		artifacts: {
			package: {
				url: "https://artifacts.example.test/gallery-1.0.0.tar.gz",
				checksum: artifactChecksum,
			},
		},
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess: {},
				provenance: {
					predicateType: "https://slsa.dev/provenance/v1",
					url: provenanceUrl,
					checksum: provenanceChecksum,
					sourceRepository: REPOSITORY,
					builderId: BUILDER_ID,
				},
			},
		},
	});
}

describe("readAuthoritativePackageRelease", () => {
	it("verifies signed PDS records and returns their exact CIDs and normalized policy", async () => {
		const harness = await createHarness({
			profile: profileRecord({}, { confirmation: "always", approvers: [PUBLISHER_DID] }),
		});

		const result = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);

		expect(result).toMatchObject({
			success: true,
			value: {
				profile: { rkey: "gallery", cid: expect.stringMatching(/^b/) },
				release: { rkey: "gallery:1.0.0", cid: expect.stringMatching(/^b/) },
				inspection: {
					status: "inspected",
					provenance: { status: "not-checked" },
					value: {
						repository: "https://github.com/example/gallery",
						policy: {
							requireProvenance: false,
							confirmation: "always",
							approvers: [PUBLISHER_DID],
						},
					},
				},
			},
		});
	});

	it("enforces required provenance from the signed profile policy", async () => {
		const harness = await createHarness({
			profile: profileRecord({}, { requireProvenance: true }),
		});

		const records = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);
		expect(records.success).toBe(true);
		if (!records.success) return;
		await expect(
			verifyAuthoritativePackageRelease(records.value, new Uint8Array(), harness.options),
		).resolves.toMatchObject({
			success: false,
			code: "PROVENANCE_REQUIRED",
		});
	});

	it("rejects a signed profile whose embedded identity was substituted", async () => {
		const harness = await createHarness({
			profile: profileRecord({
				id: `at://did:plc:other/${PROFILE_NSID}/gallery`,
			}),
		});

		await expect(
			readAuthoritativePackageRelease(PUBLISHER_DID, "gallery", "1.0.0", harness.options),
		).resolves.toMatchObject({
			success: false,
			error: { code: "PROFILE_ID_MISMATCH" },
		});
	});

	it("rejects a signed release whose package was substituted", async () => {
		const harness = await createHarness({
			release: releaseRecord({ package: "other" }),
		});

		await expect(
			readAuthoritativePackageRelease(PUBLISHER_DID, "gallery", "1.0.0", harness.options),
		).resolves.toMatchObject({
			success: false,
			error: { code: "RELEASE_PACKAGE_MISMATCH" },
		});
	});

	it("fetches and verifies supplied provenance against the artifact digest", async () => {
		const artifact = await checksumAndDigest(encoder.encode("artifact"));
		const provenanceDocument = encoder.encode("{}");
		const provenance = await checksumAndDigest(provenanceDocument);
		const harness = await createHarness({
			release: releaseWithProvenance(artifact.checksum, provenance.checksum),
		});
		const records = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);
		expect(records.success).toBe(true);
		if (!records.success) return;
		const verify = vi.fn<ProvenanceVerifier["verify"]>(async (input) => ({
			success: true,
			value: {
				predicateType: "https://slsa.dev/provenance/v1",
				artifactDigest: input.artifactDigest,
				sourceRepository: REPOSITORY,
				builderId: BUILDER_ID,
			},
		}));
		const provenanceFetch = vi.fn(() =>
			Promise.resolve(new Response(provenanceDocument, { status: 200 })),
		);

		const report = await verifyAuthoritativePackageRelease(records.value, artifact.digest, {
			...harness.options,
			provenanceFetch,
			resolveHostname: async () => ["93.184.216.34"],
			provenanceVerifier: { verify },
		});

		expect(report).toMatchObject({
			success: true,
			status: "verified",
			provenance: { status: "verified" },
		});
		expect(provenanceFetch).toHaveBeenCalledOnce();
		expect(verify).toHaveBeenCalledOnce();
	});

	it("rejects a provenance document whose bytes do not match its signed checksum", async () => {
		const artifact = await checksumAndDigest(encoder.encode("artifact"));
		const expectedProvenance = await checksumAndDigest(encoder.encode("expected"));
		const harness = await createHarness({
			release: releaseWithProvenance(artifact.checksum, expectedProvenance.checksum),
		});
		const records = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);
		expect(records.success).toBe(true);
		if (!records.success) return;
		const verify = vi.fn<ProvenanceVerifier["verify"]>();

		const report = await verifyAuthoritativePackageRelease(records.value, artifact.digest, {
			...harness.options,
			provenanceFetch: () =>
				Promise.resolve(new Response(encoder.encode("substituted"), { status: 200 })),
			resolveHostname: async () => ["93.184.216.34"],
			provenanceVerifier: { verify },
		});

		expect(report).toMatchObject({ success: false, code: "CHECKSUM_MISMATCH" });
		expect(verify).not.toHaveBeenCalled();
	});

	it("rejects an unavailable supplied provenance document even when policy makes it optional", async () => {
		const artifact = await checksumAndDigest(encoder.encode("artifact"));
		const provenance = await checksumAndDigest(encoder.encode("{}"));
		const harness = await createHarness({
			release: releaseWithProvenance(artifact.checksum, provenance.checksum),
		});
		const records = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);
		expect(records.success).toBe(true);
		if (!records.success) return;

		const report = await verifyAuthoritativePackageRelease(records.value, artifact.digest, {
			...harness.options,
			provenanceFetch: () => Promise.resolve(new Response(null, { status: 404 })),
			resolveHostname: async () => ["93.184.216.34"],
		});

		expect(report).toMatchObject({ success: false, code: "RESOURCE_STATUS_ERROR" });
	});

	it("rejects a supplied provenance URL targeting a local host", async () => {
		const artifact = await checksumAndDigest(encoder.encode("artifact"));
		const provenance = await checksumAndDigest(encoder.encode("{}"));
		const harness = await createHarness({
			release: releaseWithProvenance(
				artifact.checksum,
				provenance.checksum,
				"https://localhost/provenance.json",
			),
		});
		const records = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);
		expect(records.success).toBe(true);
		if (!records.success) return;

		const report = await verifyAuthoritativePackageRelease(records.value, artifact.digest, {
			...harness.options,
			provenanceFetch: () => {
				throw new Error("local provenance must not be fetched");
			},
			resolveHostname: async () => ["127.0.0.1"],
		});

		expect(report).toMatchObject({ success: false, code: "HOST_REJECTED" });
	});

	it("rejects provenance whose source or builder evidence cannot be verified", async () => {
		const artifact = await checksumAndDigest(encoder.encode("artifact"));
		const provenanceDocument = encoder.encode("{}");
		const provenance = await checksumAndDigest(provenanceDocument);
		const harness = await createHarness({
			release: releaseWithProvenance(artifact.checksum, provenance.checksum),
		});
		const records = await readAuthoritativePackageRelease(
			PUBLISHER_DID,
			"gallery",
			"1.0.0",
			harness.options,
		);
		expect(records.success).toBe(true);
		if (!records.success) return;
		const provenanceVerifier: ProvenanceVerifier = {
			verify: async () => ({
				success: false,
				error: {
					code: "PROVENANCE_UNVERIFIABLE",
					message: "The provenance source or builder does not match the signed release.",
				},
			}),
		};

		const report = await verifyAuthoritativePackageRelease(records.value, artifact.digest, {
			...harness.options,
			provenanceFetch: () => Promise.resolve(new Response(provenanceDocument, { status: 200 })),
			resolveHostname: async () => ["93.184.216.34"],
			provenanceVerifier,
		});

		expect(report).toMatchObject({ success: false, code: "PROVENANCE_UNVERIFIABLE" });
	});
});

describe("hasCurrentRecordLabel", () => {
	const record = {
		uri: `at://${PUBLISHER_DID}/${PROFILE_NSID}/gallery`,
		cid: "bafy-current",
	};

	it("applies a live positive label only to its exact record CID", () => {
		const base = {
			src: "did:plc:labeler",
			uri: record.uri,
			cid: record.cid,
			val: "security:yanked",
		};
		expect(hasCurrentRecordLabel([base], "security:yanked", record)).toBe(true);
		expect(hasCurrentRecordLabel([{ ...base, cid: "bafy-stale" }], "security:yanked", record)).toBe(
			false,
		);
		expect(
			hasCurrentRecordLabel(
				[{ ...base, uri: "at://did:plc:other/x/y" }],
				"security:yanked",
				record,
			),
		).toBe(false);
	});

	it("ignores negated, expired, and malformed-expiry labels", () => {
		const base = { uri: record.uri, cid: record.cid, val: "security:yanked" };
		expect(hasCurrentRecordLabel([{ ...base, neg: true }], "security:yanked", record)).toBe(false);
		expect(
			hasCurrentRecordLabel(
				[{ ...base, exp: "2026-01-01T00:00:00.000Z" }],
				"security:yanked",
				record,
				Date.parse("2026-02-01T00:00:00.000Z"),
			),
		).toBe(false);
		expect(hasCurrentRecordLabel([{ ...base, exp: "invalid" }], "security:yanked", record)).toBe(
			false,
		);
	});
});
