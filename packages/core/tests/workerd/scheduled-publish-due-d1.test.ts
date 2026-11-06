import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import {
	ContentRepository,
	findTypesWithDueContent,
} from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { publishDueContent } from "../../src/scheduled-publish.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { SQL_BATCH_SIZE } from "../../src/utils/chunks.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

/** One more collection than fits in a statement. */
const COLLECTION_COUNT = SQL_BATCH_SIZE + 1;

let db: Kysely<Database>;
let repo: ContentRepository;
let types: string[];
let dueTypes: string[];
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

	const registry = new SchemaRegistry(db);
	types = [];
	for (let index = 0; index < COLLECTION_COUNT; index++) {
		const slug = `due_${index}`;
		await registry.createCollection({ slug, label: slug, labelSingular: slug });
		types.push(slug);
	}

	repo = new ContentRepository(db);
	dueTypes = [types[1]!, types[COLLECTION_COUNT - 1]!];
	const past = new Date(Date.now() - 60_000).toISOString();
	for (const type of dueTypes) {
		const item = await repo.create({ type, slug: "due", data: {} });
		await repo.update(type, item.id, { status: "scheduled", scheduledAt: past });
	}
});

afterAll(async () => {
	await db.destroy();
});

describe("scheduled publishing across many collections on D1", () => {
	it("finds the collections with due content in one statement per batch", async () => {
		queryCount = 0;

		const due = await findTypesWithDueContent(db, types, new Date());

		expect(due).toEqual(new Set(dueTypes));
		expect(queryCount).toBe(2);
	});

	it("publishes the due entries", async () => {
		const published = await publishDueContent(db);

		expect(published.map((ref) => ref.collection).toSorted()).toEqual(dueTypes.toSorted());
		expect(await findTypesWithDueContent(db, types, new Date())).toEqual(new Set());
	});
});
