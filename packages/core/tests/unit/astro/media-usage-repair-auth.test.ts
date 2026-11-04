import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock(
	"virtual:emdash/auth",
	() => ({
		authenticate: vi.fn(),
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {},
	}),
	{ virtual: true },
);

import { handleApiTokenCreate } from "../../../src/api/handlers/api-tokens.js";
import { onRequest as authMiddleware } from "../../../src/astro/middleware/auth.js";
import { POST } from "../../../src/astro/routes/api/admin/media-usage/repair.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof authMiddleware>[0];

interface ApiErrorBody {
	error: {
		code: string;
		message: string;
	};
}

describe("media usage repair auth middleware", () => {
	let db: Kysely<Database> | undefined;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values([
				{
					id: "admin-1",
					email: "admin@example.com",
					name: "Admin",
					role: Role.ADMIN,
					email_verified: 1,
				},
				{
					id: "editor-1",
					email: "editor@example.com",
					name: "Editor",
					role: Role.EDITOR,
					email_verified: 1,
				},
			])
			.execute();
	});

	afterEach(async () => {
		if (db) await teardownTestDatabase(db);
		db = undefined;
	});

	it("allows an admin-scoped token for an admin user to reach the repair route", async () => {
		const token = await createToken("admin-1", ["admin"]);
		const response = await invokeRepairThroughAuth(token);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { status: string } };
		expect(body.data.status).toBe("complete");
	});

	it("rejects non-admin tokens at the admin API prefix before the route runs", async () => {
		const token = await createToken("admin-1", ["media:write"]);
		const context = repairContext(token);
		const next = vi.fn(async () => new Response("should not run"));

		const response = await authMiddleware(context, next);

		expect(next).not.toHaveBeenCalled();
		await expectError(response, 403, "INSUFFICIENT_SCOPE");
	});

	it("rejects an admin-scoped token when its user lacks schema:manage", async () => {
		const token = await createToken("editor-1", ["admin"]);
		const response = await invokeRepairThroughAuth(token);

		await expectError(response, 403, "FORBIDDEN");
	});

	async function createToken(userId: string, scopes: string[]): Promise<string> {
		const result = await handleApiTokenCreate(db!, userId, {
			name: `${userId} token`,
			scopes,
		});
		if (!result.success) {
			throw new Error(`Failed to create token: ${result.error.message}`);
		}
		return result.data.token;
	}

	async function invokeRepairThroughAuth(token: string): Promise<Response> {
		const context = repairContext(token);
		return authMiddleware(context, () => POST(context as never));
	}

	function repairContext(token: string): AuthContext {
		const request = new Request("http://localhost/_emdash/api/admin/media-usage/repair", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ scope: "collection", collection: "post" }),
		});

		return {
			request,
			url: new URL(request.url),
			locals: {
				emdash: { db: db! },
			},
			redirect: vi.fn(),
			session: {
				get: vi.fn(),
				set: vi.fn(),
				destroy: vi.fn(),
			},
		} as unknown as AuthContext;
	}
});

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	const body = (await response.json()) as ApiErrorBody;
	expect(body.error.code).toBe(code);
}
