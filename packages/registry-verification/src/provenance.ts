import type { PackageReleaseExtension } from "@emdash-cms/registry-lexicons";
import {
	BUNDLE_V03_LEGACY_MEDIA_TYPE,
	BUNDLE_V03_MEDIA_TYPE,
	bundleFromJSON,
} from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import type { ObjectIdentifierValuePair } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier } from "@sigstore/verify";

import { compareDigestBytes, verifyMultihash } from "./checksum.js";
import { verificationError } from "./errors.js";
import type { VerificationResult } from "./errors.js";
import { canonicalizeRepositoryUrl } from "./repository.js";
import trustedRootJson from "./trust-roots/sigstore-public-good-v1.json";

const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const GITHUB_WORKFLOW_BUILD_TYPE =
	"https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
const FULCIO_OID_PREFIX = "1.3.6.1.4.1.57264.1.";
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
const GITHUB_WORKFLOW_PATH_RE = /^\.github\/workflows\/.+\.ya?ml$/;
const DECIMAL_RE = /^[1-9][0-9]*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const HEX_RE = /^[0-9a-f]+$/;
const REGEX_META_RE = /[\\^$.*+?()[\]{}|]/g;
const SUPPORTED_SUBJECT_DIGESTS = new Map([
	["sha256", 32],
	["sha384", 48],
	["sha512", 64],
]);
const decoder = new TextDecoder("utf-8", { fatal: true });
const trustedRoot = TrustedRoot.fromJSON(trustedRootJson);
const verifier = new Verifier(toTrustMaterial(trustedRoot), {
	tlogThreshold: 1,
	ctlogThreshold: 1,
	timestampThreshold: 1,
});

export type ReleaseProvenance = PackageReleaseExtension.Provenance;

export interface ProvenanceVerificationInput {
	document: Uint8Array;
	reference: ReleaseProvenance;
	artifactDigest: Uint8Array;
	profileRepository: string;
}

export interface VerifiedProvenance {
	predicateType: typeof PREDICATE_TYPE;
	artifactDigest: Uint8Array;
	sourceRepository: string;
	builderId: string;
}

export interface ProvenanceVerifier {
	verify(input: ProvenanceVerificationInput): Promise<VerificationResult<VerifiedProvenance>>;
}

export class GitHubProvenanceVerifier implements ProvenanceVerifier {
	async verify(
		input: ProvenanceVerificationInput,
	): Promise<VerificationResult<VerifiedProvenance>> {
		try {
			const snapshot = snapshotInput(input);
			const checksum = await verifyMultihash(snapshot.document, snapshot.reference.checksum);
			if (!checksum.success) return unverifiable();

			const serializedBundle = parseJson(snapshot.document);
			const statement = parseStatement(serializedBundle);
			const expected = validateStatement(statement, snapshot);
			const bundle = bundleFromJSON(serializedBundle);
			const signer = verifier.verify(toSignedEntity(bundle), {
				subjectAlternativeName: exactRegexPattern(snapshot.reference.builderId),
				extensions: { issuer: GITHUB_OIDC_ISSUER },
			});
			validateSignerIdentity(signer.identity, expected);

			return {
				success: true,
				value: {
					predicateType: PREDICATE_TYPE,
					artifactDigest: snapshot.artifactDigest,
					sourceRepository: expected.repository,
					builderId: expected.builderId,
				},
			};
		} catch {
			return unverifiable();
		}
	}
}

function snapshotInput(input: ProvenanceVerificationInput): ProvenanceVerificationInput {
	return {
		document: new Uint8Array(input.document),
		reference: {
			builderId: input.reference.builderId,
			checksum: input.reference.checksum,
			predicateType: input.reference.predicateType,
			sourceRepository: input.reference.sourceRepository,
			url: input.reference.url,
		},
		artifactDigest: new Uint8Array(input.artifactDigest),
		profileRepository: input.profileRepository,
	};
}

function exactRegexPattern(value: string): string {
	return `^${value.replace(REGEX_META_RE, "\\$&")}$`;
}

interface ExpectedIdentity {
	repository: string;
	builderId: string;
	workflowRef: string;
	commitSha: string;
	repositoryId: string;
	invocationId: string;
}

interface Statement {
	_type: string;
	subject: unknown[];
	predicateType: string;
	predicate: Record<string, unknown>;
}

function parseJson(document: Uint8Array): unknown {
	return JSON.parse(decoder.decode(document));
}

function parseStatement(serializedBundle: unknown): Statement {
	const bundle = requireObject(serializedBundle);
	const mediaType = requireString(bundle.mediaType);
	if (mediaType !== BUNDLE_V03_MEDIA_TYPE && mediaType !== BUNDLE_V03_LEGACY_MEDIA_TYPE) {
		throw new Error("Unsupported Sigstore bundle format");
	}
	if ("messageSignature" in bundle || !("dsseEnvelope" in bundle)) {
		throw new Error("Only DSSE Sigstore bundles are supported");
	}
	const envelope = requireObject(bundle.dsseEnvelope);
	if (requireString(envelope.payloadType) !== DSSE_PAYLOAD_TYPE) {
		throw new Error("Unsupported DSSE payload type");
	}
	const statement = requireObject(
		JSON.parse(decoder.decode(decodeBase64(requireString(envelope.payload)))),
	);
	const statementType = requireString(statement._type);
	const predicateType = requireString(statement.predicateType);
	if (
		statementType !== STATEMENT_TYPE ||
		predicateType !== PREDICATE_TYPE ||
		!Array.isArray(statement.subject)
	) {
		throw new Error("Unsupported provenance statement");
	}
	return {
		_type: statementType,
		subject: statement.subject,
		predicateType,
		predicate: requireObject(statement.predicate),
	};
}

function validateStatement(
	statement: Statement,
	input: ProvenanceVerificationInput,
): ExpectedIdentity {
	if (input.reference.predicateType !== PREDICATE_TYPE) {
		throw new Error("Provenance predicate reference mismatch");
	}
	validateArtifactSubject(statement.subject, input.artifactDigest);

	const profileRepository = requireRepository(input.profileRepository);
	const referenceRepository = requireRepository(input.reference.sourceRepository);
	const buildDefinition = requireObject(statement.predicate.buildDefinition);
	if (requireString(buildDefinition.buildType) !== GITHUB_WORKFLOW_BUILD_TYPE) {
		throw new Error("Unsupported SLSA build type");
	}
	const workflow = requireObject(requireObject(buildDefinition.externalParameters).workflow);
	const attestedRepository = requireRepository(requireString(workflow.repository));
	if (attestedRepository !== referenceRepository || referenceRepository !== profileRepository) {
		throw new Error("Repository identity mismatch");
	}

	const workflowPath = requireString(workflow.path);
	const workflowRef = requireString(workflow.ref);
	if (!GITHUB_WORKFLOW_PATH_RE.test(workflowPath)) {
		throw new Error("Unsupported GitHub workflow path");
	}
	if (!workflowRef.startsWith("refs/")) throw new Error("Invalid GitHub workflow ref");
	const builderId = `${attestedRepository}/${workflowPath}@${workflowRef}`;
	if (builderId !== input.reference.builderId) {
		throw new Error("Workflow identity mismatch");
	}

	const github = requireObject(requireObject(buildDefinition.internalParameters).github);
	const repositoryId = requireDecimalString(github.repository_id);
	const runDetails = requireObject(statement.predicate.runDetails);
	const invocationId = requireHttpsUrl(
		requireString(requireObject(runDetails.metadata).invocationId),
	);
	const slsaBuilderId = requireString(requireObject(runDetails.builder).id);
	if (slsaBuilderId !== "https://github.com/actions/runner/github-hosted") {
		throw new Error("Unsupported GitHub Actions runner class");
	}

	const dependencies = buildDefinition.resolvedDependencies;
	if (!Array.isArray(dependencies)) throw new Error("Missing resolved dependency");
	const expectedUri = `git+${attestedRepository}@${workflowRef}`;
	const matching = dependencies.filter(
		(dependency) => requireString(requireObject(dependency).uri) === expectedUri,
	);
	if (matching.length !== 1) throw new Error("Ambiguous resolved dependency");
	const commitSha = requireString(requireObject(requireObject(matching[0]).digest).gitCommit);
	if (!GIT_COMMIT_RE.test(commitSha)) throw new Error("Invalid Git commit digest");

	return {
		repository: attestedRepository,
		builderId,
		workflowRef,
		commitSha,
		repositoryId,
		invocationId,
	};
}

function validateArtifactSubject(subjects: unknown[], artifactDigest: Uint8Array): void {
	let matched = false;
	for (const value of subjects) {
		const digest = requireObject(requireObject(value).digest);
		for (const [algorithm, expectedLength] of SUPPORTED_SUBJECT_DIGESTS) {
			if (!(algorithm in digest)) continue;
			const bytes = decodeHex(requireString(digest[algorithm]));
			if (bytes.byteLength !== expectedLength) throw new Error("Invalid subject digest length");
			matched ||= compareDigestBytes(bytes, artifactDigest);
		}
	}
	if (!matched) throw new Error("Artifact digest mismatch");
}

function validateSignerIdentity(
	identity:
		| {
				subjectAlternativeName?: string;
				extensions?: { issuer?: string };
				oids?: ObjectIdentifierValuePair[];
		  }
		| undefined,
	expected: ExpectedIdentity,
): void {
	if (
		identity?.subjectAlternativeName !== expected.builderId ||
		identity.extensions?.issuer !== GITHUB_OIDC_ISSUER
	) {
		throw new Error("Certificate identity mismatch");
	}
	const oids = identity.oids ?? [];
	const issuer = readRequiredOid(oids, 8);
	const buildSignerUri = readRequiredOid(oids, 9);
	const buildSignerDigest = readRequiredOid(oids, 10);
	const sourceRepository = requireRepository(readRequiredOid(oids, 12));
	const sourceDigest = readRequiredOid(oids, 13);
	const sourceRef = readRequiredOid(oids, 14);
	const repositoryId = readRequiredOid(oids, 15);
	const buildConfigUri = readRequiredOid(oids, 18);
	const buildConfigDigest = readRequiredOid(oids, 19);
	const invocationId = readRequiredOid(oids, 21);

	if (
		issuer !== GITHUB_OIDC_ISSUER ||
		buildSignerUri !== expected.builderId ||
		buildConfigUri !== expected.builderId ||
		buildSignerDigest !== expected.commitSha ||
		sourceDigest !== expected.commitSha ||
		buildConfigDigest !== expected.commitSha ||
		sourceRepository !== expected.repository ||
		sourceRef !== expected.workflowRef ||
		repositoryId !== expected.repositoryId ||
		invocationId !== expected.invocationId
	) {
		throw new Error("Certificate and predicate identity mismatch");
	}
}

function readRequiredOid(oids: ObjectIdentifierValuePair[], suffix: number): string {
	const expectedOid = `${FULCIO_OID_PREFIX}${suffix}`;
	const matches = oids.filter((pair) => pair.oid?.id.join(".") === expectedOid);
	if (matches.length !== 1) throw new Error("Missing or duplicate Fulcio identity OID");
	const value = matches[0]?.value;
	if (!value) throw new Error("Missing Fulcio identity OID value");
	return decodeDerUtf8String(value);
}

function decodeDerUtf8String(value: Uint8Array): string {
	if (value[0] !== 0x0c || value.byteLength < 2) throw new Error("Malformed DER UTF8String");
	const firstLength = value[1];
	if (firstLength === undefined) throw new Error("Malformed DER UTF8String");
	let offset = 2;
	let length: number;
	if (firstLength < 0x80) {
		length = firstLength;
	} else {
		const lengthBytes = firstLength & 0x7f;
		if (lengthBytes === 0 || lengthBytes > 2 || value.byteLength < 2 + lengthBytes) {
			throw new Error("Malformed DER UTF8String length");
		}
		length = 0;
		for (let index = 0; index < lengthBytes; index += 1) {
			length = length * 256 + (value[offset + index] ?? 0);
		}
		if (length < 0x80 || (lengthBytes === 2 && length < 0x100)) {
			throw new Error("Non-canonical DER UTF8String length");
		}
		offset += lengthBytes;
	}
	if (length === 0 || offset + length !== value.byteLength) {
		throw new Error("Malformed DER UTF8String value");
	}
	return decoder.decode(value.subarray(offset));
}

function requireRepository(value: string): string {
	const repository = canonicalizeRepositoryUrl(value);
	if (!repository) throw new Error("Invalid repository URL");
	return repository;
}

function requireHttpsUrl(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		url.port ||
		url.toString() !== value
	) {
		throw new Error("Invalid HTTPS URL");
	}
	return value;
}

function requireDecimalString(value: unknown): string {
	const result = requireString(value);
	if (!DECIMAL_RE.test(result)) throw new Error("Invalid decimal identity");
	return result;
}

function requireObject(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Expected an object");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("Expected a string");
	return value;
}

function decodeBase64(value: string): Uint8Array {
	if (!BASE64_RE.test(value)) {
		throw new Error("Invalid base64");
	}
	return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function decodeHex(value: string): Uint8Array {
	if (!HEX_RE.test(value) || value.length % 2 !== 0) {
		throw new Error("Invalid hexadecimal digest");
	}
	return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function unverifiable(): VerificationResult<never> {
	return verificationError(
		"PROVENANCE_UNVERIFIABLE",
		"The supplied provenance could not be verified.",
	);
}

export const provenanceTestInternals = {
	decodeDerUtf8String,
	exactRegexPattern,
	readRequiredOid,
};
