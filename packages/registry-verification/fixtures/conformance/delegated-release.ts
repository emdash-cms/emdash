import { declaredAccessToCapabilities, type DeclaredAccess } from "@emdash-cms/plugin-types";
import type { PackageProfile, PackageRelease } from "@emdash-cms/registry-lexicons";
import { packTar, type TarEntry } from "modern-tar";

import {
	compareDigestBytes,
	computeMultihash,
	decodeMultihash,
	type ProvenanceVerifier,
	type ReleaseProvenance,
} from "../../src/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DelegatedReleaseFixtureOptions {
	version?: string;
	manifestId?: string;
	manifestVersion?: string;
	releasePackage?: string;
	releaseVersion?: string;
	declaredAccess?: DeclaredAccess;
	manifestDeclaredAccess?: DeclaredAccess;
	provenanceDigestAlgorithm?: "sha256" | "sha384" | "sha512";
	provenance?: Partial<ReleaseProvenance>;
}

export interface DelegatedReleaseConformanceFixture {
	publisherDid: string;
	packageSlug: string;
	version: string;
	profile: PackageProfile.Main;
	release: PackageRelease.Main;
	artifactUrl: string;
	artifactBytes: Uint8Array;
	artifactChecksum: string;
	artifactDigest: Uint8Array;
	provenanceUrl: string;
	provenanceDocument: Uint8Array;
	provenanceChecksum: string;
	provenanceVerifier: ProvenanceVerifier;
	serviceInput: {
		artifact: {
			url: string;
			checksum: string;
			packageSlug: string;
			version: string;
		};
		provenance: ReleaseProvenance;
		profileRepository: string;
	};
	expected: {
		repository: string;
		builderId: string;
		predicateType: string;
		repositoryId: string;
		workflowRef: string;
		commitSha: string;
		invocationId: string;
	};
}

interface ConformanceProvenanceStatement {
	predicateType: string;
	subject: Partial<Record<"sha256" | "sha384" | "sha512", string>>;
	sourceRepository: string;
	builderId: string;
}
export async function createDelegatedReleaseConformanceFixture(
	options: DelegatedReleaseFixtureOptions = {},
): Promise<DelegatedReleaseConformanceFixture> {
	const publisherDid = "did:plc:delegated00000000000000";
	const packageSlug = "gallery";
	const version = options.version ?? "1.2.3";
	const repository = "https://github.com/emdash-cms/gallery";
	const builderId =
		"https://github.com/emdash-cms/gallery/.github/workflows/release.yml@refs/heads/main";
	const predicateType = "https://slsa.dev/provenance/v1";
	const repositoryId = "123456789";
	const workflowRef = "refs/heads/main";
	const commitSha = "b".repeat(40);
	const invocationId = `${repository}/actions/runs/100/attempts/1`;
	const artifactUrl = "https://artifact.example.test/gallery.tgz";
	const provenanceUrl = "https://provenance.example.test/gallery.sigstore.json";
	const declaredAccess = options.declaredAccess ?? { content: { read: {} } };
	const manifestDeclaredAccess = options.manifestDeclaredAccess ?? declaredAccess;
	const enforcement = declaredAccessToCapabilities(manifestDeclaredAccess);
	const artifactBytes = await bundle([
		file(
			"manifest.json",
			JSON.stringify({
				id: options.manifestId ?? packageSlug,
				version: options.manifestVersion ?? version,
				declaredAccess: manifestDeclaredAccess,
				capabilities: enforcement.capabilities,
				allowedHosts: enforcement.allowedHosts,
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			}),
		),
		file("backend.js", "export default {};"),
		file("admin.js", "export default {};"),
	]);
	const artifact = await checksumAndDigest(artifactBytes);
	const provenanceDigestAlgorithm = options.provenanceDigestAlgorithm ?? "sha256";
	const provenanceArtifactDigest =
		provenanceDigestAlgorithm === "sha256"
			? artifact.digest
			: new Uint8Array(
					await crypto.subtle.digest(
						provenanceDigestAlgorithm === "sha384" ? "SHA-384" : "SHA-512",
						artifactBytes,
					),
				);
	const statement: ConformanceProvenanceStatement = {
		predicateType,
		subject: { [provenanceDigestAlgorithm]: toHex(provenanceArtifactDigest) },
		sourceRepository: repository,
		builderId,
	};
	const provenanceDocument = encoder.encode(JSON.stringify(statement));
	const provenance = await checksumAndDigest(provenanceDocument);
	const reference: ReleaseProvenance = {
		predicateType,
		url: provenanceUrl,
		checksum: provenance.checksum,
		sourceRepository: repository,
		builderId,
		...options.provenance,
	};
	const profile: PackageProfile.Main = {
		$type: "com.emdashcms.experimental.package.profile",
		id: `at://${publisherDid}/com.emdashcms.experimental.package.profile/${packageSlug}`,
		slug: packageSlug,
		type: "emdash-plugin",
		name: "Gallery",
		license: "MIT",
		authors: [{ name: "EmDash" }],
		security: [{ email: "security@emdashcms.com" }],
		extensions: {
			"com.emdashcms.experimental.package.profileExtension": {
				$type: "com.emdashcms.experimental.package.profileExtension",
				repository,
				releasePolicy: {
					requireProvenance: true,
					confirmation: "escalation-only",
					approvers: [publisherDid],
				},
			},
		},
	};
	const release: PackageRelease.Main = {
		$type: "com.emdashcms.experimental.package.release",
		package: options.releasePackage ?? packageSlug,
		version: options.releaseVersion ?? version,
		artifacts: { package: { url: artifactUrl, checksum: artifact.checksum } },
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess,
				provenance: reference,
			},
		},
	};
	const provenanceVerifier: ProvenanceVerifier = {
		async verify(input) {
			let value: unknown;
			try {
				value = JSON.parse(decoder.decode(input.document));
			} catch {
				return unverifiable();
			}
			if (!isConformanceStatement(value)) return unverifiable();
			const parsed = value;
			const matchedArtifactDigest = [input.artifactDigest, ...(input.artifactDigests ?? [])].find(
				(candidate) => compareDigestBytes(candidate, provenanceArtifactDigest),
			);
			if (
				input.reference.predicateType !== predicateType ||
				input.reference.url !== provenanceUrl ||
				input.reference.checksum !== provenance.checksum ||
				input.reference.sourceRepository !== repository ||
				input.reference.builderId !== builderId ||
				input.profileRepository !== repository ||
				!compareDigestBytes(input.artifactDigest, artifact.digest) ||
				!matchedArtifactDigest ||
				parsed.predicateType !== predicateType ||
				parsed.subject[provenanceDigestAlgorithm] !== toHex(provenanceArtifactDigest) ||
				parsed.sourceRepository !== repository ||
				parsed.builderId !== builderId
			) {
				return unverifiable();
			}
			return {
				success: true,
				value: {
					predicateType,
					artifactDigest: matchedArtifactDigest,
					sourceRepository: repository,
					builderId,
					repositoryId,
					workflowRef,
					commitSha,
					invocationId,
				},
			};
		},
	};

	return {
		publisherDid,
		packageSlug,
		version,
		profile,
		release,
		artifactUrl,
		artifactBytes,
		artifactChecksum: artifact.checksum,
		artifactDigest: artifact.digest,
		provenanceUrl,
		provenanceDocument,
		provenanceChecksum: provenance.checksum,
		provenanceVerifier,
		serviceInput: {
			artifact: {
				url: artifactUrl,
				checksum: artifact.checksum,
				packageSlug,
				version,
			},
			provenance: reference,
			profileRepository: repository,
		},
		expected: {
			repository,
			builderId,
			predicateType,
			repositoryId,
			workflowRef,
			commitSha,
			invocationId,
		},
	};
}

function file(name: string, body: string): TarEntry {
	const bytes = encoder.encode(body);
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function bundle(entries: TarEntry[]): Promise<Uint8Array> {
	const tar = await packTar(entries);
	const compressed = new Blob([new Uint8Array(tar)])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function checksumAndDigest(
	bytes: Uint8Array,
): Promise<{ checksum: string; digest: Uint8Array }> {
	const checksum = await computeMultihash(bytes);
	if (!checksum.success) throw new Error(checksum.error.message);
	const decoded = decodeMultihash(checksum.value);
	if (!decoded.success) throw new Error(decoded.error.message);
	return { checksum: checksum.value, digest: decoded.value.digest };
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isConformanceStatement(value: unknown): value is ConformanceProvenanceStatement {
	if (!value || typeof value !== "object") return false;
	const subject = Reflect.get(value, "subject");
	return (
		typeof Reflect.get(value, "predicateType") === "string" &&
		typeof Reflect.get(value, "sourceRepository") === "string" &&
		typeof Reflect.get(value, "builderId") === "string" &&
		typeof subject === "object" &&
		subject !== null &&
		["sha256", "sha384", "sha512"].some(
			(algorithm) => typeof Reflect.get(subject, algorithm) === "string",
		)
	);
}
function unverifiable() {
	return {
		success: false as const,
		error: {
			code: "PROVENANCE_UNVERIFIABLE" as const,
			message: "The conformance provenance does not match the delegated release.",
		},
	};
}
