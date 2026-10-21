import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import {
	handleMenuCreate,
	handleMenuItemCreate,
	handleMenuItemDelete,
} from "../../src/api/handlers/menus.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
});

afterAll(async () => {
	await db.destroy();
});

describe("menu item deletion on D1", () => {
	it("deletes the descendants of a deleted menu item", async () => {
		await handleMenuCreate(db, { name: "primary", label: "Primary" });
		const create = async (label: string, parentId?: string) => {
			const result = await handleMenuItemCreate(db, "primary", {
				type: "custom",
				label,
				customUrl: `/${label}`,
				parentId,
				sortOrder: 0,
			});
			if (!result.success) throw new Error(result.error.message);
			return result.data.id;
		};
		const parent = await create("parent");
		const child = await create("child", parent);
		await create("grandchild", child);
		const other = await create("other");

		expect((await handleMenuItemDelete(db, "primary", parent)).success).toBe(true);

		const rows = await db.selectFrom("_emdash_menu_items").select("id").execute();
		expect(rows.map((row) => row.id)).toEqual([other]);
	});
});
