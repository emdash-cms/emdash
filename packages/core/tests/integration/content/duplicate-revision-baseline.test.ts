import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("duplicated entries keep an initial revision baseline", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("should preserve the pre-edit baseline through autosave and explicit save", async () => {
		const original = await runtime.handleContentCreate("posts", {
			data: { title: "Lorem ipsum dolor sit amet." },
			slug: "original-post",
		});
		expect(original.success).toBe(true);
		const originalId = original.data!.item.id;

		const duplicated = await runtime.handleContentDuplicate("posts", originalId);
		expect(duplicated.success).toBe(true);
		const duplicateId = duplicated.data!.item.id;

		// Simulate opening the duplicate and adding a sentence via autosave.
		const autosaved = await runtime.handleContentUpdate("posts", duplicateId, {
			data: { title: "Lorem ipsum dolor sit amet. Duis aute irure dolor in reprehenderit." },
			skipRevision: true,
		});
		expect(autosaved.success).toBe(true);

		// Make a further edit via explicit save (e.g. removing another paragraph).
		const saved = await runtime.handleContentUpdate("posts", duplicateId, {
			data: { title: "Duis aute irure dolor in reprehenderit." },
		});
		expect(saved.success).toBe(true);

		const revisions = await runtime.handleRevisionList("posts", duplicateId);
		expect(revisions.success).toBe(true);

		// The oldest retained revision should still contain the duplicated pre-edit body.
		const oldest = revisions.data!.items.at(-1);
		expect(oldest?.data.title).toBe("Lorem ipsum dolor sit amet. (Copy)");

		// The current draft should contain the post-edit body.
		const current = revisions.data!.items[0];
		expect(current?.data.title).toBe("Duis aute irure dolor in reprehenderit.");
	});
});
