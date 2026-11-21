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
		// Between Author (30) and Editor (40): not a role level EmDash defines.
		role: 35,
		subject: "access-user",
	})),
}));

vi.mock("virtual:emdash/auth", () => ({ authenticate }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });
vi.mock("../../../src/astro/session-user.js", () => ({
	resolveSessionUser: vi.fn(async () => null),
}));

let onRequest: typeof import("../../../src/astro/middleware/auth.js").onRequest;

beforeAll(async () => {
	vi.stubEnv("DEV", false);
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

afterAll(() => {
	vi.unstubAllEnvs();
});

async function request(db: Kysely<Database>, config: Record<string, unknown>) {
	const locals: Record<string, unknown> = {
		emdash: {
			db,
			config: {
				auth: {
					type: "cloudflare-access",
					entrypoint: "@emdash-cms/cloudflare/auth",
					config: { teamDomain: "example.cloudflareaccess.com", ...config },
				},
			},
			getPluginRouteMeta: vi.fn(() => ({ public: false })),
		},
	};
	const url = new URL("/_emdash/api/plugins/example/config", "https://example.com");
	const context = {
		request: new Request(url, { headers: { "Cf-Access-Jwt-Assertion": "access-jwt" } }),
		url,
		locals,
		session: { get: vi.fn(async () => null), set: vi.fn() },
		redirect: vi.fn(),
	};
	const response = await onRequest(context as never, async () => new Response("ok"));
	return { response, locals };
}

async function insertUser(db: Kysely<Database>, id: string, email: string, role: number) {
	const now = new Date().toISOString();
	await db
		.insertInto("users")
		.values({ id, email, name: null, role, email_verified: 1, created_at: now, updated_at: now })
		.execute();
}

describe("external auth provider role", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("does not provision a user with a role level EmDash does not recognize", async () => {
		await insertUser(db, "admin-1", "admin@example.com", 50);

		const { response, locals } = await request(db, {});

		expect(response.status).toBe(503);
		expect(locals.user).toBeUndefined();
		const row = await db
			.selectFrom("users")
			.select("id")
			.where("email", "=", "editor@example.com")
			.executeTakeFirst();
		expect(row).toBeUndefined();
	});

	it("does not sync a role level EmDash does not recognize", async () => {
		await insertUser(db, "user-1", "editor@example.com", 30);

		const { response, locals } = await request(db, { syncRoles: true });

		expect(response.status).toBe(503);
		expect(locals.user).toBeUndefined();
		const row = await db
			.selectFrom("users")
			.select("role")
			.where("email", "=", "editor@example.com")
			.executeTakeFirstOrThrow();
		expect(row.role).toBe(30);
	});
});
