/**
 * SQL-shape coverage for replacing reference children.
 *
 * Local SQLite accepts far more bound parameters than Cloudflare D1, so a
 * large single INSERT succeeds locally while failing in production. Capture
 * the emitted statements and enforce D1's 100-parameter ceiling directly.
 */

import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";

interface CapturedQuery {
	sql: string;
	parameters: readonly unknown[];
}

let db: Kysely<DatabaseSchema>;
let repo: RelationRepository;
let captured: CapturedQuery[];

beforeEach(async () => {
	captured = [];
	db = new Kysely<DatabaseSchema>({
		dialect: new SqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
		log(event) {
			if (event.level === "query") {
				captured.push({ sql: event.query.sql, parameters: event.query.parameters });
			}
		},
	});
	await runMigrations(db);
	repo = new RelationRepository(db);
});

afterEach(async () => {
	await db.destroy();
});

function referenceInserts(): CapturedQuery[] {
	return captured.filter((query) => /insert into ["`]?_emdash_content_references/i.test(query.sql));
}

function referenceUpdates(): CapturedQuery[] {
	return captured.filter((query) => /update ["`]?_emdash_content_references/i.test(query.sql));
}

it("chunks large child replacements within D1's bound-parameter ceiling", async () => {
	const relation = await repo.create({
		slug: "related_pages",
		parentCollection: "posts",
		childCollection: "pages",
		parentLabel: "Post",
		childLabel: "Related page",
	});
	const childGroups = Array.from({ length: 40 }, (_, index) => `child-${index}`);

	captured = [];
	await repo.setChildren(relation.id, "parent-1", childGroups);

	const inserts = referenceInserts();
	expect(inserts.length).toBeGreaterThan(1);
	for (const insert of inserts) {
		expect(insert.parameters.length).toBeLessThanOrEqual(100);
	}

	const stored = await repo.getChildren(relation.slug, "parent-1");
	expect(stored.map((edge) => edge.childGroup)).toEqual(childGroups);
	expect(stored.map((edge) => edge.sortOrder)).toEqual(childGroups.map((_, index) => index));
});

it("chunks a large reorder within D1's bound-parameter ceiling", async () => {
	const relation = await repo.create({
		slug: "reordered_pages",
		parentCollection: "posts",
		childCollection: "pages",
		parentLabel: "Post",
		childLabel: "Related page",
	});
	// More children than one repositioning statement can bind, so the chunking
	// is what the assertions below see.
	const childGroups = Array.from({ length: 120 }, (_, index) => `reorder-child-${index}`);
	await repo.setChildren(relation.id, "parent-1", childGroups);

	// Reversing moves every edge, so the repositioning statements are the only
	// thing this replacement issues.
	const reversed = childGroups.toReversed();
	captured = [];
	await repo.setChildren(relation.id, "parent-1", reversed);

	const updates = referenceUpdates();
	expect(updates.length).toBeGreaterThan(1);
	for (const update of updates) {
		expect(update.parameters.length).toBeLessThanOrEqual(100);
	}
	expect(referenceInserts()).toHaveLength(0);

	const stored = await repo.getChildren(relation.slug, "parent-1");
	expect(stored.map((edge) => edge.childGroup)).toEqual(reversed);
	expect(stored.map((edge) => edge.sortOrder)).toEqual(reversed.map((_, index) => index));
});

it("chunks copied parent edges within D1's bound-parameter ceiling", async () => {
	const relation = await repo.create({
		slug: "copy_related_pages",
		parentCollection: "posts",
		childCollection: "pages",
		parentLabel: "Post",
		childLabel: "Related page",
	});
	const childGroups = Array.from({ length: 40 }, (_, index) => `copy-child-${index}`);
	await repo.setChildren(relation.id, "source-parent", childGroups);

	captured = [];
	await repo.copyParentEdges("source-parent", "copy-parent");

	const inserts = referenceInserts();
	expect(inserts.length).toBeGreaterThan(1);
	for (const insert of inserts) {
		expect(insert.parameters.length).toBeLessThanOrEqual(100);
	}

	const stored = await repo.getChildren(relation.slug, "copy-parent");
	expect(stored.map((edge) => edge.childGroup)).toEqual(childGroups);
});
