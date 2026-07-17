import type {
	ReconsiderationDetail,
	ReconsiderationNoteView,
	ReconsiderationView,
} from "../api/types.js";
import { ASSESSMENT_BETA, ASSESSMENT_GAMMA } from "./assessments.js";
import { SUBJECT_BETA, SUBJECT_GAMMA } from "./subjects.js";

/** An open case for the blocked gamma release — a publisher has asked the
 * reviewers to reconsider the malware finding. */
export const RECONSIDERATION_GAMMA_OPEN: ReconsiderationView = {
	id: "recon_01J9ZM8R3N5U9W1Y3T5X7Z9C2D",
	subjectUri: SUBJECT_GAMMA.uri,
	subjectCid: SUBJECT_GAMMA.cid,
	triggeringAssessmentId: ASSESSMENT_GAMMA.id,
	state: "open",
	outcome: null,
	openedById: "access|8f2c1a90-6b3d-4e57-9a12-77c0de9b4a11",
	openedByEmail: "reviewer@emdashcms.com",
	openedByCommonName: null,
	openedByRole: "reviewer",
	openedAt: "2026-07-13T10:05:00.000Z",
	resolvedById: null,
	resolvedByEmail: null,
	resolvedByCommonName: null,
	resolvedAt: null,
	outcomeActionId: null,
};

/** A resolved (granted) case for the warned beta release. */
export const RECONSIDERATION_BETA_GRANTED: ReconsiderationView = {
	id: "recon_01J9YJ4G6P8R0T2V4X6Z8B0D3E",
	subjectUri: SUBJECT_BETA.uri,
	subjectCid: SUBJECT_BETA.cid,
	triggeringAssessmentId: ASSESSMENT_BETA.id,
	state: "resolved",
	outcome: "granted",
	openedById: "access|8f2c1a90-6b3d-4e57-9a12-77c0de9b4a11",
	openedByEmail: "reviewer@emdashcms.com",
	openedByCommonName: null,
	openedByRole: "reviewer",
	openedAt: "2026-07-12T09:00:00.000Z",
	resolvedById: "access|2a7d4c31-9e02-4b18-b5f6-1c8e0a4f2b90",
	resolvedByEmail: "admin@emdashcms.com",
	resolvedByCommonName: null,
	resolvedAt: "2026-07-12T15:30:00.000Z",
	outcomeActionId: "oact_01J9YK5H7Q9S1U3W5Y7A9C1E4F",
};

const GAMMA_NOTES: ReconsiderationNoteView[] = [
	{
		id: "rnote_01J9ZM9A0B2C4E6G8J0M2P4R6T",
		reconsiderationId: RECONSIDERATION_GAMMA_OPEN.id,
		authorId: RECONSIDERATION_GAMMA_OPEN.openedById,
		authorEmail: "reviewer@emdashcms.com",
		authorCommonName: null,
		authorRole: "reviewer",
		note: "Publisher disputes the malware flag; says the payload is a security-research proof-of-concept.",
		createdAt: "2026-07-13T10:05:00.000Z",
	},
	{
		id: "rnote_01J9ZMB1C3D5F7H9K1N3Q5S7U",
		reconsiderationId: RECONSIDERATION_GAMMA_OPEN.id,
		authorId: "access|2a7d4c31-9e02-4b18-b5f6-1c8e0a4f2b90",
		authorEmail: "admin@emdashcms.com",
		authorCommonName: null,
		authorRole: "admin",
		note: "Re-running the scanner against the pinned artifact before deciding.",
		createdAt: "2026-07-13T11:20:00.000Z",
	},
];

const BETA_NOTES: ReconsiderationNoteView[] = [
	{
		id: "rnote_01J9YJ5B2D4F6H8K0M2P4R6T8V",
		reconsiderationId: RECONSIDERATION_BETA_GRANTED.id,
		authorId: RECONSIDERATION_BETA_GRANTED.openedById,
		authorEmail: "reviewer@emdashcms.com",
		authorCommonName: null,
		authorRole: "reviewer",
		note: "Low-quality packaging warning contested — the manifest was fixed in a follow-up release.",
		createdAt: "2026-07-12T09:00:00.000Z",
	},
	{
		id: "rnote_01J9YK6C3E5G7J9L1N3Q5S7U9W",
		reconsiderationId: RECONSIDERATION_BETA_GRANTED.id,
		authorId: "access|2a7d4c31-9e02-4b18-b5f6-1c8e0a4f2b90",
		authorEmail: "admin@emdashcms.com",
		authorCommonName: null,
		authorRole: "admin",
		note: "Confirmed the warning no longer applies. Granting.",
		createdAt: "2026-07-12T15:30:00.000Z",
	},
];

/** Newest first, matching the labeler's `getReconsiderationsPage` ordering. */
export const FIXTURE_RECONSIDERATIONS: readonly ReconsiderationView[] = [
	RECONSIDERATION_GAMMA_OPEN,
	RECONSIDERATION_BETA_GRANTED,
];

/** Case detail (case + oldest-first note thread) keyed by case id. */
export const FIXTURE_RECONSIDERATION_DETAIL: Record<string, ReconsiderationDetail> = {
	[RECONSIDERATION_GAMMA_OPEN.id]: {
		reconsideration: RECONSIDERATION_GAMMA_OPEN,
		notes: GAMMA_NOTES,
	},
	[RECONSIDERATION_BETA_GRANTED.id]: {
		reconsideration: RECONSIDERATION_BETA_GRANTED,
		notes: BETA_NOTES,
	},
};
