import { describe, expect, it } from "vitest";

import { parseSubmitResponse } from "../src/client/index.js";

describe("parseSubmitResponse", () => {
	it("unwraps successful plugin API responses from the standard API envelope", () => {
		expect(
			parseSubmitResponse({
				data: {
					success: true,
					message: "Thanks",
					redirect: "/thanks",
				},
			}),
		).toEqual({ success: true, message: "Thanks", redirect: "/thanks" });
	});

	it("keeps legacy top-level submit responses working", () => {
		expect(parseSubmitResponse({ success: true, message: "Thanks" })).toEqual({
			success: true,
			message: "Thanks",
		});
	});

	it("unwraps validation errors returned in the standard API envelope", () => {
		expect(
			parseSubmitResponse({
				data: {
					errors: [{ field: "email", message: "Email is required" }],
				},
			}),
		).toEqual({ errors: [{ field: "email", message: "Email is required" }] });
	});

	it("does not recursively unwrap nested envelopes", () => {
		expect(parseSubmitResponse({ data: { data: { success: true, message: "Nested" } } })).toEqual({
			data: { success: true, message: "Nested" },
		});
	});
});
