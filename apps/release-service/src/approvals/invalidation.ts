import type { ApproverDurableObject } from "../approver-do/approver-do.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_APPROVERS = 32;

export class ApprovalInvalidationError extends Error {
	readonly code = "APPROVAL_INVALIDATION_INVALID";

	constructor() {
		super("Approval invalidation input is invalid");
		this.name = "ApprovalInvalidationError";
	}
}

export async function invalidateApprovalChallenges(
	namespace: DurableObjectNamespace<ApproverDurableObject>,
	approverDids: readonly string[],
	intentId: string,
	reasonCode: string,
	now = Date.now(),
): Promise<number> {
	if (
		!Array.isArray(approverDids) ||
		approverDids.length > MAX_APPROVERS ||
		new Set(approverDids).size !== approverDids.length ||
		approverDids.some((did) => !DID_PATTERN.test(did)) ||
		!ULID_PATTERN.test(intentId) ||
		!REASON_PATTERN.test(reasonCode) ||
		!Number.isSafeInteger(now) ||
		now < 0
	) {
		throw new ApprovalInvalidationError();
	}
	const counts = await Promise.all(
		approverDids.map((approverDid) =>
			namespace
				.getByName(approverDid)
				.invalidateIntentChallenges(approverDid, intentId, reasonCode, now),
		),
	);
	return counts.reduce((total, count) => total + count, 0);
}
