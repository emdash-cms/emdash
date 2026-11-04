import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "../../../src/database/types.js";
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
	db = await setupTestDatabase();
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await teardownTestDatabase(db);
});

function visitAdminApi(
	authConfig: Record<string, unknown> = {},
	next = vi.fn(async () => new Response("ok")),
) {
	const url = new URL("/_emdash/api/content/posts", "https://site.example.com");
	return onRequest(
		{
			url,
			request: new Request(url),
			locals: {
				emdash: {
					db,
					config: {
						auth: { type: "cloudflare-access", entrypoint: "test-auth", config: authConfig },
					},
				},
			},
			session: { get: vi.fn(), set: vi.fn(), destroy: vi.fn() },
		} as unknown as Parameters<AuthMiddlewareModule["onRequest"]>[0],
		next,
	);
}

const validIdentity = { email: "editor@example.com", name: "Editor", role: 40 };

describe("external auth error classification", () => {
	it("returns 401 when the provider rejects the identity", async () => {
		authenticate.mockRejectedValue(new Error("Invalid JWT"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await visitAdminApi();

		expect(response.status).toBe(401);
	});

	it("returns 403 for a valid identity without a local account when provisioning is off", async () => {
		authenticate.mockResolvedValue(validIdentity);

		const response = await visitAdminApi({ autoProvision: false });

		expect(response.status).toBe(403);
	});

	it("returns a generic, uncached 503 when the users table is unusable after a valid identity", async () => {
		authenticate.mockResolvedValue(validIdentity);
		await sql`DROP TABLE users`.execute(db);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const next = vi.fn(async () => new Response("ok"));

		const response = await visitAdminApi({}, next);

		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(503);
		expect(response.headers.get("Cache-Control")).toContain("no-store");
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(await response.text()).not.toMatch(/users|table|sql/i);
	});
});
