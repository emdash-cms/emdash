import type { APIContext, AstroCookies } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/auth/dev-bypass.js";
import { POST as postAdmin } from "../../../src/astro/routes/api/setup/admin.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface CookieRecord {
	value: string;
	options: Record<string, unknown>;
}

function createCookieJar(): { cookies: AstroCookies } {
	const jar = new Map<string, CookieRecord>();
	const cookies = {
		get(name: string) {
			const record = jar.get(name);
			return record ? { value: record.value } : undefined;
		},
		set(name: string, value: string, options: Record<string, unknown> = {}) {
			jar.set(name, { value, options });
		},
		delete(name: string) {
			jar.delete(name);
		},
		has(name: string) {
			return jar.has(name);
		},
	} as unknown as AstroCookies;

	return { cookies };
}

function buildContext(
	db: Kysely<Database>,
	method: "GET" | "POST",
	session: { set: ReturnType<typeof vi.fn> },
): APIContext {
	const request = new Request("http://localhost/_emdash/api/auth/dev-bypass", { method });
	const { cookies } = createCookieJar();
	return {
		params: {},
		url: new URL(request.url),
		request,
		cookies,
		session: session as APIContext["session"],
		locals: { emdash: { db, config: {}, storage: undefined } },
	} as unknown as APIContext;
}

function buildAdminContext(db: Kysely<Database>): APIContext {
	const request = new Request("http://localhost/_emdash/api/setup/admin", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email: "new@admin.example", name: "New Admin" }),
	});
	const { cookies } = createCookieJar();
	return {
		params: {},
		url: new URL(request.url),
		request,
		cookies,
		session: undefined,
		locals: { emdash: { db, config: {}, storage: undefined } },
	} as unknown as APIContext;
}

async function insertUser(
	db: Kysely<Database>,
	user: { id: string; email: string; name?: string } = {
		id: "existing-admin",
		email: "existing@admin.example",
		name: "Existing Admin",
	},
): Promise<void> {
	await db
		.insertInto("users")
		.values({
			id: user.id,
			email: user.email,
			name: user.name ?? "Existing Admin",
			role: 50,
			email_verified: 1,
		})
		.execute();
}

async function countUsers(db: Kysely<Database>): Promise<number> {
	return (await db.selectFrom("users").select("id").execute()).length;
}

async function errorCode(response: Response): Promise<string | undefined> {
	const body = (await response.json()) as { error?: { code?: string } };
	return body.error?.code;
}

describeEachDialect("auth dev-bypass setup gating", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.unstubAllEnvs();
	});

	it.each(["GET", "POST"] as const)(
		"rejects %s before setup when setup_complete is missing",
		async (method) => {
			const session = { set: vi.fn() };
			const response = await { GET, POST }[method](buildContext(ctx.db, method, session));

			expect(response.status).toBe(409);
			expect(await errorCode(response)).toBe("SETUP_REQUIRED");
			expect(await countUsers(ctx.db)).toBe(0);
			expect(session.set).not.toHaveBeenCalled();
		},
	);

	it.each([
		["GET", false],
		["POST", false],
		["GET", true],
		["POST", true],
		["GET", "true"],
		["POST", "true"],
	] as const)("rejects %s with setup_complete=%s when there are no users", async (method, flag) => {
		const options = new OptionsRepository(ctx.db);
		await options.set("emdash:setup_complete", flag);

		const session = { set: vi.fn() };
		const response = await { GET, POST }[method](buildContext(ctx.db, method, session));

		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("SETUP_REQUIRED");
		expect(await countUsers(ctx.db)).toBe(0);
		expect(session.set).not.toHaveBeenCalled();
	});

	it("leaves the real setup admin step available after a rejected bypass", async () => {
		const session = { set: vi.fn() };
		const response = await GET(buildContext(ctx.db, "GET", session));

		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("SETUP_REQUIRED");
		expect((await postAdmin(buildAdminContext(ctx.db))).status).toBe(200);
		expect(await countUsers(ctx.db)).toBe(0);
	});

	it.each([true, "true"] as const)(
		"allows setup_complete=%s to bypass when a user exists",
		async (flag) => {
			await new OptionsRepository(ctx.db).set("emdash:setup_complete", flag);
			await insertUser(ctx.db);

			const session = { set: vi.fn() };
			const response = await POST(buildContext(ctx.db, "POST", session));

			expect(response.status).toBe(200);
			expect(session.set).toHaveBeenCalledWith("user", expect.anything());
			expect(await countUsers(ctx.db)).toBe(2);
		},
	);

	it.each([false, true])("respects setup_complete=%s with external auth", async (complete) => {
		await new OptionsRepository(ctx.db).set("emdash:setup_complete", complete);
		const session = { set: vi.fn() };
		const context = buildContext(ctx.db, "POST", session);
		context.locals.emdash!.config.auth = {
			type: "cloudflare-access",
			entrypoint: "@emdash-cms/cloudflare/auth",
			config: {},
		};

		const response = await POST(context);

		expect(response.status).toBe(complete ? 200 : 409);
		expect(await countUsers(ctx.db)).toBe(complete ? 1 : 0);
		if (complete) {
			expect(session.set).toHaveBeenCalledWith("user", expect.anything());
		} else {
			expect(session.set).not.toHaveBeenCalled();
		}
	});

	it("reuses the existing dev user on repeated bypasses", async () => {
		await new OptionsRepository(ctx.db).set("emdash:setup_complete", true);
		await insertUser(ctx.db);

		const firstSession = { set: vi.fn() };
		const secondSession = { set: vi.fn() };
		await GET(buildContext(ctx.db, "GET", firstSession));
		await GET(buildContext(ctx.db, "GET", secondSession));

		expect(firstSession.set).toHaveBeenCalledWith("user", expect.anything());
		expect(secondSession.set).toHaveBeenCalledWith("user", expect.anything());
		expect(await countUsers(ctx.db)).toBe(2);
		const devUsers = await ctx.db
			.selectFrom("users")
			.select(["id", "email"])
			.where("email", "=", "dev@emdash.local")
			.execute();
		expect(devUsers).toHaveLength(1);
		expect(firstSession.set.mock.calls[0]?.[1]).toEqual(secondSession.set.mock.calls[0]?.[1]);
	});

	it("rejects an existing dev user while setup is incomplete", async () => {
		await new OptionsRepository(ctx.db).set("emdash:setup_complete", false);
		await insertUser(ctx.db, { id: "dev-user", email: "dev@emdash.local", name: "Dev Admin" });

		const session = { set: vi.fn() };
		const response = await POST(buildContext(ctx.db, "POST", session));

		expect(response.status).toBe(409);
		expect(await errorCode(response)).toBe("SETUP_REQUIRED");
		expect(await countUsers(ctx.db)).toBe(1);
		expect(session.set).not.toHaveBeenCalled();
	});

	it("returns 403 in production even when setup is complete", async () => {
		await new OptionsRepository(ctx.db).set("emdash:setup_complete", true);
		await insertUser(ctx.db);
		vi.stubEnv("DEV", false);

		const session = { set: vi.fn() };
		const response = await GET(buildContext(ctx.db, "GET", session));

		expect(response.status).toBe(403);
		expect(await errorCode(response)).toBe("FORBIDDEN");
		expect(session.set).not.toHaveBeenCalled();
	});
});
