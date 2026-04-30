import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as registerClient } from "../../../src/astro/routes/api/oauth/register.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("oauth register route", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns RFC 7591-style errors for malformed JSON", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/oauth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{",
		});

		const response = await registerClient({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
		} as Parameters<typeof registerClient>[0]);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "invalid_client_metadata",
			error_description: "Request body must be valid JSON",
		});
	});

	it("rejects unsupported token endpoint auth methods", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/oauth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["http://127.0.0.1:9999/callback"],
				token_endpoint_auth_method: "client_secret_basic",
			}),
		});

		const response = await registerClient({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
		} as Parameters<typeof registerClient>[0]);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "invalid_client_metadata",
			error_description: "Only token_endpoint_auth_method=none is supported",
		});
	});

	it("rejects redirect URIs that the authorize flow would later refuse", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/oauth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["http://example.com/callback"],
			}),
		});

		const response = await registerClient({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
		} as Parameters<typeof registerClient>[0]);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			error: "invalid_client_metadata",
			error_description: "Invalid redirect URI: HTTP redirect URIs are only allowed for localhost",
		});
	});

	it("registers public clients with loopback redirect URIs", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/oauth/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Harness Test",
				redirect_uris: ["http://127.0.0.1:9999/callback"],
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			}),
		});

		const response = await registerClient({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
		} as Parameters<typeof registerClient>[0]);

		expect(response.status).toBe(201);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Pragma")).toBe("no-cache");

		const body = (await response.json()) as Record<string, unknown>;
		expect(body.client_name).toBe("Harness Test");
		expect(body.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
		expect(body.token_endpoint_auth_method).toBe("none");
		expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
		expect(body.response_types).toEqual(["code"]);
		expect(typeof body.client_id).toBe("string");
	});
});
