import type {
	SiteImportDecisions,
	SiteImportPlan,
	TransferOperation,
	TransferPage,
} from "../../../lib/api/transfer.js";

export function replaceOperation(
	page: TransferPage<TransferOperation> | undefined,
	operation: TransferOperation,
): TransferPage<TransferOperation> | undefined {
	if (!page) return page;
	const exists = page.items.some((item) => item.id === operation.id);
	return {
		...page,
		items: exists
			? page.items.map((item) => (item.id === operation.id ? operation : item))
			: [operation, ...page.items],
	};
}

const PRE_EXECUTION = new Set(["uploading", "analyzing", "planned"]);
const EXECUTING = new Set(["running", "verifying"]);
const STOPPED = new Set(["failed", "cancelled"]);

/** Whether an import still holds the site: not finished, or stopped after it started writing. */
export function isOccupyingImport(operation: TransferOperation): boolean {
	if (PRE_EXECUTION.has(operation.state) || EXECUTING.has(operation.state)) return true;
	return STOPPED.has(operation.state) && operation.mutationStartedAt !== null;
}

export function canCancelImport(operation: TransferOperation): boolean {
	return (
		(PRE_EXECUTION.has(operation.state) || EXECUTING.has(operation.state)) &&
		operation.cancelRequestedAt === null
	);
}

export function canAbandonImport(operation: TransferOperation): boolean {
	return STOPPED.has(operation.state) && operation.mutationStartedAt !== null;
}

/**
 * The import to show: one that still holds the site, otherwise the newest
 * import if it finished or stopped and has not been dismissed.
 */
export function selectCurrentImport(
	imports: readonly TransferOperation[],
	dismissed: ReadonlySet<string>,
): TransferOperation | null {
	const occupying = imports.find(isOccupyingImport);
	if (occupying) return occupying;
	const newest = imports[0];
	if (!newest || dismissed.has(newest.id)) return null;
	if (newest.state === "complete" || STOPPED.has(newest.state)) return newest;
	return null;
}

export type ImportView =
	| { view: "ineligible" }
	| { view: "choose" }
	| { view: "uploading" }
	| { view: "needs-file"; operation: TransferOperation }
	| { view: "analyzing"; operation: TransferOperation }
	| { view: "review"; operation: TransferOperation }
	| { view: "executing"; operation: TransferOperation }
	| { view: "complete"; operation: TransferOperation }
	| { view: "stopped"; operation: TransferOperation };

/**
 * Which step of the import flow to show. A planned import whose stage is
 * `reserve` has been asked to execute and waits for its first advance.
 *
 * @param eligible The site's portable domain is empty.
 * @param current The import being shown, if any.
 * @param uploading The browser is uploading a package right now.
 * @param filesMissing Declared files the server has not received, when known.
 */
export function importView(input: {
	eligible: boolean;
	current: TransferOperation | null;
	uploading: boolean;
	filesMissing: number | null;
}): ImportView {
	const { current } = input;
	if (input.uploading) return { view: "uploading" };
	if (!current) return input.eligible ? { view: "choose" } : { view: "ineligible" };
	switch (current.state) {
		case "uploading":
			return input.filesMissing === 0
				? { view: "analyzing", operation: current }
				: { view: "needs-file", operation: current };
		case "analyzing":
			return { view: "analyzing", operation: current };
		case "planned":
			return current.stage === "reserve"
				? { view: "executing", operation: current }
				: { view: "review", operation: current };
		case "running":
		case "verifying":
			return { view: "executing", operation: current };
		case "complete":
			return { view: "complete", operation: current };
		case "failed":
		case "cancelled":
			return { view: "stopped", operation: current };
		default:
			return input.eligible ? { view: "choose" } : { view: "ineligible" };
	}
}

export function sameDecisions(a: SiteImportDecisions, b: SiteImportDecisions): boolean {
	if (a.siteTitle !== b.siteTitle || a.siteTagline !== b.siteTagline) return false;
	const keys = new Set([...Object.keys(a.principalMappings), ...Object.keys(b.principalMappings)]);
	for (const key of keys) {
		if ((a.principalMappings[key] ?? null) !== (b.principalMappings[key] ?? null)) return false;
	}
	return true;
}

/** Whether the reviewed plan can be executed as shown. */
export function canConfirmPlan(input: {
	plan: Pick<SiteImportPlan, "blockers" | "decisions">;
	decisions: SiteImportDecisions;
	saving: boolean;
}): boolean {
	return (
		input.plan.blockers.length === 0 &&
		!input.saving &&
		sameDecisions(input.plan.decisions, input.decisions)
	);
}
