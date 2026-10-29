import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleTokenRevoke } from "../../../src/api/handlers/device-flow.js";
import { POST } from "../../../src/astro/routes/api/oauth/token.js";
import { generatePrefixedToken, TOKEN_PREFIXES } from "../../../src/auth/api-tokens.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

describe("POST /_emdash/api/oauth/token", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("users")
			.values({
				id: "refresh-user",
				email: "refresh@example.com",
				name: "Refresh User",
				role: 50,
				email_verified: 1,
			})
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function post(form: Record<string, string>) {
		const url = new URL("http://localhost/_emdash/api/oauth/token");
		return POST({
			url,
			request: new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(form),
			}),
			locals: { emdash: { db } },
		} as unknown as Parameters<typeof POST>[0]);
	}

	async function insertDeviceCode(values: {
		device_code: string;
		status: string;
		expires_at?: string;
		user_id?: string | null;
	}) {
		await db
			.insertInto("_emdash_device_codes")
			.values({
				device_code: values.device_code,
				user_code: `${values.device_code}-user`,
				scopes: JSON.stringify(["content:read"]),
				status: values.status,
				expires_at: values.expires_at ?? new Date(Date.now() + 60_000).toISOString(),
				interval: 5,
				user_id: values.user_id ?? null,
			})
			.execute();
	}

	async function expectInvalidGrant(response: Response, description: string) {
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_grant",
			error_description: description,
		});
	}

	it("normalizes the reported invalid refresh token format response", async () => {
		const response = await post({
			grant_type: "refresh_token",
			refresh_token: "ec_oat_invalid",
			client_id: "any",
		});

		await expectInvalidGrant(response, "Invalid refresh token format");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("normalizes an unknown well-prefixed refresh token", async () => {
		const response = await post({
			grant_type: "refresh_token",
			refresh_token: "ec_ort_unknown",
		});

		await expectInvalidGrant(response, "Invalid refresh token");
	});

	it("normalizes a revoked refresh token", async () => {
		const token = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
		await db
			.insertInto("_emdash_oauth_tokens")
			.values({
				token_hash: token.hash,
				token_type: "refresh",
				user_id: "refresh-user",
				scopes: JSON.stringify(["content:read"]),
				client_type: "cli",
				expires_at: new Date(Date.now() + 60_000).toISOString(),
				refresh_token_hash: null,
			})
			.execute();
		expect((await handleTokenRevoke(db, { token: token.raw })).success).toBe(true);

		await expectInvalidGrant(
			await post({ grant_type: "refresh_token", refresh_token: token.raw }),
			"Invalid refresh token",
		);
	});

	it("normalizes an expired persisted refresh token", async () => {
		const token = generatePrefixedToken(TOKEN_PREFIXES.OAUTH_REFRESH);
		await db
			.insertInto("_emdash_oauth_tokens")
			.values({
				token_hash: token.hash,
				token_type: "refresh",
				user_id: "refresh-user",
				scopes: JSON.stringify(["content:read"]),
				client_type: "cli",
				expires_at: new Date(Date.now() - 60_000).toISOString(),
				refresh_token_hash: null,
			})
			.execute();

		await expectInvalidGrant(
			await post({ grant_type: "refresh_token", refresh_token: token.raw }),
			"Refresh token expired",
		);
	});

	it("normalizes an unknown device code", async () => {
		await expectInvalidGrant(
			await post({ grant_type: DEVICE_GRANT, device_code: "unknown-device" }),
			"Invalid device code",
		);
	});

	it("normalizes an authorized device code without a user", async () => {
		await insertDeviceCode({ device_code: "authorized-without-user", status: "authorized" });

		await expectInvalidGrant(
			await post({ grant_type: DEVICE_GRANT, device_code: "authorized-without-user" }),
			"Invalid device code state",
		);
	});

	it.each([
		["pending", "authorization_pending", "Authorization pending"],
		["expired", "expired_token", "The device code has expired"],
		["denied", "access_denied", "The user denied the request"],
	] as const)("preserves the %s device polling response", async (status, error, description) => {
		await insertDeviceCode({
			device_code: `device-${status}`,
			status,
			expires_at: status === "expired" ? new Date(Date.now() - 60_000).toISOString() : undefined,
		});

		const response = await post({ grant_type: DEVICE_GRANT, device_code: `device-${status}` });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error, error_description: description });
	});
});
