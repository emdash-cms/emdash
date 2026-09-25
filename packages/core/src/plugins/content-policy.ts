export const MAX_CONTENT_POLICY_REASON_LENGTH = 500;
export const SCHEDULED_POLICY_REJECTION_PREFIX = "emdash:scheduled-policy-rejection:";

export interface ScheduledPolicyRejection {
	collection: string;
	id: string;
	pluginId: string;
	reason: string;
	rejectedAt: string;
}

export interface VersionedScheduledPolicyRejection extends ScheduledPolicyRejection {
	_rev: string;
}

export function isScheduledPolicyRejection(value: unknown): value is ScheduledPolicyRejection {
	if (!isRecord(value)) return false;
	if (
		typeof value.collection !== "string" ||
		typeof value.id !== "string" ||
		typeof value.pluginId !== "string" ||
		typeof value.rejectedAt !== "string"
	) {
		return false;
	}
	return inspectContentPolicyDecision({ cancel: true, reason: value.reason }).kind === "cancel";
}

export function scheduledPolicyRejectionKey(collection: string, id: string): string {
	return `${SCHEDULED_POLICY_REJECTION_PREFIX}${encodeURIComponent(collection)}:${encodeURIComponent(id)}`;
}

function containsForbiddenControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
	}
	return false;
}

function codePointLength(value: string): number {
	let length = 0;
	for (const _character of value) length++;
	return length;
}

export type ContentPolicyDecisionInspection =
	| { kind: "allow" }
	| { kind: "cancel"; reason: string }
	| { kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inspectContentPolicyDecision(value: unknown): ContentPolicyDecisionInspection {
	if (value === undefined) return { kind: "allow" };
	if (!isRecord(value)) return { kind: "invalid" };
	if (Object.keys(value).length !== 2) return { kind: "invalid" };
	if (!Object.hasOwn(value, "cancel") || value.cancel !== true) return { kind: "invalid" };
	if (!Object.hasOwn(value, "reason") || typeof value.reason !== "string") {
		return { kind: "invalid" };
	}

	const reason = value.reason.trim();
	if (
		reason.length === 0 ||
		codePointLength(reason) > MAX_CONTENT_POLICY_REASON_LENGTH ||
		containsForbiddenControlCharacter(reason)
	) {
		return { kind: "invalid" };
	}
	return { kind: "cancel", reason };
}
