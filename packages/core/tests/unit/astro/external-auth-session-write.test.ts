import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { authenticate } = vi.hoisted(() => ({
	authenticate: vi.fn(async () => ({
		email: "editor@example.com",
		name: "Provider Name",
		role: 30,
		subject: "access-user",
	})),
}));

vi.mock("virtual:emdash/auth", () => ({ authenticate }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });

let onRequest: typeof import("../../../src/astro/middleware/auth.js").onRequest;

beforeAll(async () => {
	vi.stubEnv("DEV", false);
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

afterAll(() => {
	vi.unstubAllEnvs();
});

type StoredUser = { id: string } | null | undefined;

async function authenticatedRequest(db: Kysely<Database>, read: () => Promise<StoredUser>) {
	const session = { get: vi.fn(read), set: vi.fn() };
	const url = new URL("/_emdash/api/plugins/example/config", "https://example.com");
	const context = {
		request: new Request(url, { headers: { "Cf-Access-Jwt-Assertion": "access-jwt" } }),
		url,
		locals: {
			emdash: {
				db,
				config: {
					auth: {
						type: "cloudflare-access",
						entrypoint: "@emdash-cms/cloudflare/auth",
						config: { teamDomain: "example.cloudflareaccess.com" },
					},
				},
				getPluginRouteMeta: vi.fn(() => ({ public: false })),
			},
		},
		session,
		redirect: vi.fn(),
	};
	const response = await onRequest(context as never, async () => new Response("ok"));
	expect(response.status).toBe(200);
	return session;
}

describe("external auth session write", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const now = new Date().toISOString();
		await db
			.insertInto("users")
			.values({
				id: "user-1",
				email: "editor@example.com",
				name: "Provider Name",
				role: 30,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			})
			.execute();
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("does not write the session or advance last login for the signed-in user", async () => {
		const previousLogin = "2020-01-01T00:00:00.000Z";
		await db
			.updateTable("users")
			.set({ last_login_at: previousLogin })
			.where("id", "=", "user-1")
			.execute();

		const session = await authenticatedRequest(db, async () => ({ id: "user-1" }));
		const user = await db
			.selectFrom("users")
			.select("last_login_at")
			.where("id", "=", "user-1")
			.executeTakeFirstOrThrow();

		expect(session.get).toHaveBeenCalledWith("user");
		expect(session.set).not.toHaveBeenCalled();
		expect(user.last_login_at).toBe(previousLogin);
	});

	it("records the login when writing a fresh session", async () => {
		const session = await authenticatedRequest(db, async () => undefined);
		const user = await db
			.selectFrom("users")
			.select("last_login_at")
			.where("id", "=", "user-1")
			.executeTakeFirstOrThrow();

		expect(session.set).toHaveBeenCalledExactlyOnceWith("user", { id: "user-1" });
		expect(user.last_login_at).toEqual(expect.any(String));
	});

	it("writes the session when the read returns null", async () => {
		const session = await authenticatedRequest(db, async () => null);

		expect(session.set).toHaveBeenCalledExactlyOnceWith("user", { id: "user-1" });
	});

	it("records the login when replacing a different user's session", async () => {
		const session = await authenticatedRequest(db, async () => ({ id: "user-2" }));
		const user = await db
			.selectFrom("users")
			.select("last_login_at")
			.where("id", "=", "user-1")
			.executeTakeFirstOrThrow();

		expect(session.set).toHaveBeenCalledExactlyOnceWith("user", { id: "user-1" });
		expect(user.last_login_at).toEqual(expect.any(String));
	});

	it("writes the session when the read fails", async () => {
		const session = await authenticatedRequest(db, async () => {
			throw new Error("session store unavailable");
		});

		expect(session.set).toHaveBeenCalledExactlyOnceWith("user", { id: "user-1" });
	});
});
