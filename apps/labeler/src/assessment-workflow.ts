/**
 * Production assessment execution: one Cloudflare Workflow instance per run, a
 * thin durable shell over `AssessmentOrchestrator`. The instance id is the run's
 * runKey (see `assessment-dispatch.ts`); `run` loads the assessment and drives
 * it through the orchestrator's stages and atomic finalization inside a single
 * durable step.
 *
 * PROD safety (the lifted deploy gate): `buildStages` now assembles four REAL
 * stages — acquire (SSRF-hardened verified fetch + aggregator release
 * resolution), code AI, image AI, and publisher history. A `passed` outcome is
 * therefore only ever reached after a real acquire produced a checksum-verified
 * bundle that the AI stages analyzed clean; there is no stub path that would
 * sign `assessment-passed` over unscanned content. The invariant that makes
 * this safe: the acquire stage returns no findings ONLY when it has published a
 * verified bundle to the holder (a permanent failure returns a blocking
 * finding, a transient one throws), so a run cannot finalize `passed` with the
 * holder empty. `buildStages` fails loudly if a required binding is missing.
 *
 * The whole run executes in one `step.do`, not one step per stage: the
 * orchestrator accumulates stage findings in memory and the acquire stage
 * publishes the acquired artifact to an in-process `AcquisitionHolder` that
 * downstream stages read, so a per-stage step boundary would drop that shared
 * state across a durable resume. Running the orchestrator whole keeps its atomic
 * finalization intact. The tradeoff is coarse resume granularity: a mid-run
 * eviction re-runs the whole step. `executeAssessmentInstance` makes that
 * idempotent — a terminal row short-circuits, and `runAssessment` resumes a row
 * left `running` by a crashed attempt.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import { AggregatorClient } from "./aggregator-client.js";
import { createAcquireStage, type AcquisitionHolder } from "./artifact-acquisition.js";
import { createArtifactEgress, type ArtifactEgress } from "./artifact-egress.js";
import type { AssessmentWorkflowParams } from "./assessment-dispatch.js";
import { TERMINAL_STATES, type AssessmentState } from "./assessment-lifecycle.js";
import { AssessmentOrchestrator, type OrchestratorStages } from "./assessment-orchestrator.js";
import {
	createCodeAiStage,
	createHistoryStage,
	createImageAiStage,
	serializeCoverage,
	type CoverageAccumulator,
} from "./assessment-stages.js";
import { getAssessment, type Assessment } from "./assessment-store.js";
import { AutomationPausedError, isAutomationPaused } from "./automation-state.js";
import type { AiBinding } from "./code-ai-adapter.js";
import { getLabelerIdentityConfig, type LabelerConfig } from "./config.js";
import type { PublisherVerificationReader } from "./history-context.js";
import type { ImageAiBinding } from "./image-ai-adapter.js";
import { createNotifyDeps, notifyAssessmentOutcome } from "./notification-triggers.js";
import { MODERATION_POLICY, type ModerationPolicy } from "./policy.js";
import { createReleaseResolver, type ReleaseReader } from "./release-resolution.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";
import { createLabelPublisher } from "./subscribe-labels.js";

const RUN_STEP_CONFIG = {
	retries: { limit: 3, delay: "10 seconds" as const, backoff: "exponential" as const },
};

export class AssessmentWorkflow extends WorkflowEntrypoint<Env, AssessmentWorkflowParams> {
	override async run(
		event: Readonly<WorkflowEvent<AssessmentWorkflowParams>>,
		step: WorkflowStep,
	): Promise<{ assessmentId: string; state: AssessmentState }> {
		const { assessmentId } = event.payload;
		const state = await step.do("assess-subject", RUN_STEP_CONFIG, () =>
			executeAssessmentInstance(this.env, assessmentId),
		);
		return { assessmentId, state };
	}
}

/**
 * The shell body: load the pending run, drive it through the orchestrator, and
 * return the finalized state. Separate from the entrypoint class so it is
 * testable without Cloudflare's Workflow runtime (which has no local harness) —
 * `run` above is the thin durable-step wrapper over it.
 */
export async function executeAssessmentInstance(
	env: Env,
	assessmentId: string,
): Promise<AssessmentState> {
	const existing = await getAssessment(env.DB, assessmentId);
	if (!existing) throw new Error(`assessment ${assessmentId} not found`);
	// Idempotent resume for a durable-step retry: a terminal row means a prior
	// attempt already finalized (its batch committed but the step result was
	// lost) — return that state. A `pending` or crash-left `running` row falls
	// through to `runAssessment`, which drives (or resumes) it to finalization.
	// The notify runs on the resume path too (dedup makes it idempotent), so a
	// crash between the label commit and the notify still delivers.
	if (TERMINAL_STATES.has(existing.state)) {
		await notifyOutcome(env, existing);
		return existing.state;
	}

	// Re-read the kill-switch on entry: an admin pausing automation after this run
	// was dispatched halts it here, before it spends AI/network work. Throwing
	// leaves the row untouched for the Workflow-step retry to resume once
	// automation is unpaused; finalization carries the same guard as the backstop.
	// `isAutomationPaused` fails closed — an unreadable switch throws and retries.
	if (await isAutomationPaused(env.DB))
		throw new AutomationPausedError(`assessment ${assessmentId} halted: automation is paused`);

	assertRequiredBindings(env);
	const config = await getLabelerIdentityConfig(env);
	const versioned = await createRuntimeSigner(config, getRuntimeSigningSecret(env));
	// Per-run state shared by reference across this run's stages: the acquire
	// stage publishes its verified bundle to `holder`; the AI stages read it and
	// record into `coverage`, which `resolveCoverageJson` serializes at finalization.
	const holder: AcquisitionHolder = {};
	const coverage: CoverageAccumulator = {};
	const aggregator = new AggregatorClient(env.AGGREGATOR);
	const orchestrator = new AssessmentOrchestrator({
		db: env.DB,
		config,
		signer: versioned.signer,
		policy: MODERATION_POLICY,
		stages: buildStages({
			holder,
			coverage,
			config,
			policy: MODERATION_POLICY,
			db: env.DB,
			egress: createArtifactEgress(),
			aggregator,
			ai: env.AI,
		}),
		resolveCoverageJson: () => serializeCoverage(coverage),
		// Same subscription-DO publisher the console path uses: finalized labels
		// broadcast live post-commit, with the reconciliation sweep as the backstop.
		publisher: createLabelPublisher(env),
	});
	const finalized = await orchestrator.runAssessment(assessmentId);
	await notifyOutcome(env, finalized);
	return finalized.state;
}

/**
 * Fire the automated block/warning publisher notice, best-effort. Reaching a
 * `blocked`/`warned` terminal state means finalization's CAS committed the
 * labels, so this is a true post-commit side effect; it never affects the run.
 * `notifyAssessmentOutcome` swallows its own send errors and dedups on the
 * assessment id, so a Workflow-step retry re-drives it harmlessly.
 */
async function notifyOutcome(env: Env, assessment: Assessment): Promise<void> {
	if (assessment.state !== "blocked" && assessment.state !== "warned") return;
	try {
		await notifyAssessmentOutcome(await createNotifyDeps(env), assessment);
	} catch (error) {
		console.error("[notifications] assessment notify failed", {
			assessmentId: assessment.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Prompt version stamped into AI-stage findings and their prompt hash. The
 * calibration sweep re-validates the production prompt before enforcement
 * launch (see the calibration-fidelity flags in `assessment-stages.ts`). */
export const ASSESSMENT_PROMPT_VERSION = "1";

export interface BuildStagesInput {
	readonly holder: AcquisitionHolder;
	readonly coverage: CoverageAccumulator;
	readonly config: LabelerConfig;
	readonly policy: ModerationPolicy;
	readonly db: D1Database;
	/** SSRF-hardened egress for the acquire stage's declared-URL fetch. */
	readonly egress: ArtifactEgress;
	/** Aggregator reads: release resolution (acquire) and publisher verification
	 * (history). `AggregatorClient` satisfies both. */
	readonly aggregator: ReleaseReader & PublisherVerificationReader;
	/** Workers AI binding for both AI stages. */
	readonly ai: AiBinding & ImageAiBinding;
	readonly promptVersion?: string;
}

/**
 * Assembles the orchestrator's four real stage adapters for one run. Built per
 * execution rather than sharing module-scope state so per-run state — the
 * acquire stage's `AcquisitionHolder` and the AI stages' `CoverageAccumulator`
 * — stays isolated to this instance, never shared across concurrent subjects.
 * `acquire` fetches the release's declared artifact under the SSRF-hardened
 * egress and publishes the verified bundle; `codeAi`/`imageAi` read it; `history`
 * runs last as best-effort operator context. Pure over its injected deps (no
 * `env`, no network), so tests drive it with fakes; `executeAssessmentInstance`
 * supplies the production deps and enforces binding presence.
 */
export function buildStages(input: BuildStagesInput): OrchestratorStages {
	const promptVersion = input.promptVersion ?? ASSESSMENT_PROMPT_VERSION;
	return {
		acquire: createAcquireStage({
			deps: input.egress,
			resolveTarget: createReleaseResolver(input.aggregator),
			holder: input.holder,
		}),
		codeAi: createCodeAiStage({
			holder: input.holder,
			ai: input.ai,
			policy: input.policy,
			promptVersion,
			coverage: input.coverage,
		}),
		imageAi: createImageAiStage({
			holder: input.holder,
			ai: input.ai,
			policy: input.policy,
			promptVersion,
			coverage: input.coverage,
		}),
		history: createHistoryStage({
			db: input.db,
			src: input.config.labelerDid,
			aggregator: input.aggregator,
		}),
	};
}

/** Fails loudly when a binding the run cannot proceed without is absent, so a
 * misconfigured deployment errors before any stage runs rather than silently
 * scanning nothing and finalizing `passed`. */
function assertRequiredBindings(env: Env): void {
	const missing = (["AI", "AGGREGATOR", "DB"] as const).filter((name) => !env[name]);
	if (missing.length > 0)
		throw new Error(
			`AssessmentWorkflow is missing required bindings: ${missing.join(", ")} — refusing to run an assessment that cannot fetch, scan, or persist.`,
		);
}
