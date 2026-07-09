import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { apiFetch, fetchManifest, throwResponseError } from "../../src/lib/api/client";

describe("apiFetch", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
		globalThis.fetch = fetchSpy;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("adds X-EmDash-Request header", async () => {
		await apiFetch("/test");
		expect(fetchSpy).toHaveBeenCalledOnce();
		const [, init] = fetchSpy.mock.calls[0]!;
		const headers = new Headers(init.headers);
		expect(headers.get("X-EmDash-Request")).toBe("1");
	});

	it("preserves existing headers", async () => {
		await apiFetch("/test", { headers: { "Content-Type": "application/json" } });
		const [, init] = fetchSpy.mock.calls[0]!;
		const headers = new Headers(init.headers);
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(headers.get("X-EmDash-Request")).toBe("1");
	});

	it("passes through other init options", async () => {
		await apiFetch("/test", { method: "POST", body: "data" });
		const [, init] = fetchSpy.mock.calls[0]!;
		expect(init.method).toBe("POST");
		expect(init.body).toBe("data");
	});
});

describe("fetchManifest", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("returns parsed manifest on success", async () => {
		const manifest = {
			version: "1.0",
			collections: {},
			plugins: {},
			authMode: "passkey",
			hash: "abc",
		};
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ data: manifest }), { status: 200 }));
		const result = await fetchManifest();
		expect(result.version).toBe("1.0");
		expect(result.authMode).toBe("passkey");
	});

	it("throws on non-ok response", async () => {
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 500, statusText: "Internal Server Error" }));
		await expect(fetchManifest()).rejects.toThrow("Failed to fetch manifest");
	});
});

/**
 * Regression tests for #255: VALIDATION_ERROR responses carry the actual
 * field problem in `error.details.issues`, but only the generic
 * `error.message` ("Invalid request data") ever reached the user.
 */
describe("throwResponseError", () => {
	const errorResponse = (error: unknown, status = 400) =>
		new Response(JSON.stringify({ error }), { status });

	it("uses the server error message when present", async () => {
		await expect(
			throwResponseError(errorResponse({ code: "NOT_FOUND", message: "Post not found" }), "Failed"),
		).rejects.toThrow("Post not found");
	});

	it("appends validation issue details to the message", async () => {
		const response = errorResponse({
			code: "VALIDATION_ERROR",
			message: "Invalid request data",
			details: {
				issues: [{ path: "name", message: "Too big: expected string to have <=63 characters" }],
			},
		});
		await expect(throwResponseError(response, "Failed")).rejects.toThrow(
			"Invalid request data: name: Too big: expected string to have <=63 characters",
		);
	});

	it("joins multiple issues and tolerates missing paths", async () => {
		const response = errorResponse({
			code: "VALIDATION_ERROR",
			message: "Invalid request data",
			details: {
				issues: [{ path: "slug", message: "Required" }, { message: "Unrecognized key" }],
			},
		});
		await expect(throwResponseError(response, "Failed")).rejects.toThrow(
			"Invalid request data: slug: Required; Unrecognized key",
		);
	});

	it("ignores malformed details", async () => {
		const response = errorResponse({
			code: "VALIDATION_ERROR",
			message: "Invalid request data",
			details: { issues: "not-an-array" },
		});
		await expect(throwResponseError(response, "Failed")).rejects.toThrow("Invalid request data");
	});

	it("falls back to statusText when the body is not JSON", async () => {
		const response = new Response("boom", { status: 500, statusText: "Internal Server Error" });
		await expect(throwResponseError(response, "Failed")).rejects.toThrow(
			"Failed: Internal Server Error",
		);
	});
});
