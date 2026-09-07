import type { RunMode, RunStatus } from "./machine.js";

export type WorkCommentStatus = RunStatus | "needs_follow_up";

export const WORK_PLAN_STEP_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"blocked",
	"skipped",
] as const;

export type WorkPlanStepStatus = (typeof WORK_PLAN_STEP_STATUSES)[number];

export interface WorkPlanStep {
	readonly id: string;
	readonly title: string;
	readonly status: WorkPlanStepStatus;
}

export interface WorkPlan {
	readonly summary: string;
	readonly steps: readonly WorkPlanStep[];
	readonly updatedAt: number;
}

export interface WorkPlanInput {
	readonly summary: string;
	readonly steps: readonly WorkPlanStep[];
}

const STEP_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_STEPS = 8;
const MAX_SUMMARY_LENGTH = 240;
const MAX_STEP_TITLE_LENGTH = 120;

export function updateWorkPlan(
	previous: WorkPlan | null,
	input: WorkPlanInput,
	updatedAt: number,
): WorkPlan {
	const summary = boundedSummary(input.summary);
	const ids = new Set<string>();
	const steps = input.steps.map((step) => {
		const id = step.id.trim();
		if (!STEP_ID.test(id)) throw new Error(`invalid work plan step id: ${id}`);
		if (ids.has(id)) throw new Error("work plan step ids must be unique");
		ids.add(id);
		if (!WORK_PLAN_STEP_STATUSES.includes(step.status)) {
			throw new Error(`invalid work plan step status: ${step.status}`);
		}
		return {
			id,
			title: boundedText(step.title, MAX_STEP_TITLE_LENGTH, `work plan step ${id}`),
			status: step.status,
		};
	});
	if (steps.filter((step) => step.status === "in_progress").length > 1) {
		throw new Error("work plan may have at most one in-progress step");
	}
	if (previous) preserveFinishedSteps(previous.steps, steps);
	if (steps.length === 0 || steps.length > MAX_STEPS) {
		throw new Error(`work plan must contain between 1 and ${MAX_STEPS} steps`);
	}
	return { summary, steps, updatedAt };
}

export function renderWorkPlanComment(input: {
	plan: WorkPlan;
	mode: RunMode;
	status: WorkCommentStatus;
	outcome?: string | null;
}): string {
	const heading =
		input.status === "running"
			? "Working on it"
			: input.status === "succeeded"
				? "Completed"
				: input.status === "needs_follow_up"
					? "Needs follow-up"
					: input.status === "timed_out"
						? "Timed out"
						: input.status === "cancelled"
							? "Cancelled"
							: "Failed";
	const lines = [
		`### ${heading}`,
		"",
		escapeMarkdown(input.plan.summary),
		"",
		...input.plan.steps.map(renderStep),
	];
	if (input.outcome) {
		lines.push("", `**Outcome:** ${escapeMarkdown(input.outcome)}`);
	}
	lines.push("", `_Mode: ${input.mode.replaceAll("_", " ")}_`);
	return lines.join("\n");
}

export function renderPreparingWorkPlanComment(input: { mode: RunMode; summary: string }): string {
	return [
		"### Preparing workspace",
		"",
		escapeMarkdown(boundedSummary(input.summary)),
		"",
		"Installing dependencies and building the repository before the agent starts.",
		"",
		`_Mode: ${input.mode.replaceAll("_", " ")}_`,
	].join("\n");
}

function preserveFinishedSteps(
	previous: readonly WorkPlanStep[],
	next: readonly WorkPlanStep[],
): void {
	for (const prior of previous) {
		if (prior.status !== "completed" && prior.status !== "skipped") continue;
		const current = next.find((step) => step.id === prior.id);
		if (!current) throw new Error(`${prior.status} step ${prior.id} is missing`);
		if (current.status !== prior.status) {
			throw new Error(`${prior.status} step ${prior.id} cannot return to ${current.status}`);
		}
		if (current.title !== prior.title) {
			throw new Error(`${prior.status} step ${prior.id} cannot change its title`);
		}
	}
}

function boundedText(value: string, limit: number, label: string): string {
	const normalized = normalizedText(value, label);
	if (normalized.length > limit) throw new Error(`${label} exceeds ${limit} characters`);
	return normalized;
}

function boundedSummary(value: string): string {
	const normalized = normalizedText(value, "work plan summary");
	if (normalized.length <= MAX_SUMMARY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`;
}

function normalizedText(value: string, label: string): string {
	const normalized = value.replaceAll(/\s+/g, " ").trim();
	if (normalized === "") throw new Error(`${label} cannot be empty`);
	return normalized;
}

function renderStep(step: WorkPlanStep): string {
	const title = escapeMarkdown(step.title);
	switch (step.status) {
		case "completed":
			return `- [x] ${title}`;
		case "in_progress":
			return `- [ ] **${title}**`;
		case "blocked":
			return `- [ ] **${title}** — blocked`;
		case "skipped":
			return `- [x] ~~${title}~~ — skipped`;
		case "pending":
			return `- [ ] ${title}`;
	}
}

function escapeMarkdown(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll(/([\\`*_{}()#+|])/g, "\\$1")
		.replaceAll("~", "\\~")
		.replaceAll("[", "\\[")
		.replaceAll("]", "\\]");
}
