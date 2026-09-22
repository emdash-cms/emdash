import type { AggregatorReconciliationClient } from "../aggregator-reconciliation.js";
import type { AssessmentWorkflowBinding } from "../assessment/dispatch.js";
import type { AssessmentLifecycleStore } from "../assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../assessment/run-key.js";
import type { AssessmentVersionSet } from "../assessment/types.js";
import type { DiscoveryStreamItem } from "../discovery/events.js";
import type { LabelerReconciliationReport } from "./index.js";
import { ensureAssessmentWorkflowRuns } from "./workflows.js";

const NUMERIC_CURSOR_RE = /^[0-9]{1,32}$/;

export async function repairLabelerReconciliationFindings(input: {
	db: D1Database;
	report: LabelerReconciliationReport;
	lifecycle: AssessmentLifecycleStore;
	workflow: AssessmentWorkflowBinding;
	workflowPresence(runKey: string): Promise<"missing" | "existing" | "restartable">;
	restartWorkflow(runKey: string): Promise<void>;
	queue: { send(message: DiscoveryStreamItem): Promise<unknown> };
	authoritative: AggregatorReconciliationClient;
	versions: AssessmentVersionSet;
	now?: () => Date;
}): Promise<{ staleRuns: number; quarantineItems: number; unresolvedMissingLabels: number }> {
	const now = input.now ?? (() => new Date());
	const recoveryRuns = [];
	for (const stale of input.report.staleRuns) {
		const params = await createAssessmentWorkflowParams({
			subject: stale.subject,
			versions: input.versions,
			logicalTriggerId: `recovery:${stale.runKey}:${stale.state}`,
		});
		await input.lifecycle.observeRun({
			params,
			observedAt: now().toISOString(),
			makeCurrent: false,
		});
		recoveryRuns.push(params);
	}
	await ensureAssessmentWorkflowRuns({
		workflow: input.workflow,
		workflowPresence: input.workflowPresence,
		restartWorkflow: input.restartWorkflow,
		runs: recoveryRuns,
	});

	let repairedQuarantine = 0;
	for (const item of input.report.quarantinedItems) {
		const row = await input.db
			.prepare(
				`SELECT event_json, event_summary, event_id, order_key
				 FROM discovery_quarantine_events
				 WHERE quarantine_id = ? AND revision = ? AND requires_reconciliation = 1`,
			)
			.bind(item.quarantineId, item.revision)
			.first<{
				event_json: string | null;
				event_summary: string;
				event_id: string | null;
				order_key: string;
			}>();
		if (!row) continue;
		const summary = parseObject(row.event_summary);
		if (summary?.["operation"] === "delete" && typeof summary["uri"] === "string") {
			const current = await currentSubjectForUri(input.db, summary["uri"]);
			if (current) {
				if (await input.authoritative.isCurrentSubject(current.uri, current.cid)) continue;
				await input.lifecycle.cancelSubject(current.uri, now().toISOString());
			}
			if (await resolveQuarantine(input.db, item, now().toISOString())) {
				repairedQuarantine += 1;
			}
			continue;
		}
		if (row.event_json !== null) {
			const event: unknown = JSON.parse(row.event_json);
			await input.queue.send({
				cursor: numericRecoveryCursor(item.cursor),
				eventId: row.event_id ?? `recovery:${item.quarantineId}`,
				orderKey: row.order_key,
				event,
			});
			if (await resolveQuarantine(input.db, item, now().toISOString())) {
				repairedQuarantine += 1;
			}
		}
	}
	return {
		staleRuns: recoveryRuns.length,
		quarantineItems: repairedQuarantine,
		unresolvedMissingLabels: input.report.missingOutcomeLabels.length,
	};
}

async function currentSubjectForUri(
	db: D1Database,
	uri: string,
): Promise<{ uri: string; cid: string } | null> {
	const row = await db
		.prepare("SELECT uri, cid FROM current_subjects WHERE uri = ? AND deleted_at IS NULL")
		.bind(uri)
		.first<{ uri: string; cid: string }>();
	return row;
}

async function resolveQuarantine(
	db: D1Database,
	item: { quarantineId: string; revision: number },
	updatedAt: string,
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE discovery_quarantine_events
			 SET requires_reconciliation = 0, observed_at = ?
			 WHERE quarantine_id = ? AND revision = ? AND requires_reconciliation = 1`,
		)
		.bind(updatedAt, item.quarantineId, item.revision)
		.run();
	return result.meta.changes === 1;
}

function parseObject(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? Object.fromEntries(Object.entries(parsed))
			: null;
	} catch {
		return null;
	}
}

function numericRecoveryCursor(value: string): string {
	return NUMERIC_CURSOR_RE.test(value) ? value : String(Date.now() * 1_000);
}
