import { limitUtf8Text } from "./byte-budget.js";
import type { ReviewStage } from "./review-watchdog.js";

const MAX_PUBLIC_ERROR_BYTES = 400;
const WHITESPACE = /\s+/g;
const SKILL_ERROR_PREFIX = /^skill\("[^"]+"\) failed:\s*/;

function errorDetail(error: unknown): string {
	const raw =
		error instanceof Error
			? error.message || error.name
			: typeof error === "string"
				? error
				: "Unknown review error";
	const normalized = raw.replaceAll(WHITESPACE, " ").trim();
	const unwrapped = normalized.replace(SKILL_ERROR_PREFIX, "");
	return limitUtf8Text(unwrapped, MAX_PUBLIC_ERROR_BYTES, "…");
}

export function formatReviewFailureSummary(stage: ReviewStage, error: unknown): string {
	return `The review failed during the \`${stage}\` stage: ${errorDetail(error)} Reapply the \`bot:review\` label to retry.`;
}
