/**
 * Production assessment execution: one Cloudflare Workflow instance per
 * subject, a thin durable shell over `AssessmentOrchestrator`. The instance id
 * (see `assessment-dispatch.ts`) serializes runs per subject; `run` loads the
 * pending assessment and drives it through the orchestrator's stages and atomic
 * finalization inside a single durable step.
 *
 * The whole run executes in one `step.do`, not one step per stage: the
 * orchestrator accumulates stage findings in memory and the acquire stage
 * publishes the acquired artifact to an in-process `AcquisitionHolder` that
 * downstream stages read, so a per-stage step boundary would drop that shared
 * state across a durable resume. Running the orchestrator whole keeps its
 * atomic finalization intact. The tradeoff is coarse resume granularity — a
 * mid-run eviction re-runs from `pending`, and because `runAssessment` guards
 * on `pending`, a row already advanced to `running` cannot be resumed here; the
 * reconciliation pass (reconciliation.ts) surfaces such stuck runs. Finer,
 * per-stage durable resume lands with the real-stage wiring.
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
import { getAssessment } from "./assessment-store.js";
import { getLabelerIdentityConfig } from "./config.js";
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
	// Idempotent resume: a previous execution already finalized this run (an
	// eviction after the finalization batch committed but before the step result
	// was durable). Return the terminal state rather than re-entering the
	// orchestrator, whose pending-guard would throw on a non-pending row.
	if (TERMINAL_STATES.has(existing.state)) return existing.state;

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
	return finalized.state;
}

/**
 * The orchestrator's stage adapters, built per instance execution. Real
 * adapters attach here in the W7/W8 follow-on — acquire (via the aggregator
 * client), deterministic/dependency/AI scanning, and publisher history; today
 * the run executes the exported stub stages. Building them per execution rather
 * than sharing module-scope state keeps per-run state — notably the acquire
 * stage's `AcquisitionHolder` — isolated to this instance, never shared across
 * concurrent subjects.
 */
function buildStages(): OrchestratorStages {
	return stubStages;
}
