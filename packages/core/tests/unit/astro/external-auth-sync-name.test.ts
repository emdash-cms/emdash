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
	expect(response.status).toBe(200);
}

async function storedName(db: Kysely<Database>) {
	const row = await db
		.selectFrom("users")
		.select("name")
		.where("email", "=", "editor@example.com")
		.executeTakeFirstOrThrow();
	return row.name;
}

describe("external auth name sync", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const now = new Date().toISOString();
		await db
			.insertInto("users")
			.values({
				id: "user-1",
				email: "editor@example.com",
				name: "Edited In Admin",
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

	it("replaces the local name with the provider name by default", async () => {
		await request(db, {});

		expect(await storedName(db)).toBe("Provider Name");
	});

	it("keeps a name edited in the admin when syncName is false", async () => {
		await request(db, { syncName: false });

		expect(await storedName(db)).toBe("Edited In Admin");
	});

	it("still sets the provider name when provisioning a new user with syncName false", async () => {
		await db.deleteFrom("users").execute();

		await request(db, { syncName: false });

		expect(await storedName(db)).toBe("Provider Name");
	});
});
