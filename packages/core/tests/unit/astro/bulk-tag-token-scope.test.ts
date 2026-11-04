import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));
vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });

import { handleApiTokenCreate } from "../../../src/api/handlers/api-tokens.js";
import { onRequest as authMiddleware } from "../../../src/astro/middleware/auth.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof authMiddleware>[0];

describe("bulk tagging token scope", () => {
	let db: Awaited<ReturnType<typeof setupTestDatabase>>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("users")
			.values({
				id: "editor-1",
				email: "editor@example.com",
				name: "Editor",
				role: Role.EDITOR,
				email_verified: 1,
			})
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function requestWithScopes(scopes: string[]) {
		const token = await handleApiTokenCreate(db, "editor-1", { name: "test", scopes });
		if (!token.success) throw new Error(token.error.message);
		const request = new Request("http://localhost/_emdash/api/taxonomies/bulk-tag", {
			method: "POST",
			headers: { Authorization: `Bearer ${token.data.token}`, "X-EmDash-Request": "1" },
		});
		const context = {
			params: {},
			request,
			url: new URL(request.url),
			locals: { emdash: { db } },
			redirect: vi.fn(),
			session: { get: vi.fn(), set: vi.fn(), destroy: vi.fn() },
		} as unknown as AuthContext;
		const next = vi.fn(async () => new Response("allowed"));
		return { response: await authMiddleware(context, next), next };
	}

	it("does not let a term-management-only token modify content", async () => {
		const { response, next } = await requestWithScopes(["taxonomies:manage"]);
		expect(response.status).toBe(403);
		expect(next).not.toHaveBeenCalled();
		expect((await response.json()) as object).toMatchObject({
			error: { code: "INSUFFICIENT_SCOPE" },
		});
	});

	it("lets a content-write token reach the route", async () => {
		const { response, next } = await requestWithScopes(["content:write"]);
		expect(response.status).toBe(200);
		expect(next).toHaveBeenCalledOnce();
	});
});
