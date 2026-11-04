import { describe, it, expect } from "vitest";

import { apiError, apiSuccess, unwrapResult } from "../../../src/api/error.js";

/**
 * The REST API reference documents a discriminated response envelope:
 * successful responses are `{ success: true, data }` and error responses are
 * `{ success: false, error }`. These tests pin the wire shape so it stays in
 * sync with the documented contract.
 */
describe("API response envelope", () => {
	describe("apiSuccess", () => {
		it("wraps data in { success: true, data }", async () => {
			const body = await apiSuccess({ id: "123" }).json();
			expect(body).toEqual({ success: true, data: { id: "123" } });
		});

		it("keeps the discriminant on non-200 success responses", async () => {
			const response = apiSuccess({ created: true }, 201);
			expect(response.status).toBe(201);
			const body = await response.json();
			expect(body).toEqual({ success: true, data: { created: true } });
		});
	});

	describe("apiError", () => {
		it("wraps the error in { success: false, error }", async () => {
			const body = await apiError("NOT_FOUND", "Missing", 404).json();
			expect(body).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Missing" } });
		});

		it("includes details when provided", async () => {
			const body = await apiError("VALIDATION_ERROR", "Bad input", 400, { field: "title" }).json();
			expect(body).toEqual({
				success: false,
				error: { code: "VALIDATION_ERROR", message: "Bad input", details: { field: "title" } },
			});
		});
	});

	describe("unwrapResult", () => {
		it("emits the success discriminant for ok results", async () => {
			const body = await unwrapResult({ success: true, data: { ok: true } }).json();
			expect(body).toEqual({ success: true, data: { ok: true } });
		});

		it("emits the failure discriminant for error results", async () => {
			const body = await unwrapResult({
				success: false,
				error: { code: "NOT_FOUND", message: "Missing" },
			}).json();
			expect(body).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Missing" } });
		});
	});
});
