import { describe, it, expect } from "vitest";

import { apiError, apiSuccess, handleError, unwrapResult } from "../../../src/api/error.js";

describe("API cache headers", () => {
	const EXPECTED_CACHE_CONTROL = "private, no-store";

	describe("apiSuccess", () => {
		it("should include Cache-Control: private, no-store", () => {
			const response = apiSuccess({ ok: true });
			expect(response.headers.get("Cache-Control")).toBe(EXPECTED_CACHE_CONTROL);
		});

		it("should not include Vary header", () => {
			const response = apiSuccess({ ok: true });
			expect(response.headers.has("Vary")).toBe(false);
		});

		it("should still include correct status and body", async () => {
			const response = apiSuccess({ id: "123" }, 201);
			expect(response.status).toBe(201);
			const body = await response.json();
			expect(body).toEqual({ success: true, data: { id: "123" } });
		});
	});

	describe("apiError", () => {
		it("should include Cache-Control: private, no-store", () => {
			const response = apiError("NOT_FOUND", "Not found", 404);
			expect(response.headers.get("Cache-Control")).toBe(EXPECTED_CACHE_CONTROL);
		});

		it("should not include Vary header", () => {
			const response = apiError("NOT_FOUND", "Not found", 404);
			expect(response.headers.has("Vary")).toBe(false);
		});

		it("should still include correct status and body", async () => {
			const response = apiError("FORBIDDEN", "Access denied", 403);
			expect(response.status).toBe(403);
			const body = await response.json();
			expect(body).toEqual({
				success: false,
				error: { code: "FORBIDDEN", message: "Access denied" },
			});
		});
	});

	describe("handleError", () => {
		it("should include cache headers on 500 responses", () => {
			const response = handleError(new Error("db crash"), "Something went wrong", "INTERNAL");
			expect(response.headers.get("Cache-Control")).toBe(EXPECTED_CACHE_CONTROL);
			expect(response.headers.has("Vary")).toBe(false);
		});
	});

	describe("unwrapResult", () => {
		it("should include cache headers on success", () => {
			const response = unwrapResult({ success: true, data: { id: "1" } });
			expect(response.headers.get("Cache-Control")).toBe(EXPECTED_CACHE_CONTROL);
			expect(response.headers.has("Vary")).toBe(false);
		});

		it("should include cache headers on error", () => {
			const response = unwrapResult({
				success: false,
				error: { code: "NOT_FOUND", message: "Not found" },
			});
			expect(response.headers.get("Cache-Control")).toBe(EXPECTED_CACHE_CONTROL);
			expect(response.headers.has("Vary")).toBe(false);
		});
	});
});
