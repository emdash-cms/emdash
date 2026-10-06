import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import type * as ObjectCache from "../../../src/object-cache/index.js";
import { invalidateTaxonomyObjectCache } from "../../../src/object-cache/index.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("../../../src/object-cache/index.js", async (importOriginal) => ({
	...(await importOriginal<typeof ObjectCache>()),
	invalidateTaxonomyObjectCache: vi.fn(),
}));

describe("term assignment batches", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(invalidateTaxonomyObjectCache).mockClear();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("invalidates cached terms when a later batch fails after earlier ones were written", async () => {
		const post = await new ContentRepository(db).create({
			type: "post",
			slug: "hello",
			data: { title: "Hello" },
		});
		await sql`
			CREATE TRIGGER fail_second_batch BEFORE INSERT ON content_taxonomies
			WHEN NEW.taxonomy_id = 'group-40'
			BEGIN SELECT RAISE(ABORT, 'boom'); END
		`.execute(db);
		const groups = Array.from({ length: 50 }, (_, i) => `group-${i}`);

		await expect(
			new TaxonomyRepository(db).attachGroupsToEntry("post", post.id, groups),
		).rejects.toThrow(/boom/);

		const { count } = await db
			.selectFrom("content_taxonomies")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		expect(Number(count)).toBeGreaterThan(0);
		expect(invalidateTaxonomyObjectCache).toHaveBeenCalled();
	});
});
