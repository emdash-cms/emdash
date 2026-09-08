import { safeParse } from "@atcute/lexicons";
import { diffDeclaredAccess, type AccessDiff, type DeclaredAccess } from "@emdash-cms/plugin-types";
import { parseDelegatedReleaseSourceRecord } from "@emdash-cms/registry-client/release-service";
import {
	NSID,
	PackageProfileExtension,
	PackageRelease,
	PackageReleaseExtension,
} from "@emdash-cms/registry-lexicons";
import { decodeMultihash } from "@emdash-cms/registry-verification/checksum";
import {
	verifyPackageReleaseRecords,
	type ProvenanceVerifier,
	type VerifiedRecordContext,
} from "@emdash-cms/registry-verification/records";
import { base64url } from "jose";

import type {
	ReleaseVerificationReport,
	VerifyReleaseInput,
} from "../../../release-verifier/src/verify.js";
import type { ApprovalEvidence } from "../approvals/digest.js";
import type { StoredIntent } from "../publisher-do/publisher-do.js";
import type { StoredWorkloadPolicy } from "../publisher-do/workload-policy.js";
import { evaluateWorkloadPolicy } from "../workload/policy.js";
import { parseStoredWorkloadIdentity } from "../workload/stored-identity.js";
import type { PublisherVerificationSnapshot } from "./pds.js";

const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";

export type VerificationEvaluationCode =
	| "APPROVER_REQUIRED"
	| "ARTIFACT_RECORD_MISMATCH"
	| "BASELINE_INVALID"
	| "INTENT_INPUT_INVALID"
	| "RECORD_INVALID"
	| "VERIFIER_REJECTED"
	| "WORKLOAD_IDENTITY_INVALID";

export interface VerifiedProvenanceIdentity {
	sourceRepository: string;
	builderId: string;
	repositoryId: string;
	workflowRef: string;
	commitSha: string;
	invocationId: string;
}

export type VerificationEvaluation =
	| {
			success: true;
			value: {
				records: VerifiedRecordContext;
				accessDiff: AccessDiff;
				requiresApproval: boolean;
				approvalEvidence: ApprovalEvidence;
				verifier: Extract<NormalizedVerifierReport, { success: true }>["value"];
			};
	  }
	| { success: false; code: VerificationEvaluationCode; reasonCode: string };

export type NormalizedVerifierReport =
	| {
			success: true;
			value: {
				artifact: {
					requestedUrl: string;
					resolvedUrl: string;
					checksum: string;
					compressedBytes: number;
					manifest: { id: string; version: string; declaredAccess: unknown };
					bundle: { backendBytes: number; adminBytes: number | null };
				};
				provenance: {
					requestedUrl: string;
					resolvedUrl: string;
					checksum: string;
					documentBytes: number;
					predicateType: string;
					sourceRepository: string;
					builderId: string;
					repositoryId: string;
					workflowRef: string;
					commitSha: string;
					invocationId: string;
				};
			};
	  }
	| { success: false; error: { code: string; message: string } };

interface ReleaseIntentPayload {
	release: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberField(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function normalizeVerifierReport(
	report: ReleaseVerificationReport,
): NormalizedVerifierReport {
	if (!report.success) {
		return { success: false, error: { code: report.error.code, message: report.error.message } };
	}
	return {
		success: true,
		value: {
			artifact: {
				requestedUrl: report.value.artifact.requestedUrl,
				resolvedUrl: report.value.artifact.resolvedUrl,
				checksum: report.value.artifact.checksum,
				compressedBytes: report.value.artifact.compressedBytes,
				manifest: {
					id: report.value.artifact.manifest.id,
					version: report.value.artifact.manifest.version,
					declaredAccess: report.value.artifact.manifest.declaredAccess,
				},
				bundle: {
					backendBytes: report.value.artifact.bundle.backendBytes,
					adminBytes: report.value.artifact.bundle.adminBytes,
				},
			},
			provenance: { ...report.value.provenance },
		},
	};
}

export function parseNormalizedVerifierReport(value: string): NormalizedVerifierReport | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || typeof parsed["success"] !== "boolean") return null;
	if (!parsed["success"]) {
		const error = parsed["error"];
		if (!isRecord(error)) return null;
		const code = stringField(error["code"]);
		const message = stringField(error["message"]);
		return code && message ? { success: false, error: { code, message } } : null;
	}
	const reportValue = parsed["value"];
	if (
		!isRecord(reportValue) ||
		!isRecord(reportValue["artifact"]) ||
		!isRecord(reportValue["provenance"])
	) {
		return null;
	}
	const artifact = reportValue["artifact"];
	const provenance = reportValue["provenance"];
	if (!isRecord(artifact["manifest"]) || !isRecord(artifact["bundle"])) return null;
	const manifest = artifact["manifest"];
	const bundle = artifact["bundle"];
	const normalized = {
		requestedUrl: stringField(artifact["requestedUrl"]),
		resolvedUrl: stringField(artifact["resolvedUrl"]),
		checksum: stringField(artifact["checksum"]),
		compressedBytes: numberField(artifact["compressedBytes"]),
		manifestId: stringField(manifest["id"]),
		manifestVersion: stringField(manifest["version"]),
		backendBytes: numberField(bundle["backendBytes"]),
		adminBytes: bundle["adminBytes"] === null ? null : numberField(bundle["adminBytes"]),
		provenanceRequestedUrl: stringField(provenance["requestedUrl"]),
		provenanceResolvedUrl: stringField(provenance["resolvedUrl"]),
		provenanceChecksum: stringField(provenance["checksum"]),
		documentBytes: numberField(provenance["documentBytes"]),
		predicateType: stringField(provenance["predicateType"]),
		sourceRepository: stringField(provenance["sourceRepository"]),
		builderId: stringField(provenance["builderId"]),
		repositoryId: stringField(provenance["repositoryId"]),
		workflowRef: stringField(provenance["workflowRef"]),
		commitSha: stringField(provenance["commitSha"]),
		invocationId: stringField(provenance["invocationId"]),
	};
	if (
		normalized.requestedUrl === null ||
		normalized.resolvedUrl === null ||
		normalized.checksum === null ||
		normalized.compressedBytes === null ||
		normalized.manifestId === null ||
		normalized.manifestVersion === null ||
		normalized.backendBytes === null ||
		normalized.provenanceRequestedUrl === null ||
		normalized.provenanceResolvedUrl === null ||
		normalized.provenanceChecksum === null ||
		normalized.documentBytes === null ||
		normalized.predicateType === null ||
		normalized.sourceRepository === null ||
		normalized.builderId === null ||
		normalized.repositoryId === null ||
		normalized.workflowRef === null ||
		normalized.commitSha === null ||
		normalized.invocationId === null ||
		!("declaredAccess" in manifest)
	) {
		return null;
	}
	return {
		success: true,
		value: {
			artifact: {
				requestedUrl: normalized.requestedUrl,
				resolvedUrl: normalized.resolvedUrl,
				checksum: normalized.checksum,
				compressedBytes: normalized.compressedBytes,
				manifest: {
					id: normalized.manifestId,
					version: normalized.manifestVersion,
					declaredAccess: manifest["declaredAccess"],
				},
				bundle: {
					backendBytes: normalized.backendBytes,
					adminBytes: normalized.adminBytes,
				},
			},
			provenance: {
				requestedUrl: normalized.provenanceRequestedUrl,
				resolvedUrl: normalized.provenanceResolvedUrl,
				checksum: normalized.provenanceChecksum,
				documentBytes: normalized.documentBytes,
				predicateType: normalized.predicateType,
				sourceRepository: normalized.sourceRepository,
				builderId: normalized.builderId,
				repositoryId: normalized.repositoryId,
				workflowRef: normalized.workflowRef,
				commitSha: normalized.commitSha,
				invocationId: normalized.invocationId,
			},
		},
	};
}

function failed(
	code: VerificationEvaluationCode,
	reasonCode: string = code,
): VerificationEvaluation {
	return { success: false, code, reasonCode };
}

function parseReleaseIntent(value: string): ReleaseIntentPayload | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !("release" in parsed)) {
		return null;
	}
	return { release: parsed["release"] };
}

function equalJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

async function digest(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function prepareVerifierInput(
	intent: StoredIntent,
	snapshot: PublisherVerificationSnapshot,
): VerifyReleaseInput | null {
	const payload = parseReleaseIntent(intent.releaseInputJson);
	if (!payload) return null;
	const release = parseDelegatedReleaseSourceRecord(payload.release, {
		packageSlug: intent.packageSlug,
		version: intent.version,
	});
	const profileExtensionRaw = isRecord(snapshot.profile.value)
		? isRecord(snapshot.profile.value["extensions"])
			? snapshot.profile.value["extensions"][NSID.packageProfileExtension]
			: undefined
		: undefined;
	const profileExtension = safeParse(PackageProfileExtension.mainSchema, profileExtensionRaw);
	if (!release || !profileExtension.ok) return null;
	return {
		artifact: {
			url: release.artifacts.package.url,
			checksum: release.artifacts.package.checksum,
			packageSlug: intent.packageSlug,
			version: intent.version,
		},
		provenance: release.extensions[NSID.packageReleaseExtension].provenance,
		profileRepository: profileExtension.value.repository,
	};
}

function baselineAccess(
	snapshot: PublisherVerificationSnapshot,
	intent: StoredIntent,
): DeclaredAccess | null {
	if (!snapshot.baseline) return {};
	const release = safeParse(PackageRelease.mainSchema, snapshot.baseline.value);
	if (
		!release.ok ||
		release.value.package !== intent.packageSlug ||
		release.value.version !== snapshot.baselineVersion ||
		!isRecord(release.value.extensions)
	) {
		return null;
	}
	const extension = safeParse(
		PackageReleaseExtension.mainSchema,
		release.value.extensions[NSID.packageReleaseExtension],
	);
	return extension.ok ? extension.value.declaredAccess : null;
}

function reportBackedVerifier(
	report: Extract<NormalizedVerifierReport, { success: true }>["value"],
): ProvenanceVerifier {
	return {
		verify: async (input) => {
			if (
				input.reference.url !== report.provenance.requestedUrl ||
				input.reference.checksum !== report.provenance.checksum ||
				input.reference.predicateType !== report.provenance.predicateType ||
				report.provenance.predicateType !== SLSA_PROVENANCE_V1 ||
				input.reference.sourceRepository !== report.provenance.sourceRepository ||
				input.reference.builderId !== report.provenance.builderId ||
				input.profileRepository !== report.provenance.sourceRepository
			) {
				return {
					success: false,
					error: {
						code: "PROVENANCE_UNVERIFIABLE",
						message: "Verified provenance does not match the signed record.",
					},
				};
			}
			return {
				success: true,
				value: {
					predicateType: SLSA_PROVENANCE_V1,
					artifactDigest: new Uint8Array(input.artifactDigest),
					sourceRepository: report.provenance.sourceRepository,
					builderId: report.provenance.builderId,
					repositoryId: report.provenance.repositoryId,
					workflowRef: report.provenance.workflowRef,
					commitSha: report.provenance.commitSha,
					invocationId: report.provenance.invocationId,
				},
			};
		},
	};
}

export async function evaluateWorkloadAttestation(
	intent: Pick<StoredIntent, "packageSlug" | "workloadIdentityDigest" | "workloadIdentityJson">,
	policy: StoredWorkloadPolicy | null,
	provenance: VerifiedProvenanceIdentity,
): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
	const identity = await parseStoredWorkloadIdentity(
		intent.workloadIdentityJson,
		intent.workloadIdentityDigest,
	);
	if (!identity) return { ok: false, reasonCode: "WORKLOAD_IDENTITY_INVALID" };
	if (!policy || policy.packageSlug !== intent.packageSlug) {
		return { ok: false, reasonCode: "WORKLOAD_POLICY_UNAVAILABLE" };
	}
	const policyDecision = evaluateWorkloadPolicy(identity, policy);
	if (!policyDecision.ok) return { ok: false, reasonCode: policyDecision.code };
	const workflowMarker = "/.github/workflows/";
	const markerIndex = identity.workflow.ref.toLowerCase().indexOf(workflowMarker);
	if (markerIndex < 1) {
		return { ok: false, reasonCode: "ATTESTED_WORKFLOW_MISMATCH" };
	}
	const sourceRepository = `https://github.com/${identity.workflow.ref.slice(0, markerIndex)}`;
	if (
		provenance.repositoryId !== identity.repository.id ||
		provenance.sourceRepository.toLowerCase() !== sourceRepository.toLowerCase()
	) {
		return { ok: false, reasonCode: "ATTESTED_REPOSITORY_MISMATCH" };
	}
	const expectedBuilderId = `${sourceRepository}${identity.workflow.ref.slice(markerIndex)}`;
	if (provenance.builderId !== expectedBuilderId) {
		return { ok: false, reasonCode: "ATTESTED_WORKFLOW_MISMATCH" };
	}
	const workflowRef = identity.workflow.ref.slice(identity.workflow.ref.lastIndexOf("@") + 1);
	if (provenance.workflowRef !== workflowRef) {
		return { ok: false, reasonCode: "ATTESTED_REF_MISMATCH" };
	}
	if (provenance.commitSha !== identity.run.commitSha) {
		return { ok: false, reasonCode: "ATTESTED_COMMIT_MISMATCH" };
	}
	const invocationId = `${sourceRepository}/actions/runs/${identity.run.id}/attempts/${identity.run.attempt}`;
	if (provenance.invocationId !== invocationId) {
		return { ok: false, reasonCode: "ATTESTED_INVOCATION_MISMATCH" };
	}
	return { ok: true };
}

export async function evaluateVerifiedRelease(
	publisherDid: string,
	intent: StoredIntent,
	snapshot: PublisherVerificationSnapshot,
	workloadPolicy: StoredWorkloadPolicy | null,
	verifierReport: NormalizedVerifierReport,
): Promise<VerificationEvaluation> {
	if (!verifierReport.success) return failed("VERIFIER_REJECTED", verifierReport.error.code);
	const workload = await evaluateWorkloadAttestation(
		intent,
		workloadPolicy,
		verifierReport.value.provenance,
	);
	if (!workload.ok) return failed("WORKLOAD_IDENTITY_INVALID", workload.reasonCode);
	const payload = parseReleaseIntent(intent.releaseInputJson);
	const verifierInput = prepareVerifierInput(intent, snapshot);
	if (!payload || !verifierInput) return failed("INTENT_INPUT_INVALID");
	if (
		verifierReport.value.artifact.requestedUrl !== verifierInput.artifact.url ||
		verifierReport.value.artifact.checksum !== verifierInput.artifact.checksum ||
		verifierReport.value.artifact.manifest.id !== intent.packageSlug ||
		verifierReport.value.artifact.manifest.version !== intent.version
	) {
		return failed("ARTIFACT_RECORD_MISMATCH");
	}
	const checksum = decodeMultihash(verifierInput.artifact.checksum);
	if (!checksum.success) return failed("RECORD_INVALID", checksum.error.code);
	const records = await verifyPackageReleaseRecords({
		publisherDid,
		package: intent.packageSlug,
		version: intent.version,
		rkey: snapshot.proposedRkey,
		profile: snapshot.profile.value,
		release: payload.release,
		provenance: {
			document: new Uint8Array(),
			artifactDigest: checksum.value.digest,
			verifier: reportBackedVerifier(verifierReport.value),
		},
	});
	if (!records.success) return failed("RECORD_INVALID", records.code);
	if (
		!equalJson(records.value.declaredAccess, verifierReport.value.artifact.manifest.declaredAccess)
	) {
		return failed("ARTIFACT_RECORD_MISMATCH");
	}
	const previousAccess = baselineAccess(snapshot, intent);
	if (!previousAccess) return failed("BASELINE_INVALID");
	const accessDiff = diffDeclaredAccess(
		previousAccess,
		records.value.releaseExtension.declaredAccess,
	);
	const requiresApproval = records.value.policy.confirmation === "always" || accessDiff.escalation;
	if (requiresApproval && records.value.policy.approvers.length === 0) {
		return failed("APPROVER_REQUIRED");
	}
	const declaredAccessDiffDigest = await digest(accessDiff);
	const verificationDigest = await digest({
		profileCid: snapshot.profile.cid,
		baselineCid: snapshot.baseline?.cid ?? null,
		artifact: verifierReport.value.artifact,
		provenance: verifierReport.value.provenance,
		policy: records.value.policy,
		accessDiff,
	});
	return {
		success: true,
		value: {
			records: records.value,
			accessDiff,
			requiresApproval,
			approvalEvidence: {
				intentId: intent.id,
				publisherDid,
				packageSlug: intent.packageSlug,
				version: intent.version,
				verificationGeneration: intent.stateGeneration + 2,
				workloadIdentityDigest: intent.workloadIdentityDigest,
				releaseInputDigest: intent.requestDigest,
				profileCid: snapshot.profile.cid,
				baselineReleaseCid: snapshot.baseline?.cid ?? null,
				artifactChecksum: verifierInput.artifact.checksum,
				provenanceChecksum: verifierInput.provenance.checksum,
				declaredAccessDiffDigest,
				verificationDigest,
			},
			verifier: verifierReport.value,
		},
	};
}
