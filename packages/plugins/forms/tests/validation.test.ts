import { describe, expect, it } from "vitest";

import { validateSubmission } from "../src/validation.js";

function checkboxField(): {
	id: string;
	type: "checkbox-group";
	label: string;
	name: string;
	required: boolean;
	width: "full";
	options: { label: string; value: string }[];
} {
	return {
		id: "f1",
		type: "checkbox-group",
		label: "Interests",
		name: "interests",
		required: false,
		width: "full",
		options: [
			{ label: "A", value: "a" },
			{ label: "B", value: "b" },
			{ label: "C", value: "c" },
		],
	};
}

describe("validateSubmission checkbox-group", () => {
	it("accepts multiple selected values", () => {
		const result = validateSubmission([checkboxField()], {
			interests: ["a", "b"],
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.data.interests).toEqual(["a", "b"]);
	});

	it("accepts a single selected value", () => {
		const result = validateSubmission([checkboxField()], {
			interests: "a",
		});
		expect(result.valid).toBe(true);
		expect(result.data.interests).toEqual(["a"]);
	});

	it("rejects values not in the option list", () => {
		const result = validateSubmission([checkboxField()], {
			interests: ["a", "x"],
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			{ field: "interests", message: "Interests contains an invalid selection" },
		]);
	});
});

describe("validateSubmission file fields", () => {
	const fileField = {
		id: "f2",
		type: "file" as const,
		label: "Attachment",
		name: "attachment",
		required: true,
		width: "full" as const,
	};

	it("accepts a required file field when the file was submitted", () => {
		const result = validateSubmission([fileField], {}, new Set(["attachment"]));
		expect(result).toEqual({ valid: true, errors: [], data: {} });
	});

	it("rejects a required file field with no file, whatever data holds", () => {
		const result = validateSubmission([fileField], { attachment: "x.pdf" });
		expect(result.errors).toEqual([{ field: "attachment", message: "Attachment is required" }]);
	});
});
