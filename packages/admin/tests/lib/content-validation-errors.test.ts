import { describe, expect, it } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client";
import { describeContentValidationError } from "../../src/lib/content-validation-errors";

const FIELDS = {
	title: { kind: "string", label: "Headline" },
	excerpt: { kind: "string", label: "Summary" },
	reading_minutes: { kind: "number", label: "Reading time" },
	subtitle: { kind: "string" },
	related: { kind: "reference", label: "Related post" },
	stops: {
		kind: "repeater",
		label: "Stops",
		validation: { subFields: [{ slug: "name", type: "string", label: "Stop name" }] },
	},
};

function validationError(issues: unknown[]) {
	return new ApiResponseError(400, "VALIDATION_ERROR", "raw server message", { issues });
}

describe("describeContentValidationError", () => {
	it("names each field by its editor label and words the failed bound", () => {
		const error = validationError([
			{ path: "title", code: "required", message: "Invalid input" },
			{ path: "excerpt", code: "too_big", origin: "string", maximum: 160, message: "Too big" },
			{ path: "reading_minutes", code: "too_small", origin: "number", minimum: 1, message: "x" },
			{ path: "stops", code: "too_big", origin: "array", maximum: 1, message: "Too big" },
		]);

		expect(describeContentValidationError(error, FIELDS)).toBe(
			"Headline is required. Summary can have at most 160 characters. Reading time must be at least 1. Stops can have at most 1 item.",
		);
	});

	it("names a repeater sub-field together with its row", () => {
		const error = validationError([
			{ path: "stops.1.name", code: "required", message: "required (empty value not allowed)" },
		]);

		expect(describeContentValidationError(error, FIELDS)).toBe(
			"Stop name (Stops, item 2) is required.",
		);
	});

	it("falls back to the capitalized slug the editor shows for an unlabeled field", () => {
		const error = validationError([
			{ path: "subtitle", code: "too_small", origin: "string", minimum: 3, message: "x" },
		]);

		expect(describeContentValidationError(error, FIELDS)).toBe(
			"Subtitle needs at least 3 characters.",
		);
	});

	it("says once per field that a value is missing when core reports it twice", () => {
		const error = validationError([
			{ path: "title", code: "invalid_type", message: "expected object, received string" },
			{ path: "title", code: "required", message: "required (empty value not allowed)" },
		]);

		expect(describeContentValidationError(error, FIELDS)).toBe("Headline is required.");
	});

	it("names every rule a field breaks", () => {
		const error = validationError([
			{ path: "excerpt", code: "too_small", origin: "string", minimum: 3, message: "x" },
			{ path: "excerpt", code: "invalid_format", format: "regex", message: "x" },
		]);

		expect(describeContentValidationError(error, FIELDS)).toBe(
			"Summary needs at least 3 characters. Summary does not match the required format.",
		);
	});

	it("words references, unknown keys and unrecognized codes without raw validator text", () => {
		const error = validationError([
			{ path: "related", code: "reference_not_found", message: "target 'x' not found" },
			{ path: "legacy_hits", code: "unknown_field", message: "unknown field" },
			{ path: "excerpt", code: "custom", message: "Invalid input" },
		]);

		expect(describeContentValidationError(error, FIELDS)).toBe(
			"Related post links to an entry that does not exist or is in the trash. legacy_hits is not a field in this collection. Summary has an invalid value.",
		);
	});

	it("leaves request-shape issues and other errors to the server message", () => {
		const requestShape = validationError([{ path: "slug", message: "Invalid input" }]);
		const conflict = new ApiResponseError(409, "SLUG_CONFLICT", "Slug exists");

		expect(describeContentValidationError(requestShape, FIELDS)).toBeUndefined();
		expect(describeContentValidationError(conflict, FIELDS)).toBeUndefined();
		expect(describeContentValidationError(new Error("offline"), FIELDS)).toBeUndefined();
	});
});
