import { describe, expect, test } from "vitest";

import { investigationBaseRef } from "../../.flue/lib/investigation-base-ref.js";

describe("investigationBaseRef", () => {
	test("pins a new implementation to the resolved main commit", () => {
		expect(investigationBaseRef("implement", "main-sha", "old-candidate-sha")).toBe("main-sha");
	});

	test("pins a revision to the existing candidate commit", () => {
		expect(investigationBaseRef("revise", "main-sha", "candidate-sha")).toBe("candidate-sha");
	});

	test("rejects a revision when its candidate branch is missing", () => {
		expect(() => investigationBaseRef("revise", "main-sha", null)).toThrow(
			"candidate branch is missing",
		);
	});
});
