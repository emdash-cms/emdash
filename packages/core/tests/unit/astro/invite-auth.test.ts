import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });

import { onRequest } from "../../../src/astro/middleware/auth.js";
import { GET as acceptInvite } from "../../../src/astro/routes/api/auth/invite/accept.js";
import { POST as completeInvite } from "../../../src/astro/routes/api/auth/invite/complete.js";
import { POST as createInvite } from "../../../src/astro/routes/api/auth/invite/index.js";
import { POST as registerOptions } from "../../../src/astro/routes/api/auth/invite/register-options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("invite API authentication", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await db
			.insertInto("users")
			.values([
				{ id: "admin-1", email: "admin@example.com", role: Role.ADMIN, email_verified: 1 },
				{ id: "author-1", email: "author@example.com", role: Role.AUTHOR, email_verified: 1 },
			])
			.execute();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function contextFor(path: string, userId?: string, method = "POST", csrf = true) {
		const url = new URL(path, "https://site.example.com");
		const headers = new Headers({ "Content-Type": "application/json", Origin: url.origin });
		if (csrf) headers.set("X-EmDash-Request", "1");
		return {
			url,
			request: new Request(url, {
				method,
				headers,
				...(method === "POST"
					? { body: JSON.stringify({ email: "invitee@example.com", role: Role.AUTHOR }) }
					: {}),
			}),
			locals: { emdash: { db, config: { siteUrl: url.origin } } },
			session: {
				get: vi.fn(async () => (userId ? { id: userId } : undefined)),
				set: vi.fn(),
				destroy: vi.fn(),
			},
			redirect: vi.fn(),
		};
	}

	it.each(["", "/"])("lets a signed-in admin create an invite (suffix %j)", async (suffix) => {
		const context = contextFor(`/_emdash/api/auth/invite${suffix}`, "admin-1");
		const response = await onRequest(context as never, () => createInvite(context as never));

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { inviteUrl: string } };
		expect(body.data.inviteUrl).toContain("/_emdash/admin/invite/accept?token=");
		const invites = await db.selectFrom("auth_tokens").selectAll().execute();
		expect(invites).toEqual([
			expect.objectContaining({ email: "invitee@example.com", invited_by: "admin-1" }),
		]);
	});

	it.each([
		["anonymous", undefined, 401, "NOT_AUTHENTICATED"],
		["non-admin", "author-1", 403, "FORBIDDEN"],
		["deleted user", "missing-user", 401, "NOT_FOUND"],
	])("rejects invite creation for %s callers", async (_label, userId, status, code) => {
		const context = contextFor("/_emdash/api/auth/invite/", userId);
		const response = await onRequest(context as never, () => createInvite(context as never));

		expect(response.status).toBe(status);
		expect(await response.json()).toMatchObject({ error: { code } });
		expect(await db.selectFrom("auth_tokens").selectAll().execute()).toHaveLength(0);
	});

	it("rejects disabled admins", async () => {
		await db.updateTable("users").set({ disabled: 1 }).where("id", "=", "admin-1").execute();
		const context = contextFor("/_emdash/api/auth/invite/", "admin-1");
		const response = await onRequest(context as never, () => createInvite(context as never));

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "ACCOUNT_DISABLED" } });
		expect(await db.selectFrom("auth_tokens").selectAll().execute()).toHaveLength(0);
	});

	it("requires the CSRF header for session-authenticated creation", async () => {
		const context = contextFor("/_emdash/api/auth/invite/", "admin-1", "POST", false);
		const response = await onRequest(context as never, () => createInvite(context as never));

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "CSRF_REJECTED" } });
		expect(await db.selectFrom("auth_tokens").selectAll().execute()).toHaveLength(0);
	});

	it.each(["", "/"])(
		"keeps token-based acceptance endpoints public (suffix %j)",
		async (suffix) => {
			for (const [path, method, handler, code] of [
				["accept", "GET", acceptInvite, "MISSING_PARAM"],
				["register-options", "POST", registerOptions, "VALIDATION_ERROR"],
				["complete", "POST", completeInvite, "VALIDATION_ERROR"],
			] as const) {
				const context = contextFor(
					`/_emdash/api/auth/invite/${path}${suffix}`,
					undefined,
					method,
					false,
				);
				const next = vi.fn(() => handler(context as never));
				const response = await onRequest(context as never, next);

				expect(next).toHaveBeenCalledOnce();
				expect(response.status).toBe(400);
				expect(await response.json()).toMatchObject({ error: { code } });
				expect(context.session.get).not.toHaveBeenCalled();
			}
		},
	);
});
