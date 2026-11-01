import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { POST as verifyPasskey } from "../../../src/astro/routes/api/auth/passkey/verify.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("passkey verify route", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("reports an unregistered credential distinctly so the browser can forget it", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/auth/passkey/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				credential: {
					id: "unregistered-credential",
					rawId: "unregistered-credential",
					type: "public-key",
					response: {
						clientDataJSON: "AA",
						authenticatorData: "AA",
						signature: "AA",
					},
				},
			}),
		});

		const response = await verifyPasskey({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
			session: {
				set: vi.fn(),
			},
		} as Parameters<typeof verifyPasskey>[0]);

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({
			success: false,
			error: {
				code: "CREDENTIAL_NOT_FOUND",
				message: "Passkey is not registered",
			},
		});
	});

	it("fails before authenticating when Astro has no session", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/auth/passkey/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ credential: { id: "any", rawId: "any", type: "public-key" } }),
		});

		const response = await verifyPasskey({
			request,
			locals: { emdash: { db, config: {} } },
			session: undefined,
		} as Parameters<typeof verifyPasskey>[0]);

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			success: false,
			error: { code: "SESSION_UNAVAILABLE" },
		});
	});
});
