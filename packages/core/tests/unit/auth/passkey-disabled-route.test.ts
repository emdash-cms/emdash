import { AccountDisabledError } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	authenticateWithPasskey: vi.fn(),
}));

vi.mock("@emdash-cms/auth/passkey", async (importOriginal) => ({
	...(await importOriginal<typeof import("@emdash-cms/auth/passkey")>()),
	authenticateWithPasskey: mocks.authenticateWithPasskey,
}));

import { POST as verifyPasskey } from "../../../src/astro/routes/api/auth/passkey/verify.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("passkey verify route for disabled accounts", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		mocks.authenticateWithPasskey.mockRejectedValue(new AccountDisabledError());
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.clearAllMocks();
	});

	it("returns account disabled without creating a session", async () => {
		const request = new Request("http://localhost:4321/_emdash/api/auth/passkey/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				credential: {
					id: "registered-credential",
					rawId: "registered-credential",
					type: "public-key",
					response: {
						clientDataJSON: "AA",
						authenticatorData: "AA",
						signature: "AA",
					},
				},
			}),
		});
		const setSession = vi.fn();

		const response = await verifyPasskey({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
			session: {
				set: setSession,
			},
		} as Parameters<typeof verifyPasskey>[0]);

		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toEqual({
			success: false,
			error: {
				code: "ACCOUNT_DISABLED",
				message: "Account disabled",
			},
		});
		expect(setSession).not.toHaveBeenCalled();
	});
});
