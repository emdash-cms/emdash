import { describe, expect, test } from "vitest";

import { requireCandidatePublication } from "../../.flue/lib/candidate-publisher.js";

describe("candidate publication", () => {
	test("requires publication before an agent claims it implemented a change", () => {
		expect(() => requireCandidatePublication(true, null)).toThrow(/publish_candidate/);
		expect(() => requireCandidatePublication(false, null)).not.toThrow();
		expect(() =>
			requireCandidatePublication(true, {
				branch: "bot/fix-1",
				commitSha: "sha",
				files: ["x.ts"],
			}),
		).not.toThrow();
	});
});
