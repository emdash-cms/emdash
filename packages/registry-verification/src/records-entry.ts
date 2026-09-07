import type { ProvenanceVerifier, VerifiedProvenance } from "./provenance.js";
import { verifyPackageReleaseRecordsWithVerifier } from "./records.js";
import type {
	NormalizedReleasePolicy,
	ProvenanceEvidence,
	ProvenanceStatus,
	RecordVerificationCode,
	RecordVerificationInputWithVerifier,
	RecordVerificationReason,
	RecordVerificationReport,
	VerifiedRecordContext,
} from "./records.js";

export type RecordVerificationInput = RecordVerificationInputWithVerifier;

export function verifyPackageReleaseRecords(
	input: RecordVerificationInput,
): Promise<RecordVerificationReport> {
	return verifyPackageReleaseRecordsWithVerifier(input);
}

export type {
	NormalizedReleasePolicy,
	ProvenanceEvidence,
	ProvenanceStatus,
	ProvenanceVerifier,
	RecordVerificationCode,
	RecordVerificationReason,
	RecordVerificationReport,
	VerifiedProvenance,
	VerifiedRecordContext,
};
