import { describe, expect, it } from "vitest";

import {
	assertAssessmentWorkflowParams,
	createAssessmentRunKey,
	createAssessmentWorkflowParams,
} from "../src/assessment/run-key.js";
import { ASSESSMENT_VERSIONS, PROFILE_CID, PROFILE_URI } from "./assessment-fixtures.js";

describe("assessment run identity", () => {
	it("derives stable run keys from exact subject and version inputs", async () => {
		const identity = {
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" as const },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:100",
		};
		expect(await createAssessmentRunKey(identity)).toBe(await createAssessmentRunKey(identity));
		expect(await createAssessmentRunKey(identity)).not.toBe(
			await createAssessmentRunKey({ ...identity, logicalTriggerId: "event:101" }),
		);
		expect(await createAssessmentRunKey(identity)).not.toBe(
			await createAssessmentRunKey({
				...identity,
				versions: { ...ASSESSMENT_VERSIONS, policyVersion: "listing-policy-v2" },
			}),
		);
	});

	it("rejects a Workflow ID that is not bound to its payload", async () => {
		const params = await createAssessmentWorkflowParams({
			subject: { uri: PROFILE_URI, cid: PROFILE_CID, kind: "profile" },
			versions: ASSESSMENT_VERSIONS,
			logicalTriggerId: "event:100",
		});
		await expect(assertAssessmentWorkflowParams(params)).resolves.toBeUndefined();
		await expect(
			assertAssessmentWorkflowParams({ ...params, subjectCid: "bafywrongcid00000000" }),
		).rejects.toThrow(/does not match/);
	});
});
