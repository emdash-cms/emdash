import type { SystemStatusSnapshot } from "../api/types.js";

/** Matches the `LABELER_DID` binding in wrangler.jsonc. */
export const FIXTURE_SYSTEM_STATUS: SystemStatusSnapshot = {
	labelerDid: "did:web:labels.emdashcms.com",
	jetstreamConnected: true,
	pendingAssessments: 1,
	deadLetterDepth: 2,
	automationPaused: false,
	pausedReason: null,
	pausedSince: null,
};
