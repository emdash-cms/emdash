import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { withTransaction } from "../../src/database/transaction.js";
import type { Database } from "../../src/database/types.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import { setRoomNotifier } from "../../src/rooms/notifications.js";
import { roomId } from "../../src/rooms/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
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
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "post", label: "Posts" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });
});

afterEach(() => {
	setRoomNotifier(null);
});

afterAll(async () => {
	await db.destroy();
});

it("notifies rooms once the last statement of a bare withTransaction has run", async () => {
	const repo = new ContentRepository(db);
	const a = await repo.create({ type: "post", data: { title: "A" }, slug: "a" });
	const b = await repo.create({ type: "post", data: { title: "B" }, slug: "b" });
	const calls: { roomId: string; afterLastStatement: boolean }[] = [];
	let lastStatementRan = false;
	setRoomNotifier({
		notify: async (id) => {
			calls.push({ roomId: id, afterLastStatement: lastStatementRan });
		},
	});

	await withTransaction(db, async (trx) => {
		expect(trx.isTransaction).toBe(false);
		const inner = new ContentRepository(trx);
		await inner.update("post", a.id, { data: { title: "A1" } });
		await withTransaction(trx, async (nested) => {
			await new ContentRepository(nested).update("post", b.id, { data: { title: "B1" } });
		});
		await inner.update("post", a.id, { data: { title: "A2" } });
		lastStatementRan = true;
	});
	await waitForDeferredTasks();

	expect(calls).toEqual([
		{ roomId: roomId({ collection: "post", id: a.id }), afterLastStatement: true },
		{ roomId: roomId({ collection: "post", id: b.id }), afterLastStatement: true },
	]);
});
