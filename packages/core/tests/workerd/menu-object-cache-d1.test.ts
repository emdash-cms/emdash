import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { getMenu } from "../../src/menus/index.js";
import { __setObjectCacheBackendForTests } from "../../src/object-cache/index.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;
let queryCount = 0;

beforeAll(async () => {
	db = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
		log(event) {
			if (event.level === "query") queryCount++;
		},
	});
	await resetD1Schema(db);
	await runMigrations(db);

	await new SchemaRegistry(db).createCollection({
		slug: "post",
		label: "Posts",
		labelSingular: "Post",
	});
	await db
		.insertInto("ec_post" as never)
		.values({
			id: "post-hello",
			slug: "hello",
			status: "published",
			locale: "en",
			translation_group: "post-hello",
		} as never)
		.execute();
	await db
		.insertInto("_emdash_menus")
		.values({ id: "menu-cold", name: "cold", label: "Cold" })
		.execute();
	await db
		.insertInto("_emdash_menu_items")
		.values({
			id: "item-hello",
			menu_id: "menu-cold",
			sort_order: 0,
			type: "post",
			reference_collection: "post",
			reference_id: "post-hello",
			label: "Hello",
		})
		.execute();
});

afterAll(async () => {
	__setObjectCacheBackendForTests(null);
	await db.destroy();
});

it("runs no extra D1 query for a cold cached menu while the cache writes are in flight", async () => {
	const render = () => runWithContext({ db, editMode: false }, () => getMenu("cold"));

	__setObjectCacheBackendForTests(null);
	queryCount = 0;
	const uncached = await render();
	const uncachedQueries = queryCount;
	expect(uncached?.items.map((item) => item.label)).toEqual(["Hello"]);

	// Like KV under waitUntil: a write lands after the request that made it.
	const store = new Map<string, string>();
	const inFlight = new Map<string, string>();
	__setObjectCacheBackendForTests({
		get: async (key) => store.get(key) ?? null,
		set: async (key, value) => {
			inFlight.set(key, value);
		},
		delete: async (key) => {
			store.delete(key);
			inFlight.delete(key);
		},
	});

	queryCount = 0;
	expect(await render()).toEqual(uncached);
	expect(queryCount).toBe(uncachedQueries);

	for (const [key, value] of inFlight) store.set(key, value);
	queryCount = 0;
	expect(await render()).toEqual(uncached);
	expect(queryCount).toBe(0);
});
