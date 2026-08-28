import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

/**
 * Regression for #2774 (3): every entity in an exported seed is keyed by a
 * derived seed id (`groups:soumu`), but `reference` field *values* kept the
 * source database's row id (`$ref:01M0…`). `seed` assigns fresh ids on insert,
 * so no row in the restored database carries that id: `resolveValue` finds no
 * entry in `seedIdMap` and stores the literal `$ref:01M0…` string in the
 * column. The reference is neither resolved nor cleared, and the restore
 * reports success — so the loss shows up only wherever the field was rendered.
 */

/**
 * A referenced collection and a referencing one. `groups` is created first so
 * it is exported first: `applySeed` fills `seedIdMap` as it walks the file, so
 * a reference only resolves when its target appears earlier — the shape a real
 * export produces here.
 */
async function createSchema(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);

	await registry.createCollection({ slug: "groups", label: "Groups" });
	await registry.createField("groups", { slug: "name", label: "Name", type: "string" });

	await registry.createCollection({ slug: "events", label: "Events" });
	await registry.createField("events", { slug: "title", label: "Title", type: "string" });
	await registry.createField("events", {
		slug: "organizer",
		label: "Organizer",
		type: "reference",
	});
}

/** Insert a group and an event pointing at it. Returns the group's row id. */
async function seedSourceContent(db: Kysely<Database>): Promise<string> {
	const contentRepo = new ContentRepository(db);
	const group = await contentRepo.create({
		type: "groups",
		slug: "soumu",
		data: { name: "General Affairs" },
	});
	await contentRepo.create({
		type: "events",
		slug: "briefing",
		data: { title: "Briefing", organizer: group.id },
	});
	return group.id;
}

describe("exportSeed: reference values (#2774)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("exports a reference as the target's seed id, not its row id", async () => {
		await createSchema(db);
		const groupId = await seedSourceContent(db);

		const seed = await exportSeed(db, "all");

		const event = seed.content?.events?.[0];
		expect(event?.data.organizer).toBe("$ref:groups:soumu");
		expect(event?.data.organizer).not.toContain(groupId);
	});

	it("resolves the reference to the restored row on export → apply", async () => {
		await createSchema(db);
		await seedSourceContent(db);

		const seed = await exportSeed(db, "all");

		const restored = await setupTestDatabase();
		try {
			await applySeed(restored, seed, { includeContent: true });

			const restoredRepo = new ContentRepository(restored);
			const group = await restoredRepo.findBySlug("groups", "soumu");
			const event = await restoredRepo.findBySlug("events", "briefing");

			expect(group?.id).toBeDefined();
			expect(event?.data.organizer).toBe(group?.id);
		} finally {
			await teardownTestDatabase(restored);
		}
	});

	it("writes the referenced collection before the one pointing at it", async () => {
		await createSchema(db);
		await seedSourceContent(db);

		const seed = await exportSeed(db, "all");

		// Both collections sort under the same rank, so `events` comes first by
		// slug -- the order that leaves the reference unresolvable on apply.
		expect(Object.keys(seed.content ?? {})).toEqual(["groups", "events"]);
	});

	it("still exports when two collections reference each other", async () => {
		await createSchema(db);
		const registry = new SchemaRegistry(db);
		await registry.createField("groups", {
			slug: "flagship_event",
			label: "Flagship Event",
			type: "reference",
		});

		const contentRepo = new ContentRepository(db);
		const group = await contentRepo.create({
			type: "groups",
			slug: "soumu",
			data: { name: "General Affairs" },
		});
		const event = await contentRepo.create({
			type: "events",
			slug: "briefing",
			data: { title: "Briefing", organizer: group.id },
		});
		await contentRepo.update("groups", group.id, { data: { flagship_event: event.id } });

		// No order satisfies a cycle. The export must still produce both
		// collections rather than looping or dropping one.
		const seed = await exportSeed(db, "all");

		expect(Object.keys(seed.content ?? {}).toSorted()).toEqual(["events", "groups"]);
	});

	it("leaves a reference to an entry outside the export unresolved rather than mislabelled", async () => {
		await createSchema(db);
		const groupId = await seedSourceContent(db);

		// Only `events` is exported, so the target carries no seed id in this
		// file. Nothing can resolve it; the value must not claim otherwise.
		const seed = await exportSeed(db, "events");

		expect(seed.content?.groups).toBeUndefined();
		expect(seed.content?.events?.[0]?.data.organizer).toBe(`$ref:${groupId}`);
	});
});
