import { describe, expect, it } from "vitest";

import {
	FORMS_LOAD_FAILED,
	SUBMISSIONS_LOAD_FAILED,
	formsLoadError,
	submissionsLoadError,
	writeError,
} from "../src/admin-errors.js";

describe("forms admin error messages", () => {
	it("reports a 403 on forms/list as a permission problem", () => {
		expect(formsLoadError({ status: 403 })).toBe("You don't have permission to view forms.");
	});

	it("reports other forms/list failures as a load failure", () => {
		for (const status of [401, 404, 500, 503]) {
			expect(formsLoadError({ status }), String(status)).toBe(FORMS_LOAD_FAILED);
		}
	});

	it("reports a 403 on submissions/list as a permission problem, not an empty list", () => {
		expect(submissionsLoadError({ status: 403 })).toBe(
			"You don't have permission to view submissions.",
		);
	});

	it("reports other submissions/list failures as a load failure", () => {
		for (const status of [401, 404, 500, 503]) {
			expect(submissionsLoadError({ status }), String(status)).toBe(SUBMISSIONS_LOAD_FAILED);
		}
	});

	it("reports a 403 on a write as a permission problem", () => {
		expect(writeError({ status: 403 }, "Failed to delete form")).toBe(
			"You don't have permission to do this.",
		);
	});

	it("keeps the action-specific message for other write failures", () => {
		expect(writeError({ status: 500 }, "Failed to delete form")).toBe("Failed to delete form");
	});
});
