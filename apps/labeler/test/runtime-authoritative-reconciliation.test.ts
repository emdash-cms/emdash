import { describe, expect, it } from "vitest";

import type { AssessmentLifecycleStore } from "../src/assessment/lifecycle.js";
import { reconcileAuthoritativeRegistry } from "../src/reconciliation/authoritative.js";
import { ASSESSMENT_VERSIONS, PROFILE_CID, PROFILE_URI } from "./assessment-fixtures.js";

describe("authoritative registry reconciliation", () => {
	it("creates and dispatches a deterministic run for a subject missed by Jetstream", async () => {
		const observed: string[] = [];
		const dispatched: string[] = [];
		let cursor: string | null = null;
		const report = await reconcileAuthoritativeRegistry({
			client: {
				async listCurrentSubjects() {
					return {
						items: [{ uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" as const }],
						nextCursor: PROFILE_URI,
					};
				},
				isCurrentSubject: async () => true,
			},
			cursor: {
				read: async () => cursor,
				async write(next) {
					cursor = next;
				},
			},
			lifecycle: lifecycle(observed),
			workflow: {
				async createBatch(batch) {
					dispatched.push(...batch.map(({ id }) => id));
					return [];
				},
			},
			workflowPresence: async () => "missing",
			restartWorkflow: async () => undefined,
			versions: ASSESSMENT_VERSIONS,
			now: () => new Date("2026-08-25T09:00:00.000Z"),
		});
		expect(report).toEqual({ observed: 1, dispatched: 1, nextCursor: PROFILE_URI });
		expect(observed).toHaveLength(1);
		expect(dispatched).toEqual(observed);
		expect(cursor).toBe(PROFILE_URI);
	});
});

function lifecycle(observed: string[]): AssessmentLifecycleStore {
	return {
		async observeRun({ params }) {
			observed.push(params.runKey);
			return {
				runKey: params.runKey,
				subject: { uri: params.subjectUri, cid: params.subjectCid, kind: params.subjectKind },
				state: "pending",
				stateVersion: 0,
				deleted: false,
			};
		},
		getRun: async () => null,
		startRun: async () => {
			throw new Error("not used");
		},
		persistPrepared: async () => {
			throw new Error("not used");
		},
		finalizeRun: async () => {
			throw new Error("not used");
		},
		cancelSubject: async () => undefined,
	};
}
