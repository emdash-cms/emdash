// Runs every configured reviewer on the same PR head in parallel, then merges
// the reviews that completed. A reviewer that fails is reported as unavailable;
// the run fails only when no reviewer completes.

import type { Usage } from "@earendil-works/pi-ai/compat";

import { withCapacityRetry } from "./capacity.js";
import {
	mergeReviews,
	withReviewFooter,
	type MergeOutcome,
	type ReviewerResult,
} from "./review-merge.js";
import type { ReviewPlan } from "./review-model.js";
import type { ReviewResult } from "./review-schema.js";
import { DEFAULT_MAX_SUGGESTIONS, scopeReview, type ChangedLines } from "./review-scope.js";

const WORKERS_AI_REVIEW_TIMEOUT_MS = 30 * 60_000;
const GATEWAY_REVIEW_TIMEOUT_MS = 15 * 60_000;
export const REVIEWER_ATTEMPTS = 3;
/** Every reviewer, including capacity retries, must finish within this window. */
export const REVIEW_PHASE_LIMIT_MS = 45 * 60_000;
export const MERGE_TIMEOUT_MS = 5 * 60_000;
export const MERGE_ATTEMPTS = 2;
/**
 * Upper bound for the whole model_review stage: the reviewers and the merge.
 */
export const MODEL_REVIEW_STAGE_LIMIT_MS =
	REVIEW_PHASE_LIMIT_MS + MERGE_ATTEMPTS * MERGE_TIMEOUT_MS + 60_000;

export function reviewerTimeoutMs(model: string): number {
	return model.startsWith("cloudflare/") ? WORKERS_AI_REVIEW_TIMEOUT_MS : GATEWAY_REVIEW_TIMEOUT_MS;
}

export interface ModelCall<T> {
	readonly data: T;
	readonly usage?: Usage;
}

export interface ReviewPanelDeps {
	review(model: string, signal: AbortSignal): PromiseLike<ModelCall<ReviewResult>>;
	merge?(model: string, prompt: string, signal: AbortSignal): Promise<ModelCall<string>>;
	log(message: string, fields: Record<string, unknown>): void;
}

export interface ReviewerRun {
	readonly model: string;
	readonly durationMs: number;
	readonly result?: ReviewResult;
	readonly error?: unknown;
}

export type MergePath = "only_reviewer" | "single_reviewer" | MergeOutcome["source"];

export interface ReviewPanelOutcome {
	readonly result: ReviewResult;
	readonly runs: readonly ReviewerRun[];
	readonly mergePath: MergePath;
}

function errorFields(error: unknown): Record<string, unknown> {
	if (error === undefined) return {};
	return {
		errorClass: error instanceof Error ? error.name : typeof error,
		error: (error instanceof Error ? error.message : JSON.stringify(error)).slice(0, 500),
	};
}

function usageFields(usage: Usage | undefined): Record<string, unknown> {
	if (!usage) return {};
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		costUsd: Number(usage.cost.total.toFixed(4)),
	};
}

function anySignal(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
	return AbortSignal.any(signals.filter((signal): signal is AbortSignal => signal !== undefined));
}

async function runReviewer(
	model: string,
	deps: ReviewPanelDeps,
	signal: AbortSignal | undefined,
): Promise<ReviewerRun> {
	const startedAt = Date.now();
	const phase = anySignal([signal, AbortSignal.timeout(REVIEW_PHASE_LIMIT_MS)]);
	let run: ReviewerRun;
	let usage: Usage | undefined;
	try {
		const response = await withCapacityRetry((attemptSignal) => deps.review(model, attemptSignal), {
			label: `review:${model}`,
			attempts: REVIEWER_ATTEMPTS,
			perAttemptTimeoutMs: reviewerTimeoutMs(model),
			signal: phase,
			onRetry: ({ attempt, delayMs, error }) =>
				deps.log("reviewer over capacity, backing off", {
					model,
					attempt,
					delayMs,
					...errorFields(error),
				}),
		});
		usage = response.usage;
		run = { model, durationMs: Date.now() - startedAt, result: response.data };
	} catch (error) {
		run = { model, durationMs: Date.now() - startedAt, error };
	}
	deps.log("reviewer finished", {
		model,
		ok: run.result !== undefined,
		durationMs: run.durationMs,
		verdict: run.result?.verdict,
		findingCount: run.result?.findings.length,
		...usageFields(usage),
		...errorFields(run.error),
	});
	return run;
}

function parseJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("merge reply contained no JSON object");
	return JSON.parse(text.slice(start, end + 1));
}

function list(models: readonly string[]): string {
	const quoted = models.map((model) => `\`${model}\``);
	return quoted.length <= 2
		? quoted.join(" and ")
		: `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

function footer(runs: readonly ReviewerRun[]) {
	const completed = runs.filter((run) => run.result).map((run) => run.model);
	const unavailable = runs.filter((run) => !run.result).map((run) => run.model);
	const sentence = `Reviewed by ${list(completed)}.`;
	return unavailable.length === 0
		? sentence
		: `${sentence} ${list(unavailable)} ${unavailable.length === 1 ? "was" : "were"} unavailable.`;
}

export interface ReviewPanelOptions {
	readonly priorReview?: string;
	readonly signal?: AbortSignal;
	/** Lines changed since the last reviewed head, for a scoped follow-up review. */
	readonly changed?: ChangedLines;
	readonly maxSuggestions?: number;
	/** Extra sentence for the review footer. */
	readonly footerNote?: string;
}

function limitFindings(
	result: ReviewResult,
	options: ReviewPanelOptions,
	deps: ReviewPanelDeps,
): ReviewResult {
	const scoped = scopeReview(result, {
		maxSuggestions: options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS,
		...(options.changed ? { changed: options.changed } : {}),
	});
	deps.log("review scope filter", {
		followUp: Boolean(options.changed),
		droppedOutsideChange: scoped.droppedOutsideChange,
		markedMissedEarlier: scoped.markedMissedEarlier,
		droppedOverLimit: scoped.droppedOverLimit,
		verdict: scoped.result.verdict,
		findingCount: scoped.result.findings.length,
	});
	return scoped.result;
}

export async function runReviewPanel(
	plan: ReviewPlan,
	deps: ReviewPanelDeps,
	options: ReviewPanelOptions = {},
): Promise<ReviewPanelOutcome> {
	const runs = await Promise.all(
		plan.reviewers.map((model) => runReviewer(model, deps, options.signal)),
	);
	const completed: ReviewerResult[] = runs.flatMap((run) =>
		run.result ? [{ reviewer: run.model, result: run.result }] : [],
	);
	const [first] = completed;
	if (!first) throw runs[0]?.error ?? new Error("No reviewer is configured");

	if (runs.length === 1) {
		deps.log("review merge path", { mergePath: "only_reviewer" });
		const limited = limitFindings(first.result, options, deps);
		const soloFooter = options.changed
			? `Follow-up review by \`${first.reviewer}\`, scoped to the changes since the last review.`
			: options.footerNote;
		return {
			result: soloFooter ? withReviewFooter(limited, soloFooter) : limited,
			runs,
			mergePath: "only_reviewer",
		};
	}

	const startedAt = Date.now();
	let mergeUsage: Usage | undefined;
	const { mergeModel } = plan;
	const merge = deps.merge;
	const outcome = await mergeReviews(
		completed,
		async (prompt) => {
			if (!mergeModel || !merge) throw new Error("No merge model is configured");
			const response = await withCapacityRetry((signal) => merge(mergeModel, prompt, signal), {
				label: `merge:${mergeModel}`,
				attempts: MERGE_ATTEMPTS,
				perAttemptTimeoutMs: MERGE_TIMEOUT_MS,
				...(options.signal ? { signal: options.signal } : {}),
			});
			mergeUsage = response.usage;
			return parseJsonObject(response.data);
		},
		{
			...(options.priorReview ? { priorReview: options.priorReview } : {}),
			followUp: Boolean(options.changed),
		},
	);
	const mergePath: MergePath = outcome.source === "single" ? "single_reviewer" : outcome.source;
	deps.log("review merge path", {
		mergePath,
		mergeModel: outcome.source === "single" ? undefined : mergeModel,
		durationMs: outcome.source === "single" ? undefined : Date.now() - startedAt,
		verdict: outcome.result.verdict,
		findingCount: outcome.result.findings.length,
		repairedAnchors: outcome.repairedAnchors,
		droppedAnchors: outcome.droppedAnchors,
		uncoveredInputs: outcome.uncoveredInputs.length,
		...usageFields(mergeUsage),
		...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
	});
	return {
		result: withReviewFooter(
			limitFindings(outcome.result, options, deps),
			[footer(runs), options.footerNote].filter(Boolean).join(" "),
		),
		runs,
		mergePath,
	};
}
