import type { OperatorAction } from "../api/types.js";
import { SUBJECT_ALPHA, SUBJECT_GAMMA } from "./subjects.js";

/**
 * Sample rows from the append-only `operator_actions` audit table (plan W9.2),
 * in the sanitized `serializeOperatorActionView` shape the server returns —
 * newest first, no internal replay fields.
 */
export const OPERATOR_ACTION_GAMMA_RETRACT: OperatorAction = {
	id: "oact_01J9ZK7Q2M4T8V0X2R4W6Y8B1C",
	actorType: "human",
	actorId: "access|8f2c1a90-6b3d-4e57-9a12-77c0de9b4a11",
	actorEmail: "reviewer@emdashcms.com",
	actorCommonName: null,
	role: "reviewer",
	action: "label-retract",
	subjectUri: SUBJECT_GAMMA.uri,
	subjectCid: SUBJECT_GAMMA.cid,
	labelValue: "malware",
	reason: "Retracting after upstream confirmed the flagged payload was a false positive.",
	createdAt: "2026-07-12T14:02:15.000Z",
};

export const OPERATOR_ACTION_ALPHA_RERUN: OperatorAction = {
	id: "oact_01J9YH3F5N7P9R1T3V5X7Z9A2B",
	actorType: "service",
	actorId: "access|ci-automation",
	actorEmail: null,
	actorCommonName: "ci-automation",
	role: "admin",
	action: "assessment-rerun",
	subjectUri: SUBJECT_ALPHA.uri,
	subjectCid: SUBJECT_ALPHA.cid,
	labelValue: null,
	reason: "Re-running against the updated policy version after the scanner upgrade.",
	createdAt: "2026-07-11T16:40:00.000Z",
};

export const FIXTURE_OPERATOR_ACTIONS: readonly OperatorAction[] = [
	OPERATOR_ACTION_GAMMA_RETRACT,
	OPERATOR_ACTION_ALPHA_RERUN,
];
