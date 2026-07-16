import { describe, expect, it } from "vitest";

import {
	AssessmentDispatchError,
	dispatchAssessmentWorkflow,
	type AssessmentWorkflowBinding,
	type AssessmentWorkflowParams,
} from "../src/assessment-dispatch.js";

// Stand-in runKeys (real ones are 64-char SHA-256 hex from computeRunKey). Two
// distinct values model same-subject-different-trigger re-assessment.
const RUNKEY_A = "a".repeat(64);
const RUNKEY_B = "b".repeat(64);

interface Recorded {
	id: string;
	params: AssessmentWorkflowParams;
}

/** Binding fake enforcing instance-id uniqueness, with hooks to simulate a
 * `create` that fails while (or without) an instance surviving. */
class FakeWorkflow implements AssessmentWorkflowBinding {
	readonly instances = new Map<string, Recorded>();
	readonly created: Recorded[] = [];
	/** When set, `create` rejects with this error. */
	failCreate: Error | undefined;
	/** When true, a failing `create` still leaves the instance behind (models a
	 * create that ran but whose acknowledgement was lost). */
	persistOnFailure = false;

	create(options: { id: string; params: AssessmentWorkflowParams }): Promise<{ id: string }> {
		if (this.failCreate) {
			if (this.persistOnFailure)
				this.instances.set(options.id, { id: options.id, params: options.params });
			return Promise.reject(this.failCreate);
		}
		if (this.instances.has(options.id))
			return Promise.reject(new Error(`instance ${options.id} already exists`));
		const recorded = { id: options.id, params: options.params };
		this.instances.set(options.id, recorded);
		this.created.push(recorded);
		return Promise.resolve({ id: options.id });
	}

	get(id: string): Promise<{ id: string }> {
		const instance = this.instances.get(id);
		if (!instance) return Promise.reject(new Error(`instance ${id} not found`));
		return Promise.resolve({ id });
	}
}

describe("dispatchAssessmentWorkflow", () => {
	it("creates the instance with the runKey as its id and returns 'created'", async () => {
		const workflow = new FakeWorkflow();
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			runKey: RUNKEY_A,
			assessmentId: "asmt_1",
		});
		expect(outcome).toBe("created");
		expect(workflow.created).toEqual([{ id: RUNKEY_A, params: { assessmentId: "asmt_1" } }]);
	});

	it("returns 'exists' when the same runKey is dispatched again — redelivery dedup", async () => {
		const workflow = new FakeWorkflow();
		await dispatchAssessmentWorkflow(workflow, { runKey: RUNKEY_A, assessmentId: "asmt_1" });
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			runKey: RUNKEY_A,
			assessmentId: "asmt_1",
		});
		expect(outcome).toBe("exists");
		expect(workflow.created).toHaveLength(1);
	});

	it("a distinct runKey (re-assessment's new trigger) dispatches its own instance", async () => {
		const workflow = new FakeWorkflow();
		// Same subject, different trigger → different runKey → must not collide.
		await dispatchAssessmentWorkflow(workflow, { runKey: RUNKEY_A, assessmentId: "asmt_1" });
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			runKey: RUNKEY_B,
			assessmentId: "asmt_2",
		});
		expect(outcome).toBe("created");
		expect(workflow.created.map((c) => c.id)).toEqual([RUNKEY_A, RUNKEY_B]);
	});

	it("returns 'exists' when create fails but the instance survives", async () => {
		const workflow = new FakeWorkflow();
		workflow.failCreate = new Error("ack lost");
		workflow.persistOnFailure = true;
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			runKey: RUNKEY_A,
			assessmentId: "asmt_1",
		});
		expect(outcome).toBe("exists");
	});

	it("throws AssessmentDispatchError when create fails and no instance survives", async () => {
		const workflow = new FakeWorkflow();
		workflow.failCreate = new Error("backend down");
		await expect(
			dispatchAssessmentWorkflow(workflow, { runKey: RUNKEY_A, assessmentId: "asmt_1" }),
		).rejects.toBeInstanceOf(AssessmentDispatchError);
	});
});
