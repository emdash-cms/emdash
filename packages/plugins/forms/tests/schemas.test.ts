import { describe, expect, it } from "vitest";

import { exportSchema } from "../src/schemas.js";

describe("exportSchema", () => {
	it("accepts minute-precision ISO datetime bounds", () => {
		const from = "2026-09-01T14:30Z";
		const to = "2026-09-01T15:30Z";
		expect(exportSchema.parse({ formId: "contact", format: "csv", from, to })).toEqual({
			formId: "contact",
			format: "csv",
			from,
			to,
		});
	});
});
