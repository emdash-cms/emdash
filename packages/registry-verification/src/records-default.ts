import { GitHubProvenanceVerifier } from "./provenance.js";
import {
	verifyPackageReleaseRecordsWithDefaultVerifier,
	type RecordVerificationInput,
	type RecordVerificationReport,
} from "./records.js";

/** Validate signed profile/release records and apply the complete provenance policy. */
export function verifyPackageReleaseRecords(
	input: RecordVerificationInput,
): Promise<RecordVerificationReport> {
	return verifyPackageReleaseRecordsWithDefaultVerifier(input, new GitHubProvenanceVerifier());
}
