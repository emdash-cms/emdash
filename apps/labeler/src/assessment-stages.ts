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
 * `assessment-workflow.ts` `buildStages` assembles these factories with the
 * acquire stage into the run's `OrchestratorStages`.
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
import {
	analyzeImages,
	type ImageAiBinding,
	type ImageAnalysisInput,
	type ImageAnalysisResult,
} from "./image-ai-adapter.js";
import { extractBundleImages } from "./image-metadata.js";
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
	images?: {
		readonly coverage: "complete" | "partial" | "not-present";
		readonly droppedImages: readonly string[];
	};
}

/** Coverage axis value for an analysis that did not run this assessment (its
 * input was unavailable — e.g. acquisition produced no bundle, or the stage
 * transient-exhausted before completing). */
const UNAVAILABLE = "unavailable";

/**
 * Serializes the accumulated coverage into the `coverage_json` blob shape
 * `public-assessment.ts` reads (`{ code, images, metadata }`, extra keys
 * ignored). `code`/`images` reflect what each AI stage recorded this run;
 * `metadata` stays `unavailable` (metadata analysis folds into the code stage,
 * with no separate coverage producer). An axis its stage left unset serializes
 * `unavailable` — this is how a post-code transient exhaustion honestly reports
 * `code: complete, images: unavailable` (the image stage never completed). The
 * `images` axis also carries `not-present` for a bundle with no image files.
 * `droppedFiles`/`droppedImages` record what each stage dropped to fit its
 * model budget.
 */
export function serializeCoverage(coverage: CoverageAccumulator): string {
	return JSON.stringify({
		code: coverage.code?.coverage ?? UNAVAILABLE,
		images: coverage.images?.coverage ?? UNAVAILABLE,
		metadata: UNAVAILABLE,
		droppedFiles: coverage.code ? [...coverage.code.droppedFiles] : [],
		droppedImages: coverage.images ? [...coverage.images.droppedImages] : [],
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
		// must be re-validated by the calibration sweep. `description` is the release's
		// advertised profile description resolved during acquisition — the stated
		// purpose the misleading-metadata and privacy-risk categories key on; the
		// calibration sweep must run against this real-description input (its second
		// input divergence). Absent when the profile is unindexed, leaving those
		// categories near-inert for that run only.
		const { capabilities } = declaredAccessToCapabilities(acquired.bundle.declaredAccess);
		const input: CodeAnalysisInput = {
			files: acquired.files,
			declaredAccess: capabilities,
			metadata: {
				name: acquired.bundle.manifest.id,
				description: acquired.description ?? "",
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

export interface ImageAiStageOptions {
	readonly holder: AcquisitionHolder;
	readonly ai: ImageAiBinding;
	readonly policy: ModerationPolicy;
	readonly promptVersion: string;
	readonly modelId?: string;
	readonly coverage: CoverageAccumulator;
}

/**
 * Builds the orchestrator's `imageAi` stage. With no acquired bundle there is
 * nothing to analyze. Otherwise the deterministic extractor turns the bundle's
 * binary files into the vision adapter's image set: no image files records
 * `not-present` and skips the model; any images run `analyzeImages`. Image
 * coverage is `partial` when the extractor skipped an unreadable/over-cap image
 * OR the adapter dropped one for its input budget. A `ModelTransientError`
 * becomes a `StageTransientError` so the orchestrator retries rather than
 * finalizing on a flaky model call.
 */
export function createImageAiStage(options: ImageAiStageOptions): StageAdapter {
	return async (ctx) => {
		const acquired = options.holder.result;
		if (!acquired) return [];

		const { images, skipped } = await extractBundleImages(acquired.bundle.files);
		if (images.length === 0) {
			options.coverage.images =
				skipped.length > 0
					? { coverage: "partial", droppedImages: skipped }
					: { coverage: "not-present", droppedImages: [] };
			return [];
		}

		const input: ImageAnalysisInput = {
			images,
			metadata: {
				name: acquired.bundle.manifest.id,
				description: acquired.description ?? "",
				publisherDid: parseAtUri(ctx.assessment.uri).did,
				version: acquired.bundle.manifest.version,
			},
		};

		let result: ImageAnalysisResult;
		try {
			result = await analyzeImages(input, {
				ai: options.ai,
				policy: options.policy,
				promptVersion: options.promptVersion,
				...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
			});
		} catch (err) {
			if (err instanceof ModelTransientError) throw new StageTransientError(err.message);
			throw err;
		}

		const partial = skipped.length > 0 || result.coverage === "partial";
		options.coverage.images = {
			coverage: partial ? "partial" : "complete",
			droppedImages: [...skipped, ...result.droppedImages],
		};
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
