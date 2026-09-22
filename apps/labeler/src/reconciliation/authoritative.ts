import type { AggregatorReconciliationClient } from "../aggregator-reconciliation.js";
import type { AssessmentWorkflowBinding } from "../assessment/dispatch.js";
import type { AssessmentLifecycleStore } from "../assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../assessment/run-key.js";
import type { AssessmentVersionSet } from "../assessment/types.js";
import { ensureAssessmentWorkflowRuns, type ReconciliationWorkflowPresence } from "./workflows.js";

export interface AuthoritativeCursorStore {
	read(): Promise<string | null>;
	write(cursor: string | null, observedAt: string): Promise<void>;
}

export async function reconcileAuthoritativeRegistry(input: {
	client: AggregatorReconciliationClient;
	cursor: AuthoritativeCursorStore;
	lifecycle: AssessmentLifecycleStore;
	workflow: AssessmentWorkflowBinding;
	workflowPresence(runKey: string): Promise<ReconciliationWorkflowPresence>;
	restartWorkflow(runKey: string): Promise<void>;
	versions: AssessmentVersionSet;
	now?: () => Date;
	limit?: number;
}): Promise<{ observed: number; dispatched: number; nextCursor: string | null }> {
	const limit = input.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
		throw new TypeError("authoritative reconciliation limit is invalid");
	}
	const currentCursor = await input.cursor.read();
	const page = await input.client.listCurrentSubjects(currentCursor ?? undefined, limit);
	const now = (input.now ?? (() => new Date()))().toISOString();
	const runs = [];
	for (const subject of page.items) {
		const params = await createAssessmentWorkflowParams({
			subject,
			versions: input.versions,
			logicalTriggerId: await triggerId(subject.uri, subject.cid),
		});
		await input.lifecycle.observeRun({ params, observedAt: now, makeCurrent: true });
		runs.push(params);
	}
	const ensured = await ensureAssessmentWorkflowRuns({
		workflow: input.workflow,
		workflowPresence: input.workflowPresence,
		restartWorkflow: input.restartWorkflow,
		runs,
	});
	const nextCursor = page.nextCursor ?? null;
	await input.cursor.write(nextCursor, now);
	return {
		observed: page.items.length,
		dispatched: ensured.dispatchedRunKeys.length + ensured.restartedRunKeys.length,
		nextCursor,
	};
}

export function createD1AuthoritativeCursorStore(
	db: D1Database,
	stream = "aggregator-authoritative",
): AuthoritativeCursorStore {
	return {
		async read() {
			const row = await db
				.prepare("SELECT cursor FROM ingest_state WHERE stream = ?")
				.bind(stream)
				.first<{ cursor: string | null }>();
			return row?.cursor ?? null;
		},
		async write(cursor, observedAt) {
			await db
				.prepare(
					`INSERT INTO ingest_state (stream, cursor, last_observed_at, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(stream) DO UPDATE SET
					   cursor = excluded.cursor,
					   last_observed_at = excluded.last_observed_at,
					   updated_at = excluded.updated_at`,
				)
				.bind(stream, cursor, observedAt, observedAt)
				.run();
		},
	};
}

async function triggerId(uri: string, cid: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([uri, cid]))),
	);
	return `authoritative-v1-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
