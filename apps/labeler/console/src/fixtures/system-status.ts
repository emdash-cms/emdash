import type { SystemStatusSnapshot } from "../api/types.js";

/** Matches the `LABELER_DID` / discovery-queue bindings in wrangler.jsonc. */
export const FIXTURE_SYSTEM_STATUS: SystemStatusSnapshot = {
	labelerDid: "did:web:labels.emdashcms.com",
	jetstreamConnected: true,
	pendingAssessments: 1,
	discoveryQueueDepth: 3,
	lastReconciliationAt: "2026-07-13T07:45:00.000Z",
};
