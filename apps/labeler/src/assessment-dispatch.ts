/**
 * Dispatch seam between a created assessment run and its Workflow.
 *
 * Each run executes as one Cloudflare Workflow instance whose id IS the run's
 * `runKey` — the deterministic per-run identity already computed by the
 * discovery consumer / rerun path (`computeRunKey`: SHA-256 over uri, cid,
 * policy, model, prompt, scanner-set, and triggerId). It is a 64-char lowercase
 * hex string, within the 100-char instance-id limit, so it is used verbatim as
 * the id — no second hash, no second formula.
 *
 * Keying on the runKey (not the subject) gives the right dedup granularity:
 *
 *   - Redelivery of the SAME discovery event recomputes the SAME runKey → same
 *     instance id → `create` collides → idempotent no-op, no duplicate run.
 *   - A re-assessment (operator rerun, intel re-trigger) mints a run with a new
 *     triggerId → different runKey → different instance id → it dispatches its
 *     own instance. A subject-only id would instead collide with the RETAINED
 *     id of the prior completed/failed run (Cloudflare keeps instance ids ~30
 *     days) and strand the re-assessment `pending` forever.
 *
 * This is per-run serialization, not per-subject: two DIFFERENT triggers for one
 * subject can run concurrently. That is acceptable — the orchestrator's currency
 * re-check + supersede and idempotency-keyed label issuance keep the outcome
 * correct (at worst recomputed wastefully); the instance id is not the arbiter
 * there.
 *
 * This module holds no reference to `AssessmentOrchestrator` or
 * `cloudflare:workers`: the discovery consumer imports only this, so the
 * orchestrator reaches production solely through `assessment-workflow.ts`.
 */

/** Payload the Workflow instance is triggered with. */
export interface AssessmentWorkflowParams {
	/** The pending assessment run the Workflow will drive to finalization. */
	assessmentId: string;
}

/**
 * Structural subset of the generated `Workflow` binding this module needs. A
 * real `Workflow<AssessmentWorkflowParams>` satisfies it; tests supply an
 * in-memory fake that enforces instance-id uniqueness the same way.
 */
export interface AssessmentWorkflowBinding {
	create(options: { id: string; params: AssessmentWorkflowParams }): Promise<{ id: string }>;
	get(id: string): Promise<{ id: string }>;
}

/**
 * Raised when the Workflow instance could not be created for an infrastructure
 * reason (not an already-exists collision). The discovery consumer retries the
 * message; every upstream step is idempotent, so redelivery re-dispatches.
 */
export class AssessmentDispatchError extends Error {
	override readonly name = "AssessmentDispatchError";
}

export interface DispatchAssessmentInput {
	/** The run's `runKey`, used verbatim as the Workflow instance id. */
	runKey: string;
	assessmentId: string;
}

/**
 * Create the run's Workflow instance, or converge if its id already exists.
 * Returns `"created"` on a fresh dispatch and `"exists"` when the runKey-derived
 * id was already taken (redelivery of the same run). A `create` failure with no
 * surviving instance is a real infrastructure error and throws
 * `AssessmentDispatchError`.
 */
export async function dispatchAssessmentWorkflow(
	workflow: AssessmentWorkflowBinding,
	input: DispatchAssessmentInput,
): Promise<"created" | "exists"> {
	const id = input.runKey;
	const params: AssessmentWorkflowParams = { assessmentId: input.assessmentId };
	try {
		await workflow.create({ id, params });
		return "created";
	} catch (err) {
		// `create` throws on an already-taken id (same-run redelivery) and on
		// transient infra failures alike. Disambiguate by probing for the
		// instance: present means the collision is a redelivery (idempotent
		// no-op); absent means the create genuinely failed and the caller retries.
		const existing = await workflow.get(id).catch(() => null);
		if (existing) return "exists";
		throw new AssessmentDispatchError(
			`failed to dispatch assessment Workflow for run ${input.assessmentId}`,
			{ cause: err },
		);
	}
}
