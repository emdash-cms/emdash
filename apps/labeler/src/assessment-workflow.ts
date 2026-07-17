/**
 * Production assessment execution: one Cloudflare Workflow instance per run, a
 * thin durable shell over `AssessmentOrchestrator`. The instance id is the run's
 * runKey (see `assessment-dispatch.ts`); `run` loads the assessment and drives
 * it through the orchestrator's stages and atomic finalization inside a single
 * durable step.
 *
 * DEPLOY GATE: with `stubStages`, a run finalizes `passed` and issues a real
 * signed `assessment-passed` label for EVERY subject — an unconditional "this is
 * safe" attestation over unscanned content. This shell must NOT reach an
 * enforcing or label-consuming production deployment until the real analysis
 * stages (W7/W8) land; shipping it live before then would vouch for everything.
 *
 * The whole run executes in one `step.do`, not one step per stage: the
 * orchestrator accumulates stage findings in memory and the acquire stage
 * publishes the acquired artifact to an in-process `AcquisitionHolder` that
 * downstream stages read, so a per-stage step boundary would drop that shared
 * state across a durable resume. Running the orchestrator whole keeps its atomic
 * finalization intact. The tradeoff is coarse resume granularity: a mid-run
 * eviction re-runs the whole step. `executeAssessmentInstance` makes that
 * idempotent — a terminal row short-circuits, and `runAssessment` resumes a row
 * left `running` by a crashed attempt. Finer, per-stage durable resume lands
 * with the real-stage wiring.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type { AssessmentWorkflowParams } from "./assessment-dispatch.js";
import { TERMINAL_STATES, type AssessmentState } from "./assessment-lifecycle.js";
import {
	AssessmentOrchestrator,
	stubStages,
	type OrchestratorStages,
} from "./assessment-orchestrator.js";
import { getAssessment, type Assessment } from "./assessment-store.js";
import { getLabelerIdentityConfig } from "./config.js";
import { createNotifyDeps, notifyAssessmentOutcome } from "./notification-triggers.js";
import { MODERATION_POLICY } from "./policy.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";

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

	const config = await getLabelerIdentityConfig(env);
	const versioned = await createRuntimeSigner(config, getRuntimeSigningSecret(env));
	const orchestrator = new AssessmentOrchestrator({
		db: env.DB,
		config,
		signer: versioned.signer,
		policy: MODERATION_POLICY,
		stages: buildStages(),
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

/**
 * The orchestrator's stage adapters, built per instance execution. Real
 * adapters attach here in the acquire-consumer follow-on — acquire (via the
 * aggregator client), code/metadata AI, image AI, and publisher history; today
 * the run executes the exported stub stages. Building them per execution rather
 * than sharing module-scope state keeps per-run state — notably the acquire
 * stage's `AcquisitionHolder` — isolated to this instance, never shared across
 * concurrent subjects.
 */
function buildStages(): OrchestratorStages {
	// Mechanical enforcement of the DEPLOY GATE above: a production build must not
	// run stub stages (which would sign `assessment-passed` for every unscanned
	// subject). `import.meta.env.PROD` is a Vite compile-time constant — true in
	// `vite build`, false in dev and the vitest pool — so this cannot be spoofed
	// at runtime. Remove once real stages are wired here.
	if (import.meta.env.PROD)
		throw new Error(
			"AssessmentWorkflow has only stub stages in a production build — refusing to issue assessment-passed for unscanned subjects. Wire the real analysis stages (W7/W8) before deploying.",
		);
	return stubStages;
}
