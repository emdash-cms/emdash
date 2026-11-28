import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import {
	EditorialThreadRepository,
	type EditorialAnchor,
} from "../../src/database/repositories/editorial-threads.js";
import { ContentMutationConflictError } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const ANCHOR: EditorialAnchor = {
	type: "text",
	field: "content",
	blockKey: "b1",
	start: 4,
	end: 9,
	quote: "quick",
};

const ANCHOR_WRITE = /^update "_emdash_editorial_threads" set "anchor"/i;

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

afterAll(async () => {
	await db.destroy();
});

/**
 * Runs `save` just before the second anchor write reaches D1, whether the
 * writes arrive one statement at a time or together in a batch.
 */
function saveBeforeSecondAnchorWrite(database: D1Database, save: () => Promise<void>): D1Database {
	const anchorWrites = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	let writes = 0;
	let saved = false;
	async function reach(count: number) {
		if (!saved && writes + count > 1) {
			saved = true;
			await save();
		}
		writes += count;
	}
	function wrap(statement: D1PreparedStatement): D1PreparedStatement {
		const wrapped = new Proxy(statement, {
			get(target, property) {
				if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
				const value: unknown = Reflect.get(target, property, target);
				if (typeof value !== "function") return value;
				return async (...args: unknown[]) => {
					await reach(1);
					return value.apply(target, args);
				};
			},
		});
		anchorWrites.set(wrapped, statement);
		return wrapped;
	}
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => {
					const statement = target.prepare(query);
					return ANCHOR_WRITE.test(query) ? wrap(statement) : statement;
				};
			}
			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					await reach(statements.filter((statement) => anchorWrites.has(statement)).length);
					return target.batch(
						statements.map((statement) => anchorWrites.get(statement) ?? statement),
					);
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("editorial anchor updates on D1", () => {
	it("stores none of a batch's anchors when the entry is saved between their writes", async () => {
		await db
			.insertInto("users")
			.values({
				id: "user-ada",
				email: "ada@example.com",
				name: "Ada",
				role: 40,
				email_verified: 1,
			})
			.execute();
		const content = new ContentRepository(db);
		const entry = await content.create({ type: "post", data: { title: "One" } });
		const threads = new EditorialThreadRepository(db);
		const ids = [];
		for (const quote of ["quick", "brown"]) {
			const { threadId } = await threads.createThread({
				collection: "post",
				entryId: entry.id,
				anchor: { ...ANCHOR, quote },
				createdBy: "user-ada",
				body: "Source?",
				now: "2026-11-18T12:00:00.000Z",
			});
			ids.push(threadId);
		}

		const raced = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({
				database: saveBeforeSecondAnchorWrite(env.DB, async () => {
					await sql`
						UPDATE ec_post SET version = version + 1, updated_at = ${"2026-11-18T12:05:00.000Z"}
						WHERE id = ${entry.id}
					`.execute(db);
				}),
			}),
		});
		try {
			await expect(
				new EditorialThreadRepository(raced).updateAnchors({
					collection: "post",
					entryId: entry.id,
					expected: { version: entry.version, updatedAt: entry.updatedAt },
					updates: ids.map((threadId) => ({
						threadId,
						anchor: { ...ANCHOR, start: 20, end: 25 },
						anchorState: "attached" as const,
					})),
					now: "2026-11-18T12:06:00.000Z",
				}),
			).rejects.toBeInstanceOf(ContentMutationConflictError);
		} finally {
			await raced.destroy();
		}

		const stored = await db
			.selectFrom("_emdash_editorial_threads")
			.select("anchor")
			.where("id", "in", ids)
			.execute();
		expect(stored.map((row) => JSON.parse(row.anchor).start)).toEqual([4, 4]);
	});
});
