import type { Kysely } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { answersOverIo } from "../../utils/query-plugins.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("virtual:emdash/auth", () => ({ authenticate }));
vi.mock("virtual:emdash/config", () => ({ default: {} }));
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

type AuthMiddlewareModule = typeof import("../../../src/astro/middleware/auth.js");

let onRequest: AuthMiddlewareModule["onRequest"];
let db: Kysely<Database>;

beforeAll(async () => {
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

beforeEach(async () => {
	vi.stubEnv("DEV", false);
	authenticate.mockReset();
	authenticate.mockImplementation(async (request: Request) => {
		const email = request.headers.get("x-test-email") ?? "";
		return { email, name: email, role: 30 };
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
	db = await setupTestDatabase();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await teardownTestDatabase(db);
});

function signIn(email: string, database: Kysely<Database>) {
	const url = new URL("/_emdash/api/content/posts", "https://site.example.com");
	return onRequest(
		{
			url,
			request: new Request(url, { headers: { "x-test-email": email } }),
			locals: {
				emdash: {
					db: database,
					config: { auth: { type: "cloudflare-access", entrypoint: "test-auth", config: {} } },
				},
			},
			session: { get: vi.fn(), set: vi.fn(), destroy: vi.fn(), regenerate: vi.fn(async () => {}) },
		} as unknown as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		vi.fn(async () => new Response("ok")),
	);
}

describe("external auth first admin", () => {
	it("makes only one of several simultaneous first sign-ins the admin", async () => {
		const slowDb = db.withPlugin(answersOverIo);

		await Promise.all([
			signIn("a@example.com", slowDb),
			signIn("b@example.com", slowDb),
			signIn("c@example.com", slowDb),
		]);

		const users = await db.selectFrom("users").select(["role", "email_verified"]).execute();
		expect(users.map((u) => u.role).toSorted((x, y) => x - y)).toEqual([30, 30, 50]);
		expect(users.every((u) => u.email_verified === 1)).toBe(true);
	});

	it("gives the configured role to sign-ins after the first", async () => {
		await signIn("owner@example.com", db);
		await signIn("author@example.com", db);

		const users = await db.selectFrom("users").select(["email", "role"]).orderBy("email").execute();
		expect(users).toEqual([
			{ email: "author@example.com", role: 30 },
			{ email: "owner@example.com", role: 50 },
		]);
	});

	it("stores one account when simultaneous first sign-ins share a mixed-case email", async () => {
		const slowDb = db.withPlugin(answersOverIo);

		const responses = await Promise.all([
			signIn("Owner@Example.com", slowDb),
			signIn("Owner@Example.com", slowDb),
		]);

		expect(await db.selectFrom("users").select(["email", "role"]).execute()).toEqual([
			{ email: "owner@example.com", role: 50 },
		]);
		expect(responses.some((r) => r.status === 200)).toBe(true);
	});

	it("provisions a later user whose email has capitals", async () => {
		await signIn("owner@example.com", db);

		const response = await signIn("Author@Example.com", db);

		expect(response.status).toBe(200);
		expect(
			await db
				.selectFrom("users")
				.select("role")
				.where("email", "=", "author@example.com")
				.execute(),
		).toEqual([{ role: 30 }]);
	});
});
