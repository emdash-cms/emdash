import { describe, it, expect } from "vitest";

import { reference } from "../../src/fields/reference.js";
import { STORAGELESS_FIELD_TYPES, FIELD_TYPE_TO_COLUMN } from "../../src/schema/types.js";

describe("reference field", () => {
	it("should create field definition", () => {
		const field = reference("posts");

		expect(field.type).toBe("reference");
		expect(field.schema).toBeDefined();
		expect(field.ui?.widget).toBe("reference");
		expect(field.options?.collection).toBe("posts");
	});

	it("should accept valid reference ID", () => {
		const field = reference("posts");

		expect(() => field.schema.parse("post-123")).not.toThrow();
		expect(() => field.schema.parse("abc-def-ghi")).not.toThrow();
	});

	it("should reject invalid reference", () => {
		const field = reference("posts");

		expect(() => field.schema.parse(123)).toThrow();
		expect(() => field.schema.parse({})).toThrow();
		expect(() => field.schema.parse(null)).toThrow();
	});

	it("should support required option", () => {
		const required = reference("posts", { required: true });
		const optional = reference("posts", { required: false });

		// Required should reject undefined
		expect(() => required.schema.parse(undefined)).toThrow();

		// Optional should accept undefined
		expect(() => optional.schema.parse(undefined)).not.toThrow();
	});
});

describe("storage-less field types", () => {
	it("marks reference as storage-less but keeps its column-type guard entry", () => {
		expect(STORAGELESS_FIELD_TYPES.has("reference")).toBe(true);
		expect(STORAGELESS_FIELD_TYPES.has("string")).toBe(false);
		// The map still contains reference so isFieldType() keeps recognizing it.
		expect(FIELD_TYPE_TO_COLUMN.reference).toBe("TEXT");
	});
});
