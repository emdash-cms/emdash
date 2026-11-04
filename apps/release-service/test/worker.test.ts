import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { ConfigurationBindings } from "../src/config.js";
import { handleRequest } from "../src/index.js";
import type { RouteDefinition } from "../src/routes.js";
import { TEST_BINDINGS } from "./fixtures/oauth.js";

describe("release-service Worker", () => {
	it("serves health with a stable JSON envelope and request ID", async () => {
		const response = await SELF.fetch("https://release.example.com/health", {
			headers: { "x-request-id": "health-check-1" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("x-request-id")).toBe("health-check-1");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			data: { status: "ok" },
			requestId: "health-check-1",
		});
	});

	it("serves liveness without loading service configuration", async () => {
		const response = await handleRequest(new Request("https://test/health"), {
			...TEST_BINDINGS,
			PUBLIC_ORIGIN: "",
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: { status: "ok" } });
		expect(
			(await handleRequest(new Request("https://test/health", { method: "POST" }), TEST_BINDINGS))
				.status,
		).toBe(405);
	});

	it("serves readiness only after configuration and control storage initialize", async () => {
		const response = await SELF.fetch("https://release.example.com/ready");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ data: { status: "ready" } });
	});

	it("serves public-only OAuth metadata and overlapping keys", async () => {
		const metadata = await SELF.fetch(
			"https://untrusted.invalid/.well-known/atproto-client-metadata.json",
		);
		expect(metadata.status).toBe(200);
		expect(metadata.headers.get("cache-control")).toBe("public, max-age=300");
		expect(await metadata.json()).toMatchObject({
			client_id: "https://release.example.com/.well-known/atproto-client-metadata.json",
			redirect_uris: ["https://release.example.com/oauth/callback"],
			jwks_uri: "https://release.example.com/oauth/jwks.json",
			scope:
				"atproto repo:com.emdashcms.experimental.package.release?action=create blob:application/gzip blob:image/*",
		});

		const jwks = await SELF.fetch("https://release.example.com/oauth/jwks.json");
		const text = await jwks.text();
		expect(JSON.parse(text).keys).toHaveLength(2);
		expect(text).not.toContain('"d"');
	});

	it("fails configuration closed without exposing binding names", async () => {
		const bindings = {
			...TEST_BINDINGS,
			PUBLIC_ORIGIN: "",
			OAUTH_REDIRECT_URIS: "[]",
		} satisfies ConfigurationBindings;
		const response = await handleRequest(new Request("https://test/ready"), bindings);
		expect(response.status).toBe(503);
		const body = await response.text();
		expect(body).toContain("CONFIGURATION_ERROR");
		expect(body).not.toContain("PUBLIC_ORIGIN");
	});

	it("returns method and route errors without exposing internal failures", async () => {
		expect(
			(await SELF.fetch("https://release.example.com/health", { method: "POST" })).status,
		).toBe(405);
		expect((await SELF.fetch("https://release.example.com/v1/missing")).status).toBe(404);

		const internalMessage = "assertion private key leaked";
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const route: RouteDefinition = {
			method: "GET",
			path: "/__test/failure",
			async handler() {
				await Promise.resolve();
				throw new Error(internalMessage);
			},
		};
		try {
			const response = await handleRequest(
				new Request("https://release.example.com/__test/failure"),
				TEST_BINDINGS,
				[route],
			);
			expect(response.status).toBe(500);
			expect(await response.text()).not.toContain(internalMessage);
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain(internalMessage);
		} finally {
			errorLog.mockRestore();
		}
	});

	it("registers OAuth mutation routes behind their origin and session checks", async () => {
		const identity = await SELF.fetch(
			"https://release.example.com/v1/publisher/session/authorize",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		);
		expect(identity.status).toBe(403);
		expect(
			(await SELF.fetch("https://release.example.com/v1/publisher/delegation/authorize")).status,
		).toBe(405);
	});
});
