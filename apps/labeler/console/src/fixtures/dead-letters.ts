import type { DeadLetter } from "../api/types.js";

/** Sample `dead_letters` rows for offline UI work and tests — a new (actionable)
 * letter, a retried one, and a quarantined one, newest first. */
export const FIXTURE_DEAD_LETTERS: DeadLetter[] = [
	{
		id: 3,
		did: "did:plc:publisher000000000000000003",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rk-new",
		reason: "INVALID_PROOF",
		detail: "MST proof did not verify",
		status: "new",
		receivedAt: "2026-07-13 09:15:00",
		resolvedAt: null,
		resolvedByActionId: null,
	},
	{
		id: 2,
		did: "did:plc:publisher000000000000000002",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rk-retried",
		reason: "PDS_HTTP_ERROR",
		detail: "502 from PDS",
		status: "retried",
		receivedAt: "2026-07-13 08:40:00",
		resolvedAt: "2026-07-13 09:00:00",
		resolvedByActionId: "oact_fixture_retry",
	},
	{
		id: 1,
		did: "did:plc:publisher000000000000000001",
		collection: "com.emdashcms.experimental.package.release",
		rkey: "rk-quarantined",
		reason: "RECORD_NOT_FOUND",
		detail: null,
		status: "quarantined",
		receivedAt: "2026-07-13 08:00:00",
		resolvedAt: "2026-07-13 08:20:00",
		resolvedByActionId: "oact_fixture_quarantine",
	},
];
