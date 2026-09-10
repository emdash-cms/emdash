import { dispatchAssessmentRuns, type AssessmentWorkflowBinding } from "../assessment/dispatch.js";
import type { AssessmentLifecycleStore } from "../assessment/lifecycle.js";
import { createAssessmentWorkflowParams } from "../assessment/run-key.js";
import type { AssessmentVersionSet, AssessmentWorkflowParams } from "../assessment/types.js";
import type { DiscoveryCursorStore } from "./cursor.js";
import { parseDiscoveryEvent, type DiscoveryStreamItem } from "./events.js";

const MAX_WORKFLOW_BATCH = 100;
const CURSOR_RE = /^\d{1,32}$/;

export interface DiscoveryConsumerDependencies {
	workflow: AssessmentWorkflowBinding;
	cursor: DiscoveryCursorStore;
	lifecycle: AssessmentLifecycleStore;
	quarantine: DiscoveryQuarantineStore;
	versions: AssessmentVersionSet;
	now?: () => Date;
}

export interface DiscoveryQuarantineStore {
	write(entry: {
		cursor: string;
		reason: string;
		eventSummary: string;
		requiresReconciliation: true;
		observedAt: string;
	}): Promise<void>;
}

export async function consumeDiscoveryItems(
	items: readonly DiscoveryStreamItem[],
	dependencies: DiscoveryConsumerDependencies,
): Promise<{
	cursor: string | null;
	dispatchedRunKeys: readonly string[];
	quarantinedCursors: readonly string[];
}> {
	let cursor = await dependencies.cursor.read();
	const pending: AssessmentWorkflowParams[] = [];
	const dispatchedRunKeys: string[] = [];
	const quarantinedCursors: string[] = [];
	const now = dependencies.now ?? (() => new Date());

	const flushWorkflows = async (): Promise<void> => {
		if (pending.length > 0) {
			const dispatched = await dispatchAssessmentRuns(dependencies.workflow, pending);
			dispatchedRunKeys.push(...dispatched.acceptedRunKeys);
			pending.length = 0;
		}
	};
	const advance = async (nextCursor: string): Promise<void> => {
		const observedAt = now().toISOString();
		if (!(await dependencies.cursor.advance(cursor, nextCursor, observedAt))) {
			throw new Error("discovery cursor changed concurrently");
		}
		cursor = nextCursor;
	};

	for (const item of items) {
		assertCursor(item.cursor);
		if (cursor !== null && compareCursors(item.cursor, cursor) <= 0) continue;
		let hint: ReturnType<typeof parseDiscoveryEvent>;
		try {
			hint = parseDiscoveryEvent(item.event);
		} catch (error) {
			await flushWorkflows();
			await dependencies.quarantine.write({
				cursor: item.cursor,
				reason: boundedErrorMessage(error),
				eventSummary: summarizeDiscoveryEvent(item.event),
				requiresReconciliation: true,
				observedAt: now().toISOString(),
			});
			quarantinedCursors.push(item.cursor);
			await advance(item.cursor);
			continue;
		}
		if (!hint) {
			await flushWorkflows();
			await advance(item.cursor);
			continue;
		}
		if (hint.operation === "delete") {
			await flushWorkflows();
			await dependencies.quarantine.write({
				cursor: item.cursor,
				reason: "delete-requires-authoritative-reconciliation",
				eventSummary: JSON.stringify({ operation: "delete", uri: hint.uri }),
				requiresReconciliation: true,
				observedAt: now().toISOString(),
			});
			quarantinedCursors.push(item.cursor);
			await advance(item.cursor);
			continue;
		}
		const params = await createAssessmentWorkflowParams({
			subject: { uri: hint.uri, cid: hint.cid, kind: hint.kind },
			versions: dependencies.versions,
			logicalTriggerId: `event:${item.cursor}`,
		});
		await dependencies.lifecycle.observeRun({ params, observedAt: now().toISOString() });
		pending.push(params);
		if (pending.length === MAX_WORKFLOW_BATCH) {
			await flushWorkflows();
			await advance(item.cursor);
		}
	}
	if (pending.length > 0) {
		await flushWorkflows();
		await advance(items.at(-1)!.cursor);
	}
	return { cursor, dispatchedRunKeys, quarantinedCursors };
}

function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, 500);
}

function summarizeDiscoveryEvent(value: unknown): string {
	if (!isPlainObject(value)) return JSON.stringify({ type: typeof value });
	const commit = isPlainObject(value["commit"]) ? value["commit"] : {};
	return JSON.stringify({
		did: boundedString(value["did"]),
		kind: boundedString(value["kind"]),
		commit: {
			operation: boundedString(commit["operation"]),
			collection: boundedString(commit["collection"]),
			rkey: boundedString(commit["rkey"]),
			cid: boundedString(commit["cid"]),
		},
	});
}

function boundedString(value: unknown): string | undefined {
	return typeof value === "string" ? value.slice(0, 512) : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function createReconciliationRun(
	subject: { uri: string; cid: string; kind: "profile" | "release" },
	logicalTriggerId: string,
	dependencies: DiscoveryConsumerDependencies,
): Promise<string> {
	const params = await createAssessmentWorkflowParams({
		subject,
		versions: dependencies.versions,
		logicalTriggerId,
	});
	await dependencies.lifecycle.observeRun({
		params,
		observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
		makeCurrent: false,
	});
	await dispatchAssessmentRuns(dependencies.workflow, [params]);
	return params.runKey;
}

function assertCursor(cursor: string): void {
	if (!CURSOR_RE.test(cursor)) throw new TypeError("discovery cursor is invalid");
}

function compareCursors(left: string, right: string): number {
	const leftValue = BigInt(left);
	const rightValue = BigInt(right);
	return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
