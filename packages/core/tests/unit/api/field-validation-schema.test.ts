/**
 * Repeater sub-field type validation (issue #1424).
 *
 * The Zod enum guarding `validation.subFields[].type` must stay in sync with
 * `REPEATER_SUB_FIELD_TYPES` (schema/types.ts). It was missing "url" (a
 * documented sub-field type the schema-builder UI offers) and gained "image"
 * together with media-picker support in repeater rows.
 */

import { describe, it, expect } from "vitest";

import { createFieldBody } from "../../../src/api/schemas/schema.js";
import { REPEATER_SUB_FIELD_TYPES } from "../../../src/schema/types.js";

function repeaterFieldWith(subFieldType: string) {
	return {
		slug: "gallery",
		label: "Gallery",
		type: "repeater",
		validation: {
			subFields: [{ slug: "entry", type: subFieldType, label: "Entry" }],
		},
	};
}

describe("createFieldBody repeater sub-field types", () => {
	it.each([...REPEATER_SUB_FIELD_TYPES])("accepts %s sub-fields", (type) => {
		const result = createFieldBody.safeParse(repeaterFieldWith(type));
		expect(result.success).toBe(true);
	});

	it("rejects unsupported sub-field types", () => {
		for (const type of ["repeater", "portableText", "reference", "nonsense"]) {
			const result = createFieldBody.safeParse(repeaterFieldWith(type));
			expect(result.success).toBe(false);
		}
	});
});
