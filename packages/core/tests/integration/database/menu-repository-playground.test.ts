import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { Kysely } from "kysely";
import { expect, it, vi } from "vitest";

import { EmDashPreviewDB } from "../../../../cloudflare/src/db/do-class.js";
import { PreviewDODialect } from "../../../../cloudflare/src/db/do-dialect.js";
import { MenuRepository } from "../../../src/database/repositories/menu.js";
import type { Database } from "../../../src/database/types.js";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;

		constructor(ctx: unknown) {
			this.ctx = ctx;
		}
	},
}));

/** The playground Durable Object's `ctx.storage.sql`, backed by node:sqlite. */
function storageSql(sqlite: DatabaseSync) {
	return {
		exec(query: string, ...params: SQLInputValue[]) {
			const statement = sqlite.prepare(query);
			let rows: Record<string, unknown>[] = [];
			if (statement.columns().length > 0) rows = statement.all(...params);
			else statement.run(...params);
			return { one: () => rows[0], [Symbol.iterator]: () => rows.values() };
		},
	};
}

it("deletes a menu item and its nested items on the playground database", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE _emdash_menu_items (id TEXT PRIMARY KEY, menu_id TEXT NOT NULL, parent_id TEXT);
		INSERT INTO _emdash_menu_items VALUES
			('parent', 'menu', NULL), ('child', 'menu', 'parent'), ('other', 'menu', NULL);
	`);
	const playground = new EmDashPreviewDB({ storage: { sql: storageSql(sqlite) } } as never, {});
	const db = new Kysely<Database>({
		dialect: new PreviewDODialect({
			getStub: () => ({ query: async (sql, params) => playground.query(sql, params) }),
		}),
	});

	expect(await new MenuRepository(db).deleteItem("menu", "parent")).toBe(true);
	expect(sqlite.prepare("SELECT id FROM _emdash_menu_items").all()).toEqual([{ id: "other" }]);
});
