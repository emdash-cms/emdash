import { describe, expect, it } from "vitest";

import { requireAuthenticated, requireBearerToken } from "../src/api/auth.js";
import { ApiError, serializeApiError } from "../src/api/errors.js";
import { requireOwner, requireOwnerOr } from "../src/api/owner.js";
import { decodeCursor, encodeCursor, parsePagination } from "../src/api/pagination.js";
import { getRequestId } from "../src/api/request-id.js";
import { generateApiSchema } from "../src/api/schema.js";
import {
	MAX_JSON_BODY_BYTES,
	getCorsHeaders,
	getCorsPreflightHeaders,
	parseJsonMutation,
} from "../src/api/security.js";
import { loadConfiguration, type ConfigurationBindings } from "../src/config.js";
import { ROUTES } from "../src/routes.js";

const BINDINGS = {
	PUBLIC_ORIGIN: "https://release.example.com",
	ALLOWED_ORIGINS: '["https://release.example.com","https://console.example.com"]',
	ALLOWED_PUBLISHERS: '{"mode":"allowlist","dids":["did:plc:publisher"]}',
	DEPLOYMENT_POLICY: "hosted",
	ENCRYPTION_KEYRING:
		'{"current":1,"keys":[{"version":1,"key":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"}]}',
} satisfies ConfigurationBindings;

const config = loadConfiguration(BINDINGS);

describe("request IDs and errors", () => {
	it("accepts only bounded, header-safe inbound request IDs", () => {
		expect(
			getRequestId(
				new Request("https://release.example.com", { headers: { "x-request-id": "run:abc-123" } }),
			),
		).toBe("run:abc-123");
		const generated = getRequestId(
			new Request("https://release.example.com", { headers: { "x-request-id": "bad id value" } }),
		);
		expect(generated).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("serializes stable errors without leaking exception messages", () => {
		expect(serializeApiError(new ApiError("FORBIDDEN", 403, "Not allowed"))).toEqual({
			code: "FORBIDDEN",
			message: "Not allowed",
		});
		expect(serializeApiError(new Error("database password leaked"))).toEqual({
			code: "INTERNAL_ERROR",
			message: "Internal server error",
		});
	});
});

describe("configuration", () => {
	it("loads explicit origins, deployment policy, and publisher policy", () => {
		expect(config.publicOrigin).toBe("https://release.example.com");
		expect(config.allowedOrigins.has("https://console.example.com")).toBe(true);
		expect(config.isPublisherAllowed("did:plc:publisher")).toBe(true);
		expect(config.isPublisherAllowed("did:plc:other")).toBe(false);
		expect(config.encryption.currentKeyVersion).toBe(1);
	});

	it.each([
		{ ...BINDINGS, PUBLIC_ORIGIN: "" },
		{ ...BINDINGS, PUBLIC_ORIGIN: "http://release.example.com" },
		{ ...BINDINGS, ALLOWED_ORIGINS: "[]" },
		{ ...BINDINGS, ALLOWED_ORIGINS: '["https://other.example.com"]' },
		{ ...BINDINGS, ALLOWED_PUBLISHERS: '{"mode":"allowlist","dids":["not-a-did"]}' },
		{ ...BINDINGS, DEPLOYMENT_POLICY: "preview" },
		{ ...BINDINGS, ENCRYPTION_KEYRING: "not-json" },
	])("fails closed for invalid deployment configuration", (bindings) => {
		expect(() => loadConfiguration(bindings)).toThrowError("Invalid release-service configuration");
	});
});

describe("mutation security", () => {
	it("parses an allowed JSON mutation with the matching CSRF token", async () => {
		const request = new Request("https://release.example.com/v1/example", {
			method: "POST",
			headers: {
				origin: "https://console.example.com",
				"content-type": "application/json; charset=utf-8",
				"x-emdash-csrf": "session-secret",
			},
			body: '{"ok":true}',
		});
		await expect(parseJsonMutation(request, config, "session-secret")).resolves.toEqual({
			ok: true,
		});
		expect(getCorsHeaders(request, config)).toEqual({
			"access-control-allow-credentials": "true",
			"access-control-allow-origin": "https://console.example.com",
			vary: "Origin",
		});
		expect(getCorsPreflightHeaders(request, config, ["POST", "DELETE"])).toMatchObject({
			"access-control-allow-methods": "POST, DELETE",
			"access-control-allow-headers": expect.stringContaining("X-EmDash-CSRF"),
		});
	});

	it.each([
		{
			name: "GET mutation",
			request: new Request("https://release.example.com/v1/example", {
				headers: {
					origin: BINDINGS.PUBLIC_ORIGIN,
					"content-type": "application/json",
					"x-emdash-csrf": "x",
				},
			}),
			code: "METHOD_NOT_ALLOWED",
		},
		{
			name: "missing origin",
			request: new Request("https://release.example.com/v1/example", {
				method: "POST",
				headers: { "content-type": "application/json", "x-emdash-csrf": "x" },
				body: "{}",
			}),
			code: "ORIGIN_NOT_ALLOWED",
		},
		{
			name: "foreign origin",
			request: new Request("https://release.example.com/v1/example", {
				method: "POST",
				headers: {
					origin: "https://evil.example",
					"content-type": "application/json",
					"x-emdash-csrf": "x",
				},
				body: "{}",
			}),
			code: "ORIGIN_NOT_ALLOWED",
		},
		{
			name: "wrong content type",
			request: new Request("https://release.example.com/v1/example", {
				method: "POST",
				headers: {
					origin: BINDINGS.PUBLIC_ORIGIN,
					"content-type": "text/plain",
					"x-emdash-csrf": "x",
				},
				body: "{}",
			}),
			code: "UNSUPPORTED_MEDIA_TYPE",
		},
		{
			name: "wrong CSRF token",
			request: new Request("https://release.example.com/v1/example", {
				method: "POST",
				headers: {
					origin: BINDINGS.PUBLIC_ORIGIN,
					"content-type": "application/json",
					"x-emdash-csrf": "wrong",
				},
				body: "{}",
			}),
			code: "CSRF_INVALID",
		},
	])("rejects $name", async ({ request, code }) => {
		await expect(parseJsonMutation(request, config, "x")).rejects.toMatchObject({ code });
	});

	it("rejects bodies whose declared or streamed size exceeds the bound", async () => {
		const headers = {
			origin: BINDINGS.PUBLIC_ORIGIN,
			"content-type": "application/json",
			"x-emdash-csrf": "x",
		};
		const declared = new Request("https://release.example.com/v1/example", {
			method: "POST",
			headers: { ...headers, "content-length": String(MAX_JSON_BODY_BYTES + 1) },
			body: "{}",
		});
		await expect(parseJsonMutation(declared, config, "x")).rejects.toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
		});

		const streamed = new Request("https://release.example.com/v1/example", {
			method: "POST",
			headers,
			body: JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) }),
		});
		await expect(parseJsonMutation(streamed, config, "x")).rejects.toMatchObject({
			code: "PAYLOAD_TOO_LARGE",
		});
	});
});

describe("authentication and ownership", () => {
	it("parses strict bearer authentication", () => {
		const request = new Request("https://release.example.com", {
			headers: { authorization: "Bearer token-value" },
		});
		expect(requireBearerToken(request)).toBe("token-value");
		expect(
			requireBearerToken(
				new Request("https://release.example.com", {
					headers: { authorization: "bearer another-token" },
				}),
			),
		).toBe("another-token");
		expect(() => requireBearerToken(new Request("https://release.example.com"))).toThrowError(
			ApiError,
		);
	});

	it("requires identity ownership or an explicit authorization predicate", () => {
		const actor = requireAuthenticated({ subjectDid: "did:plc:publisher" });
		expect(requireOwner(actor, "did:plc:publisher")).toBe(actor);
		expect(() => requireOwner(actor, "did:plc:other")).toThrowError(ApiError);
		expect(requireOwnerOr(actor, "did:plc:other", () => true)).toBe(actor);
	});
});

describe("pagination", () => {
	it("clamps limits and round-trips opaque versioned cursors", () => {
		expect(
			parsePagination(new URL("https://release.example.com?limit=500").searchParams).limit,
		).toBe(100);
		expect(parsePagination(new URL("https://release.example.com?limit=2").searchParams).limit).toBe(
			2,
		);
		const cursor = encodeCursor("2026-07-11T12:00:00.000Z", "01J123");
		expect(cursor).not.toContain("2026-07-11");
		expect(decodeCursor(cursor)).toEqual({
			version: 1,
			orderValue: "2026-07-11T12:00:00.000Z",
			id: "01J123",
		});
	});

	it("rejects malformed and unsupported cursors", () => {
		expect(() => decodeCursor("not-base64-json")).toThrowError(ApiError);
		const unsupported = btoa(JSON.stringify([2, "order", "id"])).replaceAll("=", "");
		expect(() => decodeCursor(unsupported)).toThrowError(ApiError);
		expect(() => encodeCursor("😀".repeat(512), "id")).toThrowError(ApiError);
	});
});

describe("API schema", () => {
	it("generates OpenAPI 3.1 from only the reachable route registry", () => {
		const schema = generateApiSchema();
		expect(schema.openapi).toBe("3.1.0");
		expect(Object.keys(schema.paths)).toEqual(["/health"]);
		expect(schema.paths["/health"]).toHaveProperty("get");
		expect(JSON.stringify(schema)).toContain("requestId");
		expect(JSON.stringify(schema)).toContain("INTERNAL_ERROR");
	});

	it("preserves multiple methods registered for the same path", () => {
		const schema = generateApiSchema([
			...ROUTES,
			{
				...ROUTES[0],
				method: "POST",
				operationId: "postHealthTest",
			},
		]);
		expect(schema.paths["/health"]).toHaveProperty("get");
		expect(schema.paths["/health"]).toHaveProperty("post");
	});
});
