/**
 * Orchestrator stage wiring (plan W-production-stage-wiring). Adapts the pure
 * analysis modules (`code-ai-adapter.ts`, `history-context.ts`) to the
 * orchestrator's `StageAdapter` contract, following the `createAcquireStage`
 * closure idiom: each factory captures its deps plus the shared
 * `AcquisitionHolder` at construction and returns a `StageAdapter` that reads
 * `holder.result` (the acquired bundle + decoded file set) and `ctx.assessment`.
 *
 * Keeping this here rather than in the adapter modules preserves those modules'
 * purity (no DB, no orchestrator types) so they stay independently testable.
 *
 * The image stage and the whole `buildStages` assembly are deferred to the
 * acquire-consumer slice, when a production bundle producer (verified
 * acquisition + image-metadata extraction) exists to feed them; until then the
 * orchestrator's production gate keeps stub stages from running.
 */

import { declaredAccessToCapabilities } from "@emdash-cms/plugin-types";

import type { AcquisitionHolder } from "./artifact-acquisition.js";
import type { StageAdapter } from "./assessment-orchestrator.js";
import { StageTransientError } from "./assessment-orchestrator.js";
import {
	analyzeCode,
	ModelTransientError,
	type AiBinding,
	type CodeAnalysisInput,
	type CodeAnalysisResult,
} from "./code-ai-adapter.js";
import { analyzeHistory, type PublisherVerificationReader } from "./history-context.js";
import type { ModerationPolicy } from "./policy.js";
import { parseAtUri } from "./record-verification.js";

/**
 * Per-run coverage the AI stages accumulate as they run, serialized onto the
 * finalized assessment's `coverage_json` (read by `public-assessment.ts`).
 * `createCodeAiStage` records `code`; the image stage records `images` in the
 * acquire-consumer slice. Shared by reference across the stages of one run.
 */
export interface CoverageAccumulator {
	code?: { readonly coverage: "complete" | "partial"; readonly droppedFiles: readonly string[] };
}

/** Coverage axis value for an analysis that did not run this assessment (its
 * input was unavailable or its stage is not yet wired). */
const UNAVAILABLE = "unavailable";

/**
 * Serializes the accumulated coverage into the `coverage_json` blob shape
 * `public-assessment.ts` reads (`{ code, images, metadata }`, extra keys
 * ignored). `images` and `metadata` stay `unavailable` until their producers
 * land in the acquire-consumer slice. `droppedFiles` records which code files
 * were dropped to fit the model budget when `code` is `partial`.
 */
export function serializeCoverage(coverage: CoverageAccumulator): string {
	return JSON.stringify({
		code: coverage.code?.coverage ?? UNAVAILABLE,
		images: UNAVAILABLE,
		metadata: UNAVAILABLE,
		droppedFiles: coverage.code ? [...coverage.code.droppedFiles] : [],
	});
}

/** Per-run state: `holder` and `coverage` are shared by reference across one
 * run's stages, so a factory must be constructed per assessment execution —
 * reusing one across runs leaks the prior run's bundle and coverage. */
export interface CodeAiStageOptions {
	readonly holder: AcquisitionHolder;
	readonly ai: AiBinding;
	readonly policy: ModerationPolicy;
	readonly promptVersion: string;
	readonly modelId?: string;
	readonly coverage: CoverageAccumulator;
}

/**
 * Builds the orchestrator's `codeAi` stage. When acquisition produced no
 * bundle (a permanent deterministic finding, or a transient failure that never
 * reached the holder) there is nothing to analyze, so it reports no findings.
 * Otherwise it runs the code model over the decoded file set and returns its
 * validated findings, recording the run's code coverage. A `ModelTransientError`
 * (flaky model call, unparseable output) becomes a `StageTransientError` so the
 * orchestrator retries the stage rather than aborting the run.
 */
export function createCodeAiStage(options: CodeAiStageOptions): StageAdapter {
	return async (ctx) => {
		const acquired = options.holder.result;
		if (!acquired) return [];

		// The declared surface is passed capabilities-only, matching the calibration
		// input shape; the production declaredAccess vocabulary (from
		// declaredAccessToCapabilities) differs from the legacy fixture vocabulary and
		// must be re-validated by the calibration sweep. Second calibration-input
		// divergence for that sweep: `description` is empty below — the bundle
		// manifest carries no name/description, and the misleading-metadata and
		// privacy-risk categories are rooted in the plugin's stated purpose, so they
		// run near-inert until the acquire-consumer slice threads the release
		// record's description through these options.
		const { capabilities } = declaredAccessToCapabilities(acquired.bundle.declaredAccess);
		const input: CodeAnalysisInput = {
			files: acquired.files,
			declaredAccess: capabilities,
			metadata: {
				name: acquired.bundle.manifest.id,
				description: "",
				publisherDid: parseAtUri(ctx.assessment.uri).did,
				version: acquired.bundle.manifest.version,
			},
		};

		let result: CodeAnalysisResult;
		try {
			result = await analyzeCode(input, {
				ai: options.ai,
				policy: options.policy,
				promptVersion: options.promptVersion,
				...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
			});
		} catch (err) {
			if (err instanceof ModelTransientError) throw new StageTransientError(err.message);
			throw err;
		}

		options.coverage.code = { coverage: result.coverage, droppedFiles: result.droppedFiles };
		return result.findings;
	};
}

export interface HistoryStageOptions {
	readonly db: D1Database;
	/** The labeler's own DID (`src`) whose active manual labels count as context. */
	readonly src: string;
	/** Read-only aggregator surface for the publisher's verification state. */
	readonly aggregator?: PublisherVerificationReader;
}

/**
 * Builds the orchestrator's `history` stage over `analyzeHistory`. History is
 * operator-only context that never becomes a label and `analyzeHistory` is
 * best-effort (it swallows its own errors and returns `[]`), so this wrapper
 * adds no error handling of its own.
 */
export function createHistoryStage(options: HistoryStageOptions): StageAdapter {
	return (ctx) =>
		analyzeHistory(options.db, ctx.assessment, {
			src: options.src,
			...(options.aggregator !== undefined ? { aggregator: options.aggregator } : {}),
		});
}
