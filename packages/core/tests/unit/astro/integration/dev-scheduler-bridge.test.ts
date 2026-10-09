import { EventEmitter } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startDevSchedulerBridge } from "../../../../src/astro/integration/dev-scheduler-bridge.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("Dev scheduler bridge", () => {
	// CN=localhost only. The request uses 127.0.0.1, so the name does not match.
	const DEV_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBfjCCASWgAwIBAgIUEQ/KLE4q64vdG9cJ07GeXUUMbHswCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwODE1MDA1OVoYDzIxMjYwOTE0
MTUwMDU5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARPyU9gIMCVjqfN423GL2oH12pL3ujbJB7o3B1548OcJwsHsVGy9gs2
gFFkIJMLbojfprRHdUwjq5oO5Y6Akid+o1MwUTAdBgNVHQ4EFgQUhlB6b7iesGCd
yx3im+WTQ5lDgQkwHwYDVR0jBBgwFoAUhlB6b7iesGCdyx3im+WTQ5lDgQkwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiA1DZf7wbVmUY/jf7gGQnHk
bEYZOMXgbfW53wVVHZqC3gIgE9yQQqljKvG1LLSTKFVL/tNCsJDk0GYpKsooZHlb
NoI=
-----END CERTIFICATE-----`;
	const DEV_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgzwvDO439vK7SV7vL
I8K/mE5A/poD35ISz/+VApmzip+hRANCAARPyU9gIMCVjqfN423GL2oH12pL3ujb
JB7o3B1548OcJwsHsVGy9gs2gFFkIJMLbojfprRHdUwjq5oO5Y6Akid+
-----END PRIVATE KEY-----`;

	it("posts maintenance to a self-signed HTTPS server whose name does not match", async () => {
		let maintenanceRequests = 0;
		const httpServer = createHttpsServer(
			{ key: DEV_TLS_KEY, cert: DEV_TLS_CERT },
			(request, response) => {
				if (request.url === "/_emdash/api/dev/scheduled-tasks" && request.method === "POST") {
					maintenanceRequests++;
				}
				response.writeHead(204).end();
			},
		);
		const server = {
			httpServer,
			resolvedUrls: { local: [] as string[], network: [] },
		};
		const warn = vi.fn();
		startDevSchedulerBridge(server, { warn }, { intervalMs: 25 });
		try {
			await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
			const address = httpServer.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			server.resolvedUrls.local.push(`https://127.0.0.1:${address.port}`);
			await vi.waitFor(() => expect(maintenanceRequests).toBeGreaterThan(0));
			expect(warn).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	});

	it("keeps issuing maintenance requests after the initial HTTP response completes", async () => {
		let maintenanceRequests = 0;
		let applicationScheduledRequests = 0;
		const httpServer = createHttpServer((request, response) => {
			if (request.url === "/_emdash/api/dev/scheduled-tasks" && request.method === "POST") {
				maintenanceRequests++;
			}
			if (request.url?.startsWith("/cdn-cgi/handler/scheduled")) {
				applicationScheduledRequests++;
			}
			response.writeHead(204).end();
		});
		const server = { httpServer, resolvedUrls: { local: [] as string[], network: [] } };
		const warn = vi.fn();
		startDevSchedulerBridge(server, { warn }, { intervalMs: 25 });

		try {
			await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
			const address = httpServer.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			const origin = `http://127.0.0.1:${address.port}`;
			server.resolvedUrls.local.push(origin);
			const initialResponse = await fetch(origin);
			await initialResponse.arrayBuffer();
			const requestsAfterInitialResponse = maintenanceRequests;

			await vi.waitFor(() => {
				expect(maintenanceRequests).toBeGreaterThanOrEqual(requestsAfterInitialResponse + 2);
			});
			expect(applicationScheduledRequests).toBe(0);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});

	function createServer(origin = "http://localhost:4323/") {
		return Object.assign(new EventEmitter(), {
			address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4323 }),
			resolvedUrls: { local: [origin], network: [] },
		});
	}

	it("drives the EmDash maintenance bridge from the long-lived dev server", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 200 }));
		const warn = vi.fn();

		startDevSchedulerBridge(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(999);
		expect(fetchScheduled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(fetchScheduled).toHaveBeenCalledOnce();
		const url = new URL(String(fetchScheduled.mock.calls[0]?.[0]));
		expect(url.origin).toBe("http://localhost:4323");
		expect(url.pathname).toBe("/_emdash/api/dev/scheduled-tasks");
		expect(url.search).toBe("");
		expect(fetchScheduled.mock.calls[0]?.[1]).toEqual({ method: "POST" });
		expect(warn).not.toHaveBeenCalled();

		httpServer.emit("close");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetchScheduled).toHaveBeenCalledOnce();
	});

	it("uses Vite's resolved HTTPS origin instead of reconstructing localhost", async () => {
		vi.useFakeTimers();
		const httpServer = createServer("https://dev.example.test:7443/");
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 204 }));

		startDevSchedulerBridge(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn: vi.fn() },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(1_000);

		expect(String(fetchScheduled.mock.calls[0]?.[0])).toBe(
			"https://dev.example.test:7443/_emdash/api/dev/scheduled-tasks",
		);
	});

	it.each(["/docs/", "/docs", "/nested/docs/"])("preserves the dev base path %s", async (base) => {
		vi.useFakeTimers();
		const httpServer = createServer(`https://dev.example.test:7443${base}`);
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 204 }));
		startDevSchedulerBridge(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn: vi.fn() },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(String(fetchScheduled.mock.calls[0]?.[0])).toBe(
			`https://dev.example.test:7443${base.replace(/\/$/, "")}/_emdash/api/dev/scheduled-tasks`,
		);
	});

	it("reports a missing maintenance bridge and keeps polling", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const fetchScheduled = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValue(new Response(null, { status: 200 }));
		const warn = vi.fn();

		startDevSchedulerBridge(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(1_000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("status 404"));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetchScheduled).toHaveBeenCalledTimes(2);
	});
});
