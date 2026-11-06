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
import { POST as cancelPost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/cancel.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof authMiddleware>[0];

describe("transfer routes behind the auth middleware", () => {
	let db: Kysely<Database> | undefined;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values({
				id: "admin-1",
				email: "admin@example.com",
				name: "Admin",
				role: Role.ADMIN,
				email_verified: 1,
			})
			.execute();
	});

	afterEach(async () => {
		if (db) await teardownTestDatabase(db);
		db = undefined;
	});

	async function createToken(scopes: string[]): Promise<string> {
		const result = await handleApiTokenCreate(db!, "admin-1", { name: "token", scopes });
		if (!result.success) throw new Error(result.error.message);
		return result.data.token;
	}

	function context(path: string, headers: Record<string, string>): AuthContext {
		const request = new Request(`http://localhost/_emdash/api/admin/transfer/${path}`, {
			method: "POST",
			headers,
		});
		return {
			request,
			url: new URL(request.url),
			params: { id: "01HZ0000000000000000000000" },
			locals: { emdash: { db: db! } },
			redirect: vi.fn(),
			session: { get: vi.fn(), set: vi.fn(), destroy: vi.fn() },
		} as unknown as AuthContext;
	}

	it("rejects a cookie-session state change without the CSRF header", async () => {
		const next = vi.fn(async () => new Response("should not run"));
		const response = await authMiddleware(
			context("imports/01HZ0000000000000000000000/cancel", {}),
			next,
		);
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"CSRF_REJECTED",
		);
	});

	it("lets an admin token through the middleware and into an execute route", async () => {
		const token = await createToken(["admin"]);
		const ctx = context("imports/01HZ0000000000000000000000/cancel", {
			Authorization: `Bearer ${token}`,
		});
		const response = await authMiddleware(ctx, () => cancelPost(ctx as never));
		expect(response.status).toBe(404);
	});

	it("refuses a token without admin or a transfer scope before the route runs", async () => {
		const token = await createToken(["content:write", "settings:manage"]);
		const next = vi.fn(async () => new Response("should not run"));
		const response = await authMiddleware(
			context("imports", { Authorization: `Bearer ${token}` }),
			next,
		);
		expect(next).not.toHaveBeenCalled();
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"INSUFFICIENT_SCOPE",
		);
	});

	it("lets an analyze token through the middleware but not into an execute route", async () => {
		const token = await createToken(["transfer:analyze"]);
		const ctx = context("imports/01HZ0000000000000000000000/cancel", {
			Authorization: `Bearer ${token}`,
		});
		const response = await authMiddleware(ctx, () => cancelPost(ctx as never));
		expect(response.status).toBe(403);
		expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
			"INSUFFICIENT_SCOPE",
		);

		const executeToken = await createToken(["transfer:execute"]);
		const allowed = context("imports/01HZ0000000000000000000000/cancel", {
			Authorization: `Bearer ${executeToken}`,
		});
		const notFound = await authMiddleware(allowed, () => cancelPost(allowed as never));
		expect(notFound.status).toBe(404);
	});
});
