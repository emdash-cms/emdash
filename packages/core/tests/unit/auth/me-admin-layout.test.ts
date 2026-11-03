import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/auth/me.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface LocalsUser {
	id: string;
	email: string;
	name: string | null;
	role: number;
	data?: Record<string, unknown> | null;
}

const layout = {
	version: 1,
	nav: { order: ["/content/posts", "/media"], hidden: ["/comments"] },
	editor: { order: ["seo", "publish"], hidden: ["revisions"] },
};

const otherLayout = {
	version: 1,
	nav: { order: ["/media"], hidden: [] },
	editor: { order: [], hidden: ["seo"] },
};

function ids(count: number, prefix = "/p/"): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

function post(db: Kysely<Database>, user: LocalsUser, body: unknown): Promise<Response> {
	return POST({
		request: new Request("http://localhost/_emdash/api/auth/me", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { emdash: { db }, user },
	} as unknown as Parameters<typeof POST>[0]);
}

function get(
	db: Kysely<Database>,
	user: LocalsUser,
	options: { playground?: boolean } = {},
): Promise<Response> {
	return GET({
		locals: {
			emdash: { db },
			user,
			...(options.playground ? { __playgroundDb: db } : {}),
		},
	} as unknown as Parameters<typeof GET>[0]);
}

async function storedData(db: Kysely<Database>, id: string): Promise<unknown> {
	const row = await db
		.selectFrom("users")
		.select("data")
		.where("id", "=", id)
		.executeTakeFirstOrThrow();
	return row.data === null ? null : JSON.parse(row.data);
}

async function writeData(db: Kysely<Database>, id: string, data: string | null): Promise<void> {
	await db.updateTable("users").set({ data }).where("id", "=", id).execute();
}

function playgroundUser(user: LocalsUser): LocalsUser {
	return { id: user.id, email: user.email, name: user.name, role: user.role };
}

describeEachDialect("/_emdash/api/auth/me admin layout", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let users: UserRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		users = new UserRepository(db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createUser(data?: Record<string, unknown>): Promise<LocalsUser> {
		return users.create({ email: "ada@example.com", name: "Ada", role: "admin", data });
	}

	async function reread(id: string): Promise<LocalsUser> {
		const user = await users.findById(id);
		if (!user) throw new Error("user missing");
		return user;
	}

	it("round-trips a saved layout", async () => {
		const user = await createUser();

		const saved = await post(db, user, { action: "setAdminLayout", adminLayout: layout });
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({ success: true, data: { adminLayout: layout } });

		const res = await get(db, await reread(user.id));
		expect(res.status).toBe(200);
		expect((await res.json()).data.adminLayout).toEqual(layout);
	});

	it("returns null for a user without a layout", async () => {
		const user = await createUser();
		const res = await get(db, user);
		expect((await res.json()).data.adminLayout).toBeNull();
	});

	it("removes the stored key when the layout is null", async () => {
		const user = await createUser({ welcomeDismissed: true, adminLayout: layout });

		const res = await post(db, user, { action: "setAdminLayout", adminLayout: null });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, data: { adminLayout: null } });
		expect(await storedData(db, user.id)).toEqual({ welcomeDismissed: true });

		const after = await get(db, await reread(user.id));
		expect((await after.json()).data.adminLayout).toBeNull();
	});

	it("keeps other keys when locals.user has no data, as in playground", async () => {
		const user = await createUser({ welcomeDismissed: true, theme: "dark" });

		await post(db, playgroundUser(user), { action: "setAdminLayout", adminLayout: layout });
		expect(await storedData(db, user.id)).toEqual({
			welcomeDismissed: true,
			theme: "dark",
			adminLayout: layout,
		});

		await writeData(db, user.id, JSON.stringify({ adminLayout: layout, theme: "dark" }));
		await post(db, playgroundUser(user), { action: "dismissWelcome" });
		expect(await storedData(db, user.id)).toEqual({
			adminLayout: layout,
			theme: "dark",
			welcomeDismissed: true,
		});

		const res = await get(db, playgroundUser(user), { playground: true });
		const body = await res.json();
		expect(body.data.adminLayout).toEqual(layout);
		expect(body.data.isFirstLogin).toBe(false);
	});

	it("keeps other keys when locals.user is stale", async () => {
		const stale = await createUser({ theme: "dark" });
		await writeData(
			db,
			stale.id,
			JSON.stringify({ theme: "dark", welcomeDismissed: true, adminLayout: otherLayout }),
		);

		await post(db, stale, { action: "setAdminLayout", adminLayout: layout });
		expect(await storedData(db, stale.id)).toEqual({
			theme: "dark",
			welcomeDismissed: true,
			adminLayout: layout,
		});

		await writeData(db, stale.id, JSON.stringify({ theme: "dark", adminLayout: layout }));
		await post(db, stale, { action: "dismissWelcome" });
		expect(await storedData(db, stale.id)).toEqual({
			theme: "dark",
			adminLayout: layout,
			welcomeDismissed: true,
		});
	});

	it("saves for a user whose data column is NULL", async () => {
		const user = await createUser();
		expect(await storedData(db, user.id)).toBeNull();

		const res = await post(db, user, { action: "setAdminLayout", adminLayout: layout });
		expect(res.status).toBe(200);
		expect(await storedData(db, user.id)).toEqual({ adminLayout: layout });
	});

	it("saves over a data column holding a non-object", async () => {
		const user = await createUser();
		await writeData(db, user.id, "[1,2]");

		const res = await post(db, user, { action: "setAdminLayout", adminLayout: layout });
		expect(res.status).toBe(200);
		expect(await storedData(db, user.id)).toEqual({ adminLayout: layout });
	});

	it("accepts 200 IDs per list", async () => {
		const user = await createUser();
		const full = {
			version: 1,
			nav: { order: ids(200), hidden: ids(200) },
			editor: { order: ids(200, "s"), hidden: ids(200, "s") },
		};

		const res = await post(db, user, { action: "setAdminLayout", adminLayout: full });
		expect(res.status).toBe(200);
		expect(await storedData(db, user.id)).toEqual({ adminLayout: full });
	});

	const longId = "x".repeat(100);
	const invalidBodies: Array<[string, unknown]> = [
		["version 2", { action: "setAdminLayout", adminLayout: { ...layout, version: 2 } }],
		["missing editor", { action: "setAdminLayout", adminLayout: { version: 1, nav: layout.nav } }],
		[
			"an extra top-level layout key",
			{ action: "setAdminLayout", adminLayout: { ...layout, extra: true } },
		],
		[
			"an extra list key",
			{
				action: "setAdminLayout",
				adminLayout: { ...layout, nav: { ...layout.nav, pinned: [] } },
			},
		],
		[
			"an extra body key",
			{ action: "setAdminLayout", adminLayout: layout, userId: "someone-else" },
		],
		[
			"an empty-string ID",
			{
				action: "setAdminLayout",
				adminLayout: { ...layout, editor: { order: [""], hidden: [] } },
			},
		],
		[
			"an ID containing U+0000",
			{
				action: "setAdminLayout",
				adminLayout: { ...layout, nav: { order: ["/media\u0000"], hidden: [] } },
			},
		],
		[
			"an ID containing a lone UTF-16 surrogate",
			{
				action: "setAdminLayout",
				adminLayout: { ...layout, nav: { order: ["/media\ud800"], hidden: [] } },
			},
		],
		[
			"a numeric ID",
			{
				action: "setAdminLayout",
				adminLayout: { ...layout, nav: { order: [1], hidden: [] } },
			},
		],
		[
			"201 IDs",
			{
				action: "setAdminLayout",
				adminLayout: { ...layout, nav: { order: ids(201), hidden: [] } },
			},
		],
		[
			"over 16 KB with under 200 IDs per list",
			{
				action: "setAdminLayout",
				adminLayout: {
					version: 1,
					nav: { order: ids(90, longId), hidden: ids(90, longId) },
					editor: { order: ids(90, longId), hidden: [] },
				},
			},
		],
		["a missing adminLayout", { action: "setAdminLayout" }],
	];

	for (const [name, body] of invalidBodies) {
		it(`rejects ${name} and writes nothing`, async () => {
			const user = await createUser({ welcomeDismissed: true, adminLayout: otherLayout });

			const res = await post(db, user, body);
			expect(res.status).toBe(400);
			expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
			expect(await storedData(db, user.id)).toEqual({
				welcomeDismissed: true,
				adminLayout: otherLayout,
			});
		});
	}

	it("answers UNKNOWN_ACTION for an unknown action", async () => {
		const user = await createUser();
		const res = await post(db, user, { action: "nope" });
		expect(res.status).toBe(400);
		expect((await res.json()).error.code).toBe("UNKNOWN_ACTION");
	});

	it("keeps the dismissWelcome response", async () => {
		const user = await createUser();
		const res = await post(db, user, { action: "dismissWelcome" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ success: true, data: { success: true } });
		expect(await storedData(db, user.id)).toEqual({ welcomeDismissed: true });
	});

	it("serves an invalid stored layout as null and keeps the other fields", async () => {
		const user = await createUser();
		await writeData(
			db,
			user.id,
			JSON.stringify({ welcomeDismissed: true, adminLayout: { ...layout, version: 2 } }),
		);

		const res = await get(db, await reread(user.id));
		expect(res.status).toBe(200);
		expect((await res.json()).data).toEqual({
			id: user.id,
			email: "ada@example.com",
			name: "Ada",
			role: 50,
			avatarUrl: null,
			isFirstLogin: false,
			adminLayout: null,
		});
	});
});

describe("/_emdash/api/auth/me statement counts [sqlite]", () => {
	let db: Kysely<Database>;
	const queries: string[] = [];

	beforeEach(async () => {
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
			log: (event) => {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});
		await runMigrations(db);
		queries.length = 0;
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function createUser(): Promise<LocalsUser> {
		const user = await new UserRepository(db).create({
			email: "ada@example.com",
			name: "Ada",
			role: "admin",
			data: { theme: "dark" },
		});
		queries.length = 0;
		return user;
	}

	it("saves a layout in one statement", async () => {
		const user = await createUser();
		await post(db, user, { action: "setAdminLayout", adminLayout: layout });
		expect(queries).toHaveLength(1);
	});

	it("clears a layout in one statement", async () => {
		const user = await createUser();
		await post(db, user, { action: "setAdminLayout", adminLayout: null });
		expect(queries).toHaveLength(1);
	});

	it("dismisses the welcome in one statement", async () => {
		const user = await createUser();
		await post(db, user, { action: "dismissWelcome" });
		expect(queries).toHaveLength(1);
	});

	it("reads the layout without a query outside playground", async () => {
		const user = await createUser();
		await get(db, user);
		expect(queries).toHaveLength(0);

		await get(db, playgroundUser(user), { playground: true });
		expect(queries).toHaveLength(1);
	});
});
