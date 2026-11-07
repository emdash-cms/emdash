import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { POST as verifyPasskey } from "../../../src/astro/routes/api/auth/passkey/verify.js";
import { createChallengeStore } from "../../../src/auth/challenge-store.js";
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

	describe("when the passkey is rejected", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		function postCredential(credential: Record<string, unknown>) {
			const request = new Request("http://localhost:4321/_emdash/api/auth/passkey/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credential }),
			});
			return verifyPasskey({
				request,
				locals: { emdash: { db, config: {} } },
				session: { set: vi.fn() },
			} as Parameters<typeof verifyPasskey>[0]);
		}

		function base64url(value: string) {
			return Buffer.from(value).toString("base64url");
		}

		async function registeredCredentialFromOtherOrigin() {
			const adapter = createKyselyAdapter(db);
			const user = await adapter.createUser({ email: "editor@example.com" });
			await adapter.createCredential({
				id: "registered-credential",
				userId: user.id,
				publicKey: new Uint8Array([1, 2, 3, 4]),
				algorithm: -7,
				counter: 0,
				deviceType: "multiDevice",
				backedUp: true,
				transports: [],
			});
			const challenge = base64url("sign-in-challenge");
			await createChallengeStore(db).set(challenge, {
				type: "authentication",
				expiresAt: Date.now() + 60_000,
			});
			return {
				id: "registered-credential",
				rawId: "registered-credential",
				type: "public-key",
				response: {
					clientDataJSON: base64url(
						JSON.stringify({
							type: "webauthn.get",
							challenge,
							origin: "https://other.example.com",
						}),
					),
					authenticatorData: "AA",
					signature: "AA",
				},
			};
		}

		it.each([
			{
				code: "credential_not_found",
				credential: async () => ({
					id: "unregistered-credential",
					rawId: "unregistered-credential",
					type: "public-key",
					response: { clientDataJSON: "AA", authenticatorData: "AA", signature: "AA" },
				}),
			},
			{ code: "invalid_origin", credential: registeredCredentialFromOtherOrigin },
		])("logs $code on the server and returns the generic 401", async ({ code, credential }) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

			const response = await postCredential(await credential());

			expect(response.status).toBe(401);
			await expect(response.json()).resolves.toEqual({
				success: false,
				error: { code: "UNAUTHORIZED", message: "Authentication failed" },
			});
			expect(warn).toHaveBeenCalledExactlyOnceWith("[passkey] sign-in rejected:", code);
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
