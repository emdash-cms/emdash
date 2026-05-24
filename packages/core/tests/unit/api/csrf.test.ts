import { describe, it, expect } from "vitest";

import { checkPublicCsrf } from "../../../src/api/csrf.js";

function makeRequest(method: string, headers: Record<string, string> = {}): Request {
	return new Request("http://example.com/_emdash/api/comments/posts/abc", {
		method,
		headers,
	});
}

function makeUrl(host = "example.com"): URL {
	return new URL(`http://${host}/_emdash/api/comments/posts/abc`);
}

describe("checkPublicCsrf", () => {
	describe("allows requests with X-EmDash-Request header", () => {
		it("allows POST with custom header", () => {
			const request = makeRequest("POST", { "X-EmDash-Request": "1" });
			expect(checkPublicCsrf(request, makeUrl())).toBeNull();
		});

		it("allows POST with custom header even if Origin is cross-origin", () => {
			const request = makeRequest("POST", {
				"X-EmDash-Request": "1",
				Origin: "http://evil.com",
			});
			expect(checkPublicCsrf(request, makeUrl())).toBeNull();
		});
	});

	describe("allows same-origin requests", () => {
		it("allows POST with matching Origin", () => {
			const request = makeRequest("POST", {
				Origin: "http://example.com",
			});
			expect(checkPublicCsrf(request, makeUrl())).toBeNull();
		});

		it("allows POST with matching Origin on different path", () => {
			const request = makeRequest("POST", {
				Origin: "http://example.com",
			});
			const url = new URL("http://example.com/_emdash/api/auth/invite/complete");
			expect(checkPublicCsrf(request, url)).toBeNull();
		});

		it("matches host including port", () => {
			const request = makeRequest("POST", {
				Origin: "http://localhost:4321",
			});
			const url = new URL("http://localhost:4321/_emdash/api/comments/posts/abc");
			expect(checkPublicCsrf(request, url)).toBeNull();
		});
	});

	describe("blocks cross-origin requests", () => {
		it("returns 403 with CSRF_REJECTED code", async () => {
			const request = makeRequest("POST", {
				Origin: "http://evil.com",
			});
			const response = checkPublicCsrf(request, makeUrl());
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
			const body = await response!.json();
			expect(body).toEqual({
				error: { code: "CSRF_REJECTED", message: "Cross-origin request blocked" },
			});
		});

		it("rejects Origin with different port", async () => {
			const request = makeRequest("POST", {
				Origin: "http://example.com:9999",
			});
			const response = checkPublicCsrf(request, makeUrl());
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
		});

		it("rejects Origin with different host", async () => {
			const request = makeRequest("POST", {
				Origin: "http://attacker.example.com",
			});
			const response = checkPublicCsrf(request, makeUrl());
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
		});

		it("rejects cross-scheme Origin (http vs https)", async () => {
			const request = makeRequest("POST", {
				Origin: "https://example.com",
			});
			// Request URL is http://example.com — same host but different scheme
			const response = checkPublicCsrf(request, makeUrl());
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
		});

		it("rejects malformed Origin header", async () => {
			const request = makeRequest("POST", {
				Origin: "not-a-valid-url",
			});
			const response = checkPublicCsrf(request, makeUrl());
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
		});

		it("rejects Origin: null (sandboxed iframe)", async () => {
			const request = makeRequest("POST", { Origin: "null" });
			const response = checkPublicCsrf(request, makeUrl());
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
		});
	});

	describe("dual-origin matching (reverse proxy)", () => {
		it("accepts Origin matching public origin when behind proxy", () => {
			const request = makeRequest("POST", {
				Origin: "https://mysite.example.com",
			});
			// Internal URL is http, public is https — proxy scenario
			const url = new URL("http://localhost:4321/_emdash/api/comments/posts/abc");
			expect(checkPublicCsrf(request, url, "https://mysite.example.com")).toBeNull();
		});

		it("still accepts Origin matching internal origin when publicOrigin is set", () => {
			const request = makeRequest("POST", {
				Origin: "http://localhost:4321",
			});
			const url = new URL("http://localhost:4321/_emdash/api/comments/posts/abc");
			expect(checkPublicCsrf(request, url, "https://mysite.example.com")).toBeNull();
		});

		it("rejects Origin matching neither internal nor public", () => {
			const request = makeRequest("POST", {
				Origin: "http://evil.com",
			});
			const url = new URL("http://localhost:4321/_emdash/api/comments/posts/abc");
			const response = checkPublicCsrf(request, url, "https://mysite.example.com");
			expect(response).not.toBeNull();
			expect(response!.status).toBe(403);
		});

		it("unchanged behavior when publicOrigin is undefined", () => {
			const request = makeRequest("POST", {
				Origin: "http://example.com",
			});
			expect(checkPublicCsrf(request, makeUrl(), undefined)).toBeNull();
		});
	});

	describe("allows requests without Origin header", () => {
		it("allows POST without any Origin (non-browser client)", () => {
			const request = makeRequest("POST");
			expect(checkPublicCsrf(request, makeUrl())).toBeNull();
		});

		it("allows POST without Origin or custom header (curl/server)", () => {
			const request = makeRequest("POST", {
				"Content-Type": "application/json",
			});
			expect(checkPublicCsrf(request, makeUrl())).toBeNull();
		});
	});
});
