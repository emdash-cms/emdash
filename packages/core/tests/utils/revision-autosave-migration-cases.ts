import { sql, type Kysely } from "kysely";
import { expect } from "vitest";

import { up } from "../../src/database/migrations/092_revision_autosave.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { createRevisionId, RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { createTestRuntime } from "./mcp-runtime.js";

export async function verifyRevisionAutosaveUpgrade(db: Kysely<Database>): Promise<void> {
	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: "posts", label: "Posts" });
	await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
	const content = await new ContentRepository(db).create({
		type: "posts",
		data: { title: "Initial" },
		slug: "upgraded-history",
	});
	await db.schema.alterTable("revisions").dropColumn("is_autosave").execute();
	const legacyData = { title: "Saved checkpoint", details: "Legacy content é ".repeat(4_000) };
	const legacyRows = Array.from({ length: 50 }, () => ({
		id: createRevisionId(),
		collection: "posts",
		entry_id: content.id,
		data: JSON.stringify(legacyData),
		author_id: null,
	}));
	const checkpointId = legacyRows.at(-1)!.id;
	for (let offset = 0; offset < 50; offset += 10) {
		await db
			.insertInto("revisions")
			.values(legacyRows.slice(offset, offset + 10))
			.execute();
	}
	await sql`
		UPDATE ec_posts SET draft_revision_id = ${checkpointId}
		WHERE id = ${content.id}
	`.execute(db);

	await Promise.all([up(db), up(db)]);
	await up(db);
	const revisions = new RevisionRepository(db);
	const preserved = await revisions.findByEntry("posts", content.id);
	expect(preserved).toHaveLength(50);
	expect(preserved.every((revision) => revision.data.details === legacyData.details)).toBe(true);

	const runtime = createTestRuntime(db);
	const first = await runtime.handleContentUpdate("posts", content.id, {
		data: { title: "New typing" },
		skipRevision: true,
	});
	expect(first.success).toBe(true);
	expect((await revisions.findById(checkpointId))?.data).toEqual(legacyData);

	await up(db);
	const second = await runtime.handleContentUpdate("posts", content.id, {
		data: { title: "More typing" },
		skipRevision: true,
		_rev: first.data!._rev,
	});
	expect(second.success).toBe(true);
	expect(await revisions.findById(first.data!.item.draftRevisionId!)).toBeNull();
	expect((await revisions.findById(checkpointId))?.data).toEqual(legacyData);
}
