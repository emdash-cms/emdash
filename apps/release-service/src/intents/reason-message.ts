import type { IntentState } from "../publisher-do/publisher-do.js";

const FAILURE_MESSAGES: Record<string, string> = {
	WORKLOAD_STAGING_MISSING:
		"The uploaded package or provenance is no longer in release staging. Both files need to be uploaded again.",
	WORKLOAD_STAGING_CHECKSUM_MISMATCH:
		"An uploaded file does not match its declared checksum. Rebuild the package and provenance together before submitting again.",
	WORKLOAD_STAGING_SIZE_MISMATCH:
		"An uploaded file does not match its declared size. Check that the upload completed before submitting again.",
	FETCH_FAILED:
		"The release service could not load the package or provenance bytes. Check that both uploads completed or that their source URLs are accessible.",
	VERIFIER_INTERNAL_ERROR:
		"The release verifier could not complete its check. Contact the release service operator with the intent ID.",
	PROVENANCE_REQUIRED:
		"This profile requires build provenance. Include a GitHub Actions build attestation with the release.",
	PROVENANCE_UNVERIFIABLE:
		"The build attestation could not be verified against this package and workflow. Check the attested package digest and workflow identity.",
	BUNDLE_INVALID_MANIFEST:
		"The plugin manifest failed validation. Check the manifest fields and declared capabilities against the current plugin schema.",
	FINAL_VERIFICATION_CHANGED:
		"The release evidence changed after approval. Review the current profile, access declarations, and workflow policy before submitting again.",
	WORKLOAD_POLICY_CHANGED:
		"The workflow authorization changed. Check the connected repository, workflow, and allowed refs before submitting again.",
	PDS_RECORD_INVALID:
		"Your PDS rejected the release record. Contact the release service operator with the intent ID so they can check the PDS rejection.",
	PDS_AUTHORIZATION_FAILED:
		"Your PDS rejected the release service's authorization. Reconnect your publisher account before submitting again.",
	OAUTH_DELEGATION_UNAVAILABLE:
		"The release service no longer has an active publisher connection. Reconnect your publisher account before submitting again.",
	PDS_RATE_LIMITED: "Your PDS rate-limited the publication requests. Wait before submitting again.",
	PDS_UNAVAILABLE:
		"Your PDS returned a server error during publication. Check its availability before submitting again.",
	PDS_WRITE_FAILED:
		"Your PDS rejected the publication request. Contact the release service operator with the intent ID.",
	PDS_RETRY_EXHAUSTED:
		"The release was still absent from your PDS after three publication attempts. Contact the release service operator with the intent ID.",
	RELEASE_CONFLICT:
		"A different release already exists for this package version. Check the existing release and use a new version if needed.",
	INTENT_EXPIRED: "The release intent expired before publication completed.",
};

export function intentReasonMessage(
	state: IntentState,
	reasonCode: string | null,
	stateDataJson: string | null,
): string | null {
	if (!["invalid", "failed", "conflict", "expired"].includes(state) || !reasonCode) return null;
	let diagnosticCode = reasonCode;
	if (reasonCode === "PDS_RETRY_EXHAUSTED" && stateDataJson) {
		try {
			const data: unknown = JSON.parse(stateDataJson);
			if (
				data &&
				typeof data === "object" &&
				"publicationErrorCode" in data &&
				typeof data.publicationErrorCode === "string" &&
				Object.hasOwn(FAILURE_MESSAGES, data.publicationErrorCode)
			) {
				diagnosticCode = data.publicationErrorCode;
			}
		} catch {}
	}
	const message =
		(Object.hasOwn(FAILURE_MESSAGES, diagnosticCode) ? FAILURE_MESSAGES[diagnosticCode] : null) ??
		"The release could not complete. Contact the release service operator with the intent ID and reason code.";
	return state === "conflict"
		? message
		: `${message} Start a fresh workflow dispatch after resolving the problem; re-running jobs reuses this terminal intent.`;
}
