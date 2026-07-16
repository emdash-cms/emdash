/**
 * Dispatch seam between verified discovery and the assessment Workflow.
 *
 * Each subject runs as one Cloudflare Workflow instance whose id is a
 * deterministic function of (uri, cid). That id IS the spec §14.1 per-subject
 * lock: `create` throws when an instance with the id already exists, so a
 * duplicate subject cannot start a second concurrent run — resolving the
 * queue-vs-Workflow serialization question deferred in #1978.
 * `dispatchAssessmentWorkflow` treats that collision as an idempotent no-op and
 * surfaces genuine infrastructure failures as `AssessmentDispatchError` for the
 * caller to retry.
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

/**
 * Deterministic Workflow instance id for a subject: SHA-256 hex of (uri, cid).
 * Derived from the subject alone — not the run key — so any run for the same
 * subject maps to the same instance and is serialized by it. 64 hex chars, well
 * within the 100-char instance-id limit.
 */
export async function assessmentWorkflowInstanceId(uri: string, cid: string): Promise<string> {
	const material = `${uri}\n${cid}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface DispatchAssessmentInput {
	uri: string;
	cid: string;
	assessmentId: string;
}

/**
 * Create the subject's Workflow instance, or converge if it already exists.
 * Returns `"created"` on a fresh dispatch and `"exists"` when the deterministic
 * id was already taken (the lock held — no second run). A `create` failure with
 * no surviving instance is a real infrastructure error and throws
 * `AssessmentDispatchError`.
 */
export async function dispatchAssessmentWorkflow(
	workflow: AssessmentWorkflowBinding,
	input: DispatchAssessmentInput,
): Promise<"created" | "exists"> {
	const id = await assessmentWorkflowInstanceId(input.uri, input.cid);
	const params: AssessmentWorkflowParams = { assessmentId: input.assessmentId };
	try {
		await workflow.create({ id, params });
		return "created";
	} catch (err) {
		// `create` throws on an already-taken id (the lock) and on transient
		// infra failures alike. Disambiguate by probing for the instance: present
		// means the collision is the lock (idempotent no-op); absent means the
		// create genuinely failed and the caller must retry.
		const existing = await workflow.get(id).catch(() => null);
		if (existing) return "exists";
		throw new AssessmentDispatchError(`failed to dispatch assessment Workflow for ${input.uri}`, {
			cause: err,
		});
	}
}
