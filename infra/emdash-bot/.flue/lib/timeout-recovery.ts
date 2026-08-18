import type { DeliveredMessage } from "@flue/runtime";

import type { StateId } from "./machine.js";
import type { InvestigationMode } from "./router.js";

export const TIMEOUT_SUMMARY_SIGNAL_TYPE = "investigation.timeout-summary";
export const RESUME_SIGNAL_TYPE = "investigation.resume";
export const TIMEOUT_SUMMARY_TIMEOUT_MS = 2 * 60_000;
export const TIMEOUT_SUMMARY_MAX_CHARACTERS = 4_000;

interface SummaryVerification {
	readonly name: string;
	readonly command: string;
	readonly exitCode: number;
}

interface SummaryFailure {
	readonly stage: string;
	readonly message: string;
}

export function isTimeoutSummaryDelivery(delivery: DeliveredMessage): boolean {
	return delivery.kind === "signal" && delivery.type === TIMEOUT_SUMMARY_SIGNAL_TYPE;
}

export function buildTimeoutSummaryPrompt(input: {
	mode: InvestigationMode;
	verification: readonly SummaryVerification[];
	lastFailure: SummaryFailure | null;
}): string {
	const checks =
		input.verification.length === 0
			? "- No verification result was recorded."
			: input.verification
					.map(
						(record) =>
							`- ${record.name}: ${record.exitCode === 0 ? "passed" : `failed (exit ${record.exitCode})`} — \`${record.command}\``,
					)
					.join("\n");
	const failure = input.lastFailure
		? `\n\nLast recorded failure (${input.lastFailure.stage}): ${input.lastFailure.message}`
		: "";
	return [
		`The ${input.mode} execution window has ended and execution has been stopped.`,
		"No tools are available in this final turn. Do not attempt more investigation, edits, verification, or publication.",
		"Summarize the useful checkpoint for a later resume in concise plain text:",
		"- approach taken and important decisions;",
		"- files or areas changed;",
		"- verification that passed or failed;",
		"- the current blocker and exact remaining work.",
		"Do not claim a check passed or a candidate published unless the conversation proves it.",
		"",
		"Recorded verification:",
		checks + failure,
	].join("\n");
}

export function normalizeTimeoutSummary(text: string): string {
	const summary = text.trim();
	if (summary === "") {
		return "The run stopped at its execution deadline before it could provide a checkpoint summary.";
	}
	if (summary.length <= TIMEOUT_SUMMARY_MAX_CHARACTERS) return summary;
	return `${summary.slice(0, TIMEOUT_SUMMARY_MAX_CHARACTERS - 1)}…`;
}

export function resumeStateForMode(mode: InvestigationMode): StateId {
	switch (mode) {
		case "diagnose":
			return "investigating";
		case "implement":
		case "fix":
			return "fixing";
		case "repro":
		case "revise":
			return "working";
	}
}
