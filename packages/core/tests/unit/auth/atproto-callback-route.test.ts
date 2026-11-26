import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("@emdash-cms/auth-atproto/oauth-client", () => ({
	getAtprotoOAuthClient: async () => ({
		callback: async () => ({ session: { did: "did:plc:example" } }),
	}),
	resolveAtprotoProfile: async () => ({ displayName: "Example", handle: "example.test" }),
}));
vi.mock("../../../../auth-atproto/src/storage.js", () => ({
	getAtprotoStorage: async () => null,
}));

const { GET: callback } = await import("../../../../auth-atproto/src/routes/callback.js");

describe("Atmosphere sign-in callback", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("signs the user in under a new session id", async () => {
		const store = new Map<string, unknown>([["id-from-request-cookie", { user: { id: "other" } }]]);
		let id = "id-from-request-cookie";
		const session = {
			regenerate: async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				store.delete(id);
				id = "new-id";
			},
			set: (key: string, value: unknown) => {
				store.set(id, { [key]: value });
			},
		};
		const url = "https://example.com/_emdash/api/auth/atproto/callback?code=c&state=s";

		const response = await callback({
			request: new Request(url),
			locals: { emdash: { db, config: {} } },
			session,
			redirect: (path: string) => new Response(null, { status: 302, headers: { Location: path } }),
		} as unknown as Parameters<typeof callback>[0]);

		expect(response.headers.get("Location")).toBe("/_emdash/admin");
		const user = await db
			.selectFrom("users")
			.select("id")
			.where("email", "=", "did-plc-example@atproto.invalid")
			.executeTakeFirstOrThrow();
		expect([...store]).toEqual([["new-id", { user: { id: user.id } }]]);
	});
});
