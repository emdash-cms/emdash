import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { ConfigurationBindings } from "../src/config.js";
import { failInactiveSchedule, handleRequest, retryUnsupportedQueue } from "../src/index.js";
import { ROUTES, type RouteDefinition } from "../src/routes.js";

const BLOCKED_PATHS = [
	"/v1/release-intents",
	"/v1/release-intents/public-id",
	"/v1/release-intents/public-id/cancel",
	"/v1/release-intents/public-id/approval",
	"/v1/release-intents/public-id/approval/options",
	"/v1/release-intents/public-id/approve",
	"/v1/release-intents/public-id/reject",
	"/v1/me",
	"/v1/delegations",
	"/v1/delegations/start",
	"/v1/workload-policies",
	"/v1/approver/oauth/start",
	"/v1/passkeys",
	"/v1/notification-endpoints",
	"/v1/audit-events",
];

describe("release-service worker", () => {
	it("serves a healthy versioned JSON envelope with a request ID", async () => {
		const response = await SELF.fetch("https://release.example.invalid/health", {
			headers: { "x-request-id": "health-check-1" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-request-id")).toBe("health-check-1");
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			data: { status: "ok" },
			requestId: "health-check-1",
		});
	});

	it("fails health closed without exposing configuration details", async () => {
		const bindings = {
			PUBLIC_ORIGIN: "",
			ALLOWED_ORIGINS: "[]",
			ALLOWED_PUBLISHERS: '{"mode":"all"}',
			DEPLOYMENT_POLICY: "hosted",
			ENCRYPTION_KEYRING:
				'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}',
		} satisfies ConfigurationBindings;
		const response = await handleRequest(new Request("https://test/health"), bindings);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: {
				code: "CONFIGURATION_ERROR",
				message: "Service is not configured",
			},
		});
		const secondResponse = await handleRequest(new Request("https://test/health"), bindings);
		expect(await secondResponse.text()).not.toContain("PUBLIC_ORIGIN");
	});

	it("provides the configured D1 binding", async () => {
		const result = await env.DB.prepare("SELECT 1 AS healthy").first<{ healthy: number }>();
		expect(result).toEqual({ healthy: 1 });
	});

	it("registers only the health route", () => {
		expect(ROUTES.map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /health"]);
	});

	it("catches async route failures without leaking them to clients", async () => {
		const internalMessage = "database password leaked";
		const failingRoute: RouteDefinition = {
			method: "GET",
			path: "/__test/async-rejection",
			operationId: "testAsyncRejection",
			summary: "Test async rejection",
			successStatus: 200,
			successDataSchema: { type: "object" },
			async handler() {
				await Promise.resolve();
				throw new Error(internalMessage);
			},
		};
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const response = await handleRequest(
				new Request("https://release.example.invalid/__test/async-rejection", {
					headers: { "x-request-id": "async-failure-1" },
				}),
				env,
				[failingRoute],
			);
			expect(response.status).toBe(500);
			expect(response.headers.get("x-request-id")).toBe("async-failure-1");
			const body = await response.json();
			expect(body).toEqual({
				error: { code: "INTERNAL_ERROR", message: "Internal server error" },
				requestId: "async-failure-1",
			});
			expect(JSON.stringify(body)).not.toContain(internalMessage);
			expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(internalMessage));
		} finally {
			errorLog.mockRestore();
		}
	});

	it.each(BLOCKED_PATHS)("does not expose %s", async (path) => {
		for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
			const response = await SELF.fetch(`https://release.example.invalid${path}`, { method });
			expect(response.status).toBe(404);
			const body = await response.json<{ error: { code: string } }>();
			expect(body.error.code).toBe("NOT_FOUND");
		}
	});

	it("does not expose static assets through the Worker catch-all", async () => {
		const response = await SELF.fetch("https://release.example.invalid/.gitkeep");
		expect(response.status).toBe(404);
	});

	it("retries messages while lifecycle consumers are unavailable", () => {
		let retryOptions: QueueRetryOptions | undefined;
		retryUnsupportedQueue({
			queue: "emdash-release-service-releases",
			messages: [{ id: "message-1" }],
			retryAll(options) {
				retryOptions = options;
			},
		});
		expect(retryOptions).toEqual({ delaySeconds: 300 });
	});

	it("fails scheduled invocations while lifecycle recovery is unavailable", () => {
		expect(() => failInactiveSchedule(1234)).toThrowError("Scheduled lifecycle is not active");
	});
});
