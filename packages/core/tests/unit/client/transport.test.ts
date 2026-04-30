import { describe, it, expect } from "vitest";

import type { Interceptor } from "../../../src/client/transport.js";
import {
	createTransport,
	csrfInterceptor,
	refreshInterceptor,
	tokenInterceptor,
} from "../../../src/client/transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an interceptor that adds a header to the request */
function createHeaderInterceptor(name: string, value: string): Interceptor {
	return async (req, next) => {
		const headers = new Headers(req.headers);
		headers.set(name, value);
		return next(new Request(req, { headers }));
	};
}

/** Create a mock fetch that returns a fixed response */
function mockFetch(body: unknown = {}, status: number = 200): Interceptor {
	return async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
}

// ---------------------------------------------------------------------------
// createTransport
// ---------------------------------------------------------------------------

describe("createTransport", () => {
	it("calls global fetch when no interceptors are provided", async () => {
		const transport = createTransport({
			interceptors: [mockFetch({ ok: true })],
		});

		const res = await transport.fetch(new Request("https://example.com"));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toEqual({ ok: true });
	});

	it("runs interceptors in order", async () => {
		const order: string[] = [];

		const first: Interceptor = async (req, next) => {
			order.push("first-before");
			const res = await next(req);
			order.push("first-after");
			return res;
		};

		const second: Interceptor = async (req, next) => {
			order.push("second-before");
			const res = await next(req);
			order.push("second-after");
			return res;
		};

		const transport = createTransport({
			interceptors: [first, second, mockFetch()],
		});

		await transport.fetch(new Request("https://example.com"));
		expect(order).toEqual(["first-before", "second-before", "second-after", "first-after"]);
	});

	it("allows interceptors to modify requests", async () => {
		let capturedHeader: string | null = null;

		const addHeader = createHeaderInterceptor("X-Custom", "test-value");

		const capture: Interceptor = async (req) => {
			capturedHeader = req.headers.get("X-Custom");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [addHeader, capture],
		});

		await transport.fetch(new Request("https://example.com"));
		expect(capturedHeader).toBe("test-value");
	});

	it("allows interceptors to retry on failure", async () => {
		let attempts = 0;

		const retryOnce: Interceptor = async (req, next) => {
			const res = await next(req);
			if (res.status === 401 && attempts === 0) {
				attempts++;
				return next(req);
			}
			return res;
		};

		let callCount = 0;
		const backend: Interceptor = async () => {
			callCount++;
			if (callCount === 1) {
				return new Response("unauthorized", { status: 401 });
			}
			return new Response("ok", { status: 200 });
		};

		const transport = createTransport({
			interceptors: [retryOnce, backend],
		});

		const res = await transport.fetch(new Request("https://example.com"));
		expect(res.status).toBe(200);
		expect(callCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// csrfInterceptor
// ---------------------------------------------------------------------------

describe("csrfInterceptor", () => {
	it("adds X-EmDash-Request header to POST requests", async () => {
		let capturedHeader: string | null = null;
		const capture: Interceptor = async (req) => {
			capturedHeader = req.headers.get("X-EmDash-Request");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [csrfInterceptor(), capture],
		});

		await transport.fetch(new Request("https://example.com", { method: "POST" }));
		expect(capturedHeader).toBe("1");
	});

	it("adds X-EmDash-Request header to PUT requests", async () => {
		let capturedHeader: string | null = null;
		const capture: Interceptor = async (req) => {
			capturedHeader = req.headers.get("X-EmDash-Request");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [csrfInterceptor(), capture],
		});

		await transport.fetch(new Request("https://example.com", { method: "PUT" }));
		expect(capturedHeader).toBe("1");
	});

	it("adds X-EmDash-Request header to DELETE requests", async () => {
		let capturedHeader: string | null = null;
		const capture: Interceptor = async (req) => {
			capturedHeader = req.headers.get("X-EmDash-Request");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [csrfInterceptor(), capture],
		});

		await transport.fetch(new Request("https://example.com", { method: "DELETE" }));
		expect(capturedHeader).toBe("1");
	});

	it("does NOT add header to GET requests", async () => {
		let capturedHeader: string | null = null;
		const capture: Interceptor = async (req) => {
			capturedHeader = req.headers.get("X-EmDash-Request");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [csrfInterceptor(), capture],
		});

		await transport.fetch(new Request("https://example.com", { method: "GET" }));
		expect(capturedHeader).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// tokenInterceptor
// ---------------------------------------------------------------------------

describe("tokenInterceptor", () => {
	it("adds Authorization Bearer header to all requests", async () => {
		let capturedAuth: string | null = null;
		const capture: Interceptor = async (req) => {
			capturedAuth = req.headers.get("Authorization");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [tokenInterceptor("ec_pat_abc123"), capture],
		});

		await transport.fetch(new Request("https://example.com"));
		expect(capturedAuth).toBe("Bearer ec_pat_abc123");
	});

	it("adds Authorization to both GET and POST", async () => {
		const captured: string[] = [];
		const capture: Interceptor = async (req) => {
			captured.push(req.headers.get("Authorization") ?? "");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [tokenInterceptor("tok"), capture],
		});

		await transport.fetch(new Request("https://example.com", { method: "GET" }));
		await transport.fetch(new Request("https://example.com", { method: "POST" }));
		expect(captured).toEqual(["Bearer tok", "Bearer tok"]);
	});
});

// ---------------------------------------------------------------------------
// Interceptor composition
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// refreshInterceptor
// ---------------------------------------------------------------------------

describe("refreshInterceptor", () => {
	it("unwraps { data: { access_token } } envelope from token endpoint", async () => {
		let retryAuth: string | null = null;
		let refreshedToken: string | null = null;
		let refreshedRefresh: string | null = null;

		const interceptor = refreshInterceptor({
			refreshToken: "rt_old",
			tokenEndpoint: "https://example.com/_emdash/api/oauth/token/refresh",
			onTokenRefreshed: (accessToken, refreshToken) => {
				refreshedToken = accessToken;
				refreshedRefresh = refreshToken;
			},
		});

		// Mock: first call returns 401, refresh endpoint returns wrapped envelope,
		// retry should use the new token
		let callCount = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url.includes("/oauth/token/refresh")) {
				// Server wraps in { data: ... } via apiSuccess/unwrapResult
				return new Response(
					JSON.stringify({
						data: {
							access_token: "new_access",
							refresh_token: "new_refresh",
							expires_in: 3600,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return originalFetch(input);
		};

		try {
			const backend: Interceptor = async (req) => {
				callCount++;
				if (callCount === 1) {
					return new Response("unauthorized", { status: 401 });
				}
				retryAuth = req.headers.get("Authorization");
				return new Response("ok", { status: 200 });
			};

			const transport = createTransport({
				interceptors: [interceptor, backend],
			});

			const res = await transport.fetch(new Request("https://example.com/api/test"));
			expect(res.status).toBe(200);
			expect(callCount).toBe(2);
			expect(retryAuth).toBe("Bearer new_access");
			expect(refreshedToken).toBe("new_access");
			expect(refreshedRefresh).toBe("new_refresh");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

// ---------------------------------------------------------------------------
// Interceptor composition
// ---------------------------------------------------------------------------

describe("interceptor composition", () => {
	it("csrf + token interceptors compose correctly", async () => {
		let capturedAuth: string | null = null;
		let capturedCsrf: string | null = null;

		const capture: Interceptor = async (req) => {
			capturedAuth = req.headers.get("Authorization");
			capturedCsrf = req.headers.get("X-EmDash-Request");
			return new Response("ok");
		};

		const transport = createTransport({
			interceptors: [csrfInterceptor(), tokenInterceptor("tok"), capture],
		});

		await transport.fetch(new Request("https://example.com", { method: "POST" }));
		expect(capturedAuth).toBe("Bearer tok");
		expect(capturedCsrf).toBe("1");
	});
});
