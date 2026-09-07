import type { InvestigationMode } from "./router.js";

const READ_RUN_BUDGET_MS = 30 * 60_000;
const WRITE_RUN_BUDGET_MS = 60 * 60_000;
const RUN_START_HEADROOM_MS = 5 * 60_000;

export const BOOTSTRAP_TIMEOUT_MS = 15 * 60_000;
export const CONTAINER_PREPARE_TIMEOUT_MS = BOOTSTRAP_TIMEOUT_MS + 10 * 60_000;
export const DEADLINE_WARNING_LEAD_MS = 10 * 60_000;
export const FLUE_RUN_TIMEOUT_MS =
	WRITE_RUN_BUDGET_MS + CONTAINER_PREPARE_TIMEOUT_MS + RUN_START_HEADROOM_MS;
export const SANDBOX_SLEEP_AFTER_SECONDS = (FLUE_RUN_TIMEOUT_MS + 5 * 60_000) / 1_000;
export const DEADLINE_WARNING_MESSAGE =
	"About 10 minutes remain. Stop broad investigation, finish the smallest correct change, run the required verification, and publish and report if possible. If completion is not possible, report a useful partial or failure outcome now. This warning does not extend the deadline.";

export function isWriteMode(mode: InvestigationMode): boolean {
	return mode === "implement" || mode === "fix" || mode === "revise";
}

export function runBudgetMs(mode: InvestigationMode): number {
	return isWriteMode(mode) ? WRITE_RUN_BUDGET_MS : READ_RUN_BUDGET_MS;
}

export function runSchedule(
	mode: InvestigationMode,
	startedAt: number,
	warningDelivered: boolean,
): {
	deadlineAt: number;
	warningAt: number | null;
	nextAlarmAt: number;
} {
	const deadlineAt = startedAt + runBudgetMs(mode);
	const warningAt =
		isWriteMode(mode) && !warningDelivered ? deadlineAt - DEADLINE_WARNING_LEAD_MS : null;
	return {
		deadlineAt,
		warningAt,
		nextAlarmAt: warningAt ?? deadlineAt,
	};
}
