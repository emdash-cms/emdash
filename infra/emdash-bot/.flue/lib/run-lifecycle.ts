import {
	RUN_PHASES,
	runMachineSnapshot,
	runPlan,
	type RunMode,
	type RunPhaseId,
	type RunStatus,
} from "./machine.js";
import { runBudgetMs } from "./run-policy.js";

export { RUN_PHASES, runMachineSnapshot, runPlan };
export type { RunMode, RunPhaseId, RunStatus };

export type RunProgressKind =
	| "workspace_installing"
	| "workspace_building"
	| "workspace_ready"
	| "workspace_failed"
	| "verification_passed"
	| "verification_failed"
	| "candidate_publishing"
	| "candidate_published";

export interface RunLifecycle {
	readonly runId: string;
	readonly mode: RunMode;
	readonly status: RunStatus;
	readonly phase: RunPhaseId;
	readonly plan: readonly RunPhaseId[];
	readonly attempt: number;
	readonly createdAt: number;
	readonly startedAt: number;
	readonly deadlineAt: number;
	readonly completedAt: number | null;
}

export type PublicRunLifecycle = Omit<RunLifecycle, "runId">;

export function startRunLifecycle(input: {
	runId: string;
	mode: RunMode;
	startedAt: number;
}): RunLifecycle {
	return {
		runId: input.runId,
		mode: input.mode,
		status: "running",
		phase: "prepare",
		plan: runPlan(input.mode),
		attempt: 1,
		createdAt: input.startedAt,
		startedAt: input.startedAt,
		deadlineAt: input.startedAt + runBudgetMs(input.mode),
		completedAt: null,
	};
}

export function resumeRunLifecycle(run: RunLifecycle, startedAt: number): RunLifecycle {
	return {
		...run,
		status: "running",
		attempt: run.attempt + 1,
		startedAt,
		deadlineAt: startedAt + runBudgetMs(run.mode),
		completedAt: null,
	};
}

export function beginRunLifecycle(run: RunLifecycle, startedAt: number): RunLifecycle {
	if (run.status !== "running" || run.phase !== "prepare") return run;
	return {
		...run,
		startedAt,
		deadlineAt: startedAt + runBudgetMs(run.mode),
	};
}

export function advanceRunLifecycle(run: RunLifecycle, progress: RunProgressKind): RunLifecycle {
	if (run.status !== "running") return run;
	const target = progressPhase(run, progress);
	if (!target) return run;
	const currentIndex = run.plan.indexOf(run.phase);
	const targetIndex = run.plan.indexOf(target);
	if (targetIndex < currentIndex) return run;
	return { ...run, phase: target };
}

export function settleRunLifecycle(
	run: RunLifecycle,
	status: Exclude<RunStatus, "running">,
	completedAt: number,
): RunLifecycle {
	return {
		...run,
		status,
		phase: status === "succeeded" ? "report" : run.phase,
		completedAt,
	};
}

export function publicRunLifecycle(run: RunLifecycle): PublicRunLifecycle {
	const { runId: _runId, ...publicRun } = run;
	return publicRun;
}

function progressPhase(run: RunLifecycle, progress: RunProgressKind): RunPhaseId | null {
	switch (progress) {
		case "workspace_installing":
		case "workspace_building":
			return "prepare";
		case "workspace_ready":
			return run.plan[1] ?? "report";
		case "verification_passed":
		case "verification_failed":
			return run.plan.includes("verify") ? "verify" : null;
		case "candidate_publishing":
			return run.plan.includes("publish") ? "publish" : null;
		case "candidate_published":
			return "report";
		case "workspace_failed":
			return null;
	}
}
