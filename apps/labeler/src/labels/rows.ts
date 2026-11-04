import { parseSignedListingLabel, type SignedListingLabel } from "@emdash-cms/registry-moderation";

import type { IssuedListingLabel } from "./types.js";

export interface StoredLabelRow {
	id: number;
	idempotency_key: string;
	assessment_id: string | null;
	assessment_policy_version: string | null;
	assessment_outcome: string | null;
	operator_action_id: number | null;
	actor_did: string;
	actor_role: "automation" | "reviewer" | "admin";
	reason: string;
	sequence: number;
	ver: number;
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	neg: number;
	cts: string;
	exp: string | null;
	sig: ArrayBuffer;
	signing_key_id: string;
	publication_pending: number;
	operator_action: string | null;
	operator_idempotency_key: string | null;
}

export function storedRowToIssuedLabel(row: StoredLabelRow): IssuedListingLabel {
	if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) {
		throw new Error("stored label has no allocated sequence");
	}
	const label = parseSignedListingLabel({
		ver: row.ver,
		src: row.src,
		uri: row.uri,
		...(row.cid === null ? {} : { cid: row.cid }),
		val: row.val,
		...(row.neg === 1 ? { neg: true } : {}),
		cts: row.cts,
		...(row.exp === null ? {} : { exp: row.exp }),
		sig: new Uint8Array(row.sig),
	});
	return {
		label,
		sequence: row.sequence,
		idempotencyKey: row.idempotency_key,
		actorDid: row.actor_did,
		actorRole: row.actor_role,
		reason: row.reason,
		...(row.assessment_id === null ? {} : { assessmentId: row.assessment_id }),
		...(row.assessment_policy_version === null
			? {}
			: { assessmentPolicyVersion: row.assessment_policy_version }),
		...(row.assessment_outcome === null
			? {}
			: { assessmentOutcome: parseAssessmentOutcome(row.assessment_outcome) }),
		...(row.operator_action_id === null ? {} : { operatorActionId: row.operator_action_id }),
		...(row.operator_action === null || row.operator_idempotency_key === null
			? {}
			: {
					operatorAction: {
						action: parseOperatorAction(row.operator_action),
						idempotencyKey: row.operator_idempotency_key,
					},
				}),
		signingKeyId: row.signing_key_id,
		publicationPending: row.publication_pending === 1,
	};
}

function parseAssessmentOutcome(
	value: string,
): NonNullable<IssuedListingLabel["assessmentOutcome"]> {
	switch (value) {
		case "pending":
		case "passed":
		case "review":
		case "error":
			return value;
		default:
			throw new Error("stored label has an unsupported assessment outcome");
	}
}

function parseOperatorAction(
	value: string,
): NonNullable<IssuedListingLabel["operatorAction"]>["action"] {
	switch (value) {
		case "approve":
		case "block":
		case "takedown":
		case "retract-takedown":
			return value;
		default:
			throw new Error("stored label has an unsupported operator action");
	}
}

export function labelFields(label: SignedListingLabel): readonly unknown[] {
	return [
		label.ver,
		label.src,
		label.uri,
		label.cid ?? null,
		label.val,
		label.neg === true ? 1 : 0,
		label.cts,
		label.exp ?? null,
		label.sig,
	];
}
