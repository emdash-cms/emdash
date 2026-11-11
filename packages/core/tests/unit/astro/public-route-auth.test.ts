import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/auth", () => ({ authenticate: vi.fn() }));

const config = vi.hoisted(() => ({ sessionCookieName: undefined as string | undefined }));
vi.mock("virtual:emdash/config", () => ({ default: config }));

import { onRequest } from "../../../src/astro/middleware/auth.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type AuthContext = Parameters<typeof onRequest>[0];

function createContext(
	get: () => Promise<{ id: string } | undefined>,
	db?: Kysely<Database>,
	cookie: string | false = false,
) {
	const request = new Request("https://example.com/posts/hello", {
		headers: cookie ? { Cookie: `${cookie}=session-id` } : {},
	});
	return {
		request,
		url: new URL(request.url),
		cookies: {
			get: (name: string) => (name === cookie ? { value: "session-id" } : undefined),
		},
		locals: { emdash: { db, config: {} } },
		session: { get },
	} as unknown as AuthContext;
}

describe("public page soft auth", () => {
	afterEach(() => {
		config.sessionCookieName = undefined;
	});
	it.each([undefined, "site-session"])(
		"renders cookie-free requests without reading the session store (%s)",
		async (cookieName) => {
			config.sessionCookieName = cookieName;
			const get = vi.fn(async () => undefined);
			const context = createContext(get);
			const next = vi.fn(async () => new Response("public page"));

			const response = await onRequest(context, next);

			expect(await response.text()).toBe("public page");
			expect(next).toHaveBeenCalledOnce();
			expect(context.locals.user).toBeUndefined();
			expect(get).not.toHaveBeenCalled();
		},
	);

	it("still renders when a cookie-bearing session store rejects", async () => {
		const get = vi.fn(async () => {
			throw new Error("Session store unavailable");
		});
		const context = createContext(get, undefined, "astro-session");
		const next = vi.fn(async () => new Response("public page"));

		const response = await onRequest(context, next);

		expect(await response.text()).toBe("public page");
		expect(next).toHaveBeenCalledOnce();
		expect(context.locals.user).toBeUndefined();
		expect(get).toHaveBeenCalledOnce();
	});

	describe("cookie-bearing user lookup", () => {
		let db: Kysely<Database>;

		beforeEach(async () => {
			db = await setupTestDatabase();
			await db
				.insertInto("users")
				.values({
					id: "user-1",
					email: "editor@example.com",
					role: Role.EDITOR,
					email_verified: 1,
				})
				.execute();
		});

		afterEach(async () => {
			await teardownTestDatabase(db);
		});

		it.each(["/posts/hello", "/_emdash/api/search", "/_emdash/api/comments/posts/post-1"])(
			"preserves identity with a custom session cookie on %s",
			async (pathname) => {
				config.sessionCookieName = "site-session";
				const get = vi.fn(async () => ({ id: "user-1" }));
				const context = createContext(get, db, "site-session");
				context.url = new URL(pathname, "https://example.com");
				context.request = new Request(context.url, {
					method: pathname.includes("comments") ? "POST" : "GET",
					headers: { Origin: context.url.origin },
				});
				const response = await onRequest(
					context,
					async () => new Response(context.locals.user?.id ?? "anonymous"),
				);
				expect(await response.text()).toBe("user-1");
			},
		);

		it.each([
			["active user", "user-1", false, true],
			["disabled user", "user-1", true, false],
			["deleted user", "missing-user", false, false],
			["expired session", undefined, false, false],
		] as const)(
			"renders with the expected identity for %s",
			async (_label, id, disabled, authenticated) => {
				if (disabled) await db.updateTable("users").set({ disabled: 1 }).execute();
				const get = vi.fn(async () => (id ? { id } : undefined));
				const context = createContext(get, db, "astro-session");
				const next = vi.fn(async () => new Response(context.locals.user?.id ?? "anonymous"));

				const response = await onRequest(context, next);

				expect(await response.text()).toBe(authenticated ? "user-1" : "anonymous");
				expect(next).toHaveBeenCalledOnce();
				expect(get).toHaveBeenCalledOnce();
			},
		);
	});
});
