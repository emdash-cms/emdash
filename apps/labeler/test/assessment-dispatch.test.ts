import { describe, expect, it } from "vitest";

import {
	AssessmentDispatchError,
	assessmentWorkflowInstanceId,
	dispatchAssessmentWorkflow,
	type AssessmentWorkflowBinding,
	type AssessmentWorkflowParams,
} from "../src/assessment-dispatch.js";

const URI =
	"at://did:plc:publisher000000000000000000/com.emdashcms.experimental.package.release/pkg:1.0.0";
const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

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

describe("assessmentWorkflowInstanceId", () => {
	it("is deterministic and 64 lowercase hex chars", async () => {
		const a = await assessmentWorkflowInstanceId(URI, CID);
		const b = await assessmentWorkflowInstanceId(URI, CID);
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("derives from both uri and cid — either changing changes the id", async () => {
		const base = await assessmentWorkflowInstanceId(URI, CID);
		expect(await assessmentWorkflowInstanceId(`${URI}x`, CID)).not.toBe(base);
		expect(await assessmentWorkflowInstanceId(URI, `${CID}x`)).not.toBe(base);
	});

	it("does not collide across a uri/cid boundary shift", async () => {
		// `a\nb` vs `a` + `\nb` must not hash the same: guards the delimiter.
		expect(await assessmentWorkflowInstanceId("a", "b")).not.toBe(
			await assessmentWorkflowInstanceId("a\nb", ""),
		);
	});
});

describe("dispatchAssessmentWorkflow", () => {
	it("creates the instance with the derived id and returns 'created'", async () => {
		const workflow = new FakeWorkflow();
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			uri: URI,
			cid: CID,
			assessmentId: "asmt_1",
		});
		expect(outcome).toBe("created");
		const expectedId = await assessmentWorkflowInstanceId(URI, CID);
		expect(workflow.created).toEqual([{ id: expectedId, params: { assessmentId: "asmt_1" } }]);
	});

	it("returns 'exists' when the id is already taken — the lock held", async () => {
		const workflow = new FakeWorkflow();
		await dispatchAssessmentWorkflow(workflow, { uri: URI, cid: CID, assessmentId: "asmt_1" });
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			uri: URI,
			cid: CID,
			assessmentId: "asmt_1",
		});
		expect(outcome).toBe("exists");
		expect(workflow.created).toHaveLength(1);
	});

	it("returns 'exists' when create fails but the instance survives", async () => {
		const workflow = new FakeWorkflow();
		workflow.failCreate = new Error("ack lost");
		workflow.persistOnFailure = true;
		const outcome = await dispatchAssessmentWorkflow(workflow, {
			uri: URI,
			cid: CID,
			assessmentId: "asmt_1",
		});
		expect(outcome).toBe("exists");
	});

	it("throws AssessmentDispatchError when create fails and no instance survives", async () => {
		const workflow = new FakeWorkflow();
		workflow.failCreate = new Error("backend down");
		await expect(
			dispatchAssessmentWorkflow(workflow, { uri: URI, cid: CID, assessmentId: "asmt_1" }),
		).rejects.toBeInstanceOf(AssessmentDispatchError);
	});
});
