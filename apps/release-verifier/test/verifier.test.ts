import {
	computeMultihash,
	type ProvenanceVerificationInput,
	type ProvenanceVerifier,
} from "@emdash-cms/registry-verification";
import { exports } from "cloudflare:workers";
import { packTar, type TarEntry } from "modern-tar";
import { describe, expect, it, vi } from "vitest";

import { createDelegatedReleaseConformanceFixture } from "../../../packages/registry-verification/fixtures/conformance/delegated-release.js";
import { resolvePublicHostname } from "../src/dns.js";
import {
	verifyArtifact,
	verifyRelease,
	verifyReleaseBytes,
	type VerifyReleaseInput,
} from "../src/verify.js";

const encoder = new TextEncoder();
const ARTIFACT_URL = "https://artifact.example.test/plugin.tgz";
const VERIFIED_IDENTITY = {
	repositoryId: "123456789",
	workflowRef: "refs/heads/main",
	commitSha: "b".repeat(40),
	invocationId: "https://github.com/emdash-cms/gallery/actions/runs/100/attempts/1",
} as const;

function file(name: string, body: string): TarEntry {
	const bytes = encoder.encode(body);
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function validBundle(): Promise<Uint8Array> {
	const manifest = {
		id: "gallery",
		version: "1.2.3",
		capabilities: ["write:content"],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
	};
	return gzip(
		await packTar([
			file("manifest.json", JSON.stringify(manifest)),
			file("backend.js", "export default {};"),
			file("admin.js", "export default {};"),
		]),
	);
}

async function checksum(bytes: Uint8Array): Promise<string> {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new Error(result.error.code);
	return result.value;
}

describe("isolated release verifier", () => {
	it("fetches, checksums, and validates a bundle without returning file bytes", async () => {
		const bytes = await validBundle();
		const fetchImplementation = vi.fn(async () => new Response(bytes));
		const result = await verifyArtifact(
			{
				url: ARTIFACT_URL,
				checksum: await checksum(bytes),
				packageSlug: "gallery",
				version: "1.2.3",
			},
			{
				fetch: fetchImplementation,
				resolveHostname: async () => ["203.0.113.5"],
			},
		);

		expect(result).toMatchObject({
			success: true,
			value: {
				requestedUrl: ARTIFACT_URL,
				resolvedUrl: ARTIFACT_URL,
				compressedBytes: bytes.byteLength,
				manifest: {
					id: "gallery",
					version: "1.2.3",
					declaredAccess: { content: { read: {}, write: {} } },
				},
				bundle: {
					backendBytes: encoder.encode("export default {};").byteLength,
					adminBytes: encoder.encode("export default {};").byteLength,
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("export default");
	});

	it("reports signed and resolved URLs separately after safe redirects", async () => {
		const bytes = await validBundle();
		const provenanceDocument = encoder.encode('{"sigstore":"bundle"}');
		const resolvedArtifactUrl = "https://cdn.example.test/plugin.tgz";
		const provenanceUrl = "https://provenance.example.test/bundle.json";
		const resolvedProvenanceUrl = "https://cdn.example.test/bundle.json";
		const result = await verifyRelease(
			{
				artifact: {
					url: ARTIFACT_URL,
					checksum: await checksum(bytes),
					packageSlug: "gallery",
					version: "1.2.3",
				},
				provenance: {
					url: provenanceUrl,
					checksum: await checksum(provenanceDocument),
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: "https://github.com/emdash-cms/gallery",
					builderId:
						"https://github.com/emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
				},
				profileRepository: "https://github.com/emdash-cms/gallery",
			},
			{
				fetch: async (url) => {
					const href = url.toString();
					if (href === ARTIFACT_URL) {
						return new Response(null, { status: 302, headers: { location: resolvedArtifactUrl } });
					}
					if (href === resolvedArtifactUrl) return new Response(bytes);
					if (href === provenanceUrl) {
						return new Response(null, {
							status: 302,
							headers: { location: resolvedProvenanceUrl },
						});
					}
					return new Response(provenanceDocument);
				},
				resolveHostname: async () => ["203.0.113.5"],
				provenanceVerifier: {
					async verify(input) {
						return {
							success: true,
							value: {
								predicateType: "https://slsa.dev/provenance/v1",
								artifactDigest: input.artifactDigest,
								sourceRepository: input.profileRepository,
								builderId: input.reference.builderId,
								...VERIFIED_IDENTITY,
							},
						};
					},
				},
			},
		);

		expect(result).toMatchObject({
			success: true,
			value: {
				artifact: { requestedUrl: ARTIFACT_URL, resolvedUrl: resolvedArtifactUrl },
				provenance: { requestedUrl: provenanceUrl, resolvedUrl: resolvedProvenanceUrl },
			},
		});
	});

	it("verifies artifact and provenance in one isolated invocation with all digest candidates", async () => {
		const bytes = await validBundle();
		const provenanceDocument = encoder.encode('{"sigstore":"bundle"}');
		let received: ProvenanceVerificationInput | undefined;
		const provenanceVerifier: ProvenanceVerifier = {
			async verify(input) {
				received = input;
				return {
					success: true,
					value: {
						predicateType: "https://slsa.dev/provenance/v1",
						artifactDigest: input.artifactDigests?.[1] ?? input.artifactDigest,
						sourceRepository: "https://github.com/emdash-cms/gallery",
						builderId:
							"https://github.com/emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
						...VERIFIED_IDENTITY,
					},
				};
			},
		};
		const result = await verifyRelease(
			{
				artifact: {
					url: ARTIFACT_URL,
					checksum: await checksum(bytes),
					packageSlug: "gallery",
					version: "1.2.3",
				},
				provenance: {
					$type: "com.emdashcms.experimental.package.releaseExtension#provenance",
					url: "https://provenance.example.test/bundle.json",
					checksum: await checksum(provenanceDocument),
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: "https://github.com/emdash-cms/gallery",
					builderId:
						"https://github.com/emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main",
				},
				profileRepository: "https://github.com/emdash-cms/gallery",
			},
			{
				fetch: async (url) =>
					new Response(url.hostname === "artifact.example.test" ? bytes : provenanceDocument),
				resolveHostname: async () => ["203.0.113.5"],
				provenanceVerifier,
			},
		);

		expect(result).toMatchObject({
			success: true,
			value: {
				artifact: { manifest: { id: "gallery", version: "1.2.3" } },
				provenance: {
					documentBytes: provenanceDocument.byteLength,
					predicateType: "https://slsa.dev/provenance/v1",
				},
			},
		});
		expect(received?.artifactDigest).toHaveLength(32);
		expect(received?.artifactDigests?.map((digest) => digest.byteLength)).toEqual([48, 64]);
		if (result.success) {
			expect(result.value.provenance.artifactDigest).toEqual(received?.artifactDigests?.[1]);
		}
		expect(JSON.stringify(result)).not.toContain("export default");
	});

	it("verifies private staged bytes without network egress", async () => {
		const artifactBytes = await validBundle();
		const provenanceBytes = encoder.encode('{"sigstore":"private-stage"}');
		const input: VerifyReleaseInput = {
			artifact: {
				url: `https://release.example.com/v1/staged-artifacts/package/${await checksum(artifactBytes)}`,
				checksum: await checksum(artifactBytes),
				packageSlug: "gallery",
				version: "1.2.3",
			},
			provenance: {
				url: `https://release.example.com/v1/provenance/${await checksum(provenanceBytes)}`,
				checksum: await checksum(provenanceBytes),
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: "https://github.com/emdash-cms/gallery",
				builderId:
					"https://github.com/emdash-cms/gallery/.github/workflows/emdash-release.yml@refs/heads/main",
			},
			profileRepository: "https://github.com/emdash-cms/gallery",
		};
		const result = await verifyReleaseBytes(input, artifactBytes, provenanceBytes, {
			async verify(candidate) {
				return {
					success: true,
					value: {
						predicateType: "https://slsa.dev/provenance/v1",
						artifactDigest: candidate.artifactDigest,
						sourceRepository: candidate.profileRepository,
						builderId: candidate.reference.builderId,
						...VERIFIED_IDENTITY,
					},
				};
			},
		});

		expect(result).toMatchObject({
			success: true,
			value: {
				artifact: { requestedUrl: input.artifact.url, resolvedUrl: input.artifact.url },
				provenance: {
					requestedUrl: input.provenance.url,
					resolvedUrl: input.provenance.url,
				},
			},
		});
	});

	it("uses a release-specific message for unexpected provenance failures", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const result = await verifyRelease(fixture.serviceInput, {
			fetch: async (url) =>
				new Response(
					url.toString() === fixture.artifactUrl
						? fixture.artifactBytes
						: fixture.provenanceDocument,
				),
			resolveHostname: async () => ["203.0.113.5"],
			provenanceVerifier: {
				verify() {
					throw new Error("unexpected verifier failure");
				},
			},
		});

		expect(result).toEqual({
			success: false,
			error: { code: "VERIFIER_INTERNAL_ERROR", message: "Release verification failed" },
		});
	});

	it("rejects provenance reports without verified workload identity", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const result = await verifyRelease(fixture.serviceInput, {
			fetch: async (url) =>
				new Response(
					url.toString() === fixture.artifactUrl
						? fixture.artifactBytes
						: fixture.provenanceDocument,
				),
			resolveHostname: async () => ["203.0.113.5"],
			provenanceVerifier: {
				async verify(input) {
					return {
						success: true,
						value: {
							predicateType: "https://slsa.dev/provenance/v1",
							artifactDigest: input.artifactDigest,
							sourceRepository: input.profileRepository,
							builderId: input.reference.builderId,
						},
					};
				},
			},
		});

		expect(result).toEqual({
			success: false,
			error: { code: "VERIFIER_INTERNAL_ERROR", message: "Release verification failed" },
		});
	});

	it("matches the shared delegated-release service output contract", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const result = await verifyRelease(fixture.serviceInput, {
			fetch: async (url) =>
				new Response(
					url.toString() === fixture.artifactUrl
						? fixture.artifactBytes
						: fixture.provenanceDocument,
				),
			resolveHostname: async () => ["203.0.113.5"],
			provenanceVerifier: fixture.provenanceVerifier,
		});

		expect(result).toMatchObject({
			success: true,
			value: {
				artifact: {
					checksum: fixture.artifactChecksum,
					manifest: { id: fixture.packageSlug, version: fixture.version },
				},
				provenance: {
					checksum: fixture.provenanceChecksum,
					predicateType: fixture.expected.predicateType,
					sourceRepository: fixture.expected.repository,
					builderId: fixture.expected.builderId,
				},
			},
		});
	});

	it("rejects provenance that does not match the signed checksum", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const verify = vi.fn(async (input: ProvenanceVerificationInput) => ({
			success: true as const,
			value: {
				predicateType: "https://slsa.dev/provenance/v1" as const,
				artifactDigest: input.artifactDigest,
				sourceRepository: fixture.expected.repository,
				builderId: fixture.expected.builderId,
				repositoryId: fixture.expected.repositoryId,
				workflowRef: fixture.expected.workflowRef,
				commitSha: fixture.expected.commitSha,
				invocationId: fixture.expected.invocationId,
			},
		}));
		const result = await verifyRelease(
			{
				...fixture.serviceInput,
				provenance: {
					...fixture.serviceInput.provenance,
					checksum: await checksum(encoder.encode("different provenance")),
				},
			},
			{
				fetch: async (url) =>
					new Response(
						url.toString() === fixture.artifactUrl
							? fixture.artifactBytes
							: fixture.provenanceDocument,
					),
				resolveHostname: async () => ["203.0.113.5"],
				provenanceVerifier: { verify },
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: { code: "CHECKSUM_MISMATCH" },
		});
		expect(verify).not.toHaveBeenCalled();
	});

	it("rejects checksum and bundle identity mismatches with stable reports", async () => {
		const bytes = await validBundle();
		const dependencies = {
			fetch: async () => new Response(bytes),
			resolveHostname: async () => ["203.0.113.5"],
		};
		const wrongBytes = encoder.encode("different");

		await expect(
			verifyArtifact(
				{
					url: ARTIFACT_URL,
					checksum: await checksum(wrongBytes),
					packageSlug: "gallery",
					version: "1.2.3",
				},
				dependencies,
			),
		).resolves.toMatchObject({ success: false, error: { code: "CHECKSUM_MISMATCH" } });
		await expect(
			verifyArtifact(
				{
					url: ARTIFACT_URL,
					checksum: await checksum(bytes),
					packageSlug: "other",
					version: "1.2.3",
				},
				dependencies,
			),
		).resolves.toMatchObject({ success: false, error: { code: "BUNDLE_ID_MISMATCH" } });
	});

	it("rejects forbidden DNS before artifact fetch", async () => {
		const fetchImplementation = vi.fn(async () => new Response("unreachable"));
		const result = await verifyArtifact(
			{
				url: ARTIFACT_URL,
				checksum: `b${"a".repeat(54)}`,
				packageSlug: "gallery",
				version: "1.2.3",
			},
			{
				fetch: fetchImplementation,
				resolveHostname: async () => ["127.0.0.1"],
			},
		);

		expect(result).toMatchObject({ success: false, error: { code: "HOST_REJECTED" } });
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("returns bounded input and archive failures", async () => {
		await expect(
			verifyArtifact(
				{ url: "", checksum: "", packageSlug: "", version: "" },
				{ fetch: fetch, resolveHostname: async () => [] },
			),
		).resolves.toEqual({
			success: false,
			error: { code: "VERIFIER_INPUT_INVALID", message: "Artifact request is invalid" },
		});
		const bytes = encoder.encode("not a bundle");
		await expect(
			verifyArtifact(
				{
					url: ARTIFACT_URL,
					checksum: await checksum(bytes),
					packageSlug: "gallery",
					version: "1.2.3",
				},
				{ fetch: async () => new Response(bytes), resolveHostname: async () => ["203.0.113.5"] },
			),
		).resolves.toMatchObject({ success: false, error: { code: "BUNDLE_INVALID_ARCHIVE" } });
	});

	it("exposes typed RPC methods and rejects invalid input before egress", async () => {
		await expect(
			exports.default.verifyArtifact({ url: "", checksum: "", packageSlug: "", version: "" }),
		).resolves.toMatchObject({ success: false, error: { code: "VERIFIER_INPUT_INVALID" } });
		await expect(
			exports.default.verifyRelease({
				artifact: { url: "", checksum: "", packageSlug: "", version: "" },
				provenance: {
					url: "invalid:",
					checksum: "",
					builderId: "invalid:",
					predicateType: "",
					sourceRepository: "invalid:",
				},
				profileRepository: "",
			}),
		).resolves.toMatchObject({ success: false, error: { code: "VERIFIER_INPUT_INVALID" } });
	});

	it("does not expose verification over HTTP", async () => {
		const response = await exports.default.fetch(new Request("https://verifier.example.test/"));

		expect(response.status).toBe(404);
	});
});

describe("Cloudflare DNS resolver", () => {
	it("combines bounded A and AAAA answers", async () => {
		const fetchImplementation = vi.fn(async (input: RequestInfo | URL) => {
			const url =
				input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
			const type = url.searchParams.get("type");
			return Response.json({
				Status: 0,
				Answer: [
					{ type: type === "A" ? 1 : 28, data: type === "A" ? "203.0.113.5" : "2001:db8::5" },
				],
			});
		});

		await expect(resolvePublicHostname("artifact.example", fetchImplementation)).resolves.toEqual([
			"203.0.113.5",
			"2001:db8::5",
		]);
	});
});
