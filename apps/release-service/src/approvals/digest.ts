import { base64url } from "jose";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CID_PATTERN = /^[A-Za-z0-9]+$/;
const CHECKSUM_PATTERN = /^[A-Za-z0-9:_-]+$/;
const APPROVAL_DOMAIN = "emdash-release-service/approval";
const APPROVAL_VERSION = 1;
const MAX_CHECKSUM_CHARS = 512;

export type ApprovalDecision = "approve" | "reject";

export interface ApprovalEvidence {
	intentId: string;
	publisherDid: string;
	packageSlug: string;
	version: string;
	verificationGeneration: number;
	workloadIdentityDigest: string;
	releaseInputDigest: string;
	profileCid: string;
	baselineReleaseCid: string | null;
	artifactChecksum: string;
	provenanceChecksum: string;
	declaredAccessDiffDigest: string;
	verificationDigest: string;
}

export interface AwaitingApprovalState {
	approvalEvidence: ApprovalEvidence;
	approvalEvidenceDigest: string;
}

export interface ApprovalDecisionBinding {
	evidenceDigest: string;
	approverDid: string;
	decision: ApprovalDecision;
}

export class ApprovalDigestError extends Error {
	readonly code = "APPROVAL_DIGEST_INVALID";

	constructor() {
		super("Approval digest input is invalid");
		this.name = "ApprovalDigestError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function validCid(value: unknown): value is string {
	return (
		typeof value === "string" && value.length >= 8 && value.length <= 256 && CID_PATTERN.test(value)
	);
}

function validChecksum(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 3 &&
		value.length <= MAX_CHECKSUM_CHARS &&
		CHECKSUM_PATTERN.test(value)
	);
}

function validEvidence(value: ApprovalEvidence): boolean {
	return (
		ULID_PATTERN.test(value.intentId) &&
		DID_PATTERN.test(value.publisherDid) &&
		PACKAGE_SLUG_PATTERN.test(value.packageSlug) &&
		VERSION_PATTERN.test(value.version) &&
		Number.isSafeInteger(value.verificationGeneration) &&
		value.verificationGeneration >= 1 &&
		DIGEST_PATTERN.test(value.workloadIdentityDigest) &&
		DIGEST_PATTERN.test(value.releaseInputDigest) &&
		validCid(value.profileCid) &&
		(value.baselineReleaseCid === null || validCid(value.baselineReleaseCid)) &&
		validChecksum(value.artifactChecksum) &&
		validChecksum(value.provenanceChecksum) &&
		DIGEST_PATTERN.test(value.declaredAccessDiffDigest) &&
		DIGEST_PATTERN.test(value.verificationDigest)
	);
}

function evidencePreimage(value: ApprovalEvidence): string {
	if (!validEvidence(value)) throw new ApprovalDigestError();
	return JSON.stringify([
		APPROVAL_DOMAIN,
		"evidence",
		APPROVAL_VERSION,
		value.intentId,
		value.publisherDid,
		value.packageSlug,
		value.version,
		value.verificationGeneration,
		value.workloadIdentityDigest,
		value.releaseInputDigest,
		value.profileCid,
		value.baselineReleaseCid,
		value.artifactChecksum,
		value.provenanceChecksum,
		value.declaredAccessDiffDigest,
		value.verificationDigest,
	]);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return base64url.encode(new Uint8Array(digest));
}

export async function computeApprovalEvidenceDigest(value: ApprovalEvidence): Promise<string> {
	return await sha256(evidencePreimage(value));
}

export async function computeApprovalDecisionDigest(
	value: ApprovalDecisionBinding,
): Promise<string> {
	if (
		!DIGEST_PATTERN.test(value.evidenceDigest) ||
		!DID_PATTERN.test(value.approverDid) ||
		(value.decision !== "approve" && value.decision !== "reject")
	) {
		throw new ApprovalDigestError();
	}
	return await sha256(
		JSON.stringify([
			APPROVAL_DOMAIN,
			"decision",
			APPROVAL_VERSION,
			value.evidenceDigest,
			value.approverDid,
			value.decision,
		]),
	);
}

export async function encodeAwaitingApprovalState(value: ApprovalEvidence): Promise<string> {
	const approvalEvidenceDigest = await computeApprovalEvidenceDigest(value);
	return JSON.stringify({ approvalEvidence: value, approvalEvidenceDigest });
}

export async function decodeAwaitingApprovalState(value: string): Promise<AwaitingApprovalState> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new ApprovalDigestError();
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, ["approvalEvidence", "approvalEvidenceDigest"]) ||
		!isRecord(parsed["approvalEvidence"]) ||
		typeof parsed["approvalEvidenceDigest"] !== "string"
	) {
		throw new ApprovalDigestError();
	}
	const evidenceRecord = parsed["approvalEvidence"];
	if (
		!hasExactKeys(evidenceRecord, [
			"intentId",
			"publisherDid",
			"packageSlug",
			"version",
			"verificationGeneration",
			"workloadIdentityDigest",
			"releaseInputDigest",
			"profileCid",
			"baselineReleaseCid",
			"artifactChecksum",
			"provenanceChecksum",
			"declaredAccessDiffDigest",
			"verificationDigest",
		])
	) {
		throw new ApprovalDigestError();
	}
	const approvalEvidence: ApprovalEvidence = {
		intentId: requireString(evidenceRecord["intentId"]),
		publisherDid: requireString(evidenceRecord["publisherDid"]),
		packageSlug: requireString(evidenceRecord["packageSlug"]),
		version: requireString(evidenceRecord["version"]),
		verificationGeneration: requireNumber(evidenceRecord["verificationGeneration"]),
		workloadIdentityDigest: requireString(evidenceRecord["workloadIdentityDigest"]),
		releaseInputDigest: requireString(evidenceRecord["releaseInputDigest"]),
		profileCid: requireString(evidenceRecord["profileCid"]),
		baselineReleaseCid: requireNullableString(evidenceRecord["baselineReleaseCid"]),
		artifactChecksum: requireString(evidenceRecord["artifactChecksum"]),
		provenanceChecksum: requireString(evidenceRecord["provenanceChecksum"]),
		declaredAccessDiffDigest: requireString(evidenceRecord["declaredAccessDiffDigest"]),
		verificationDigest: requireString(evidenceRecord["verificationDigest"]),
	};
	const expectedDigest = await computeApprovalEvidenceDigest(approvalEvidence);
	if (parsed["approvalEvidenceDigest"] !== expectedDigest) throw new ApprovalDigestError();
	if (JSON.stringify({ approvalEvidence, approvalEvidenceDigest: expectedDigest }) !== value) {
		throw new ApprovalDigestError();
	}
	return { approvalEvidence, approvalEvidenceDigest: expectedDigest };
}

function requireString(value: unknown): string {
	if (typeof value !== "string") throw new ApprovalDigestError();
	return value;
}

function requireNullableString(value: unknown): string | null {
	if (value !== null && typeof value !== "string") throw new ApprovalDigestError();
	return value;
}

function requireNumber(value: unknown): number {
	if (typeof value !== "number") throw new ApprovalDigestError();
	return value;
}
