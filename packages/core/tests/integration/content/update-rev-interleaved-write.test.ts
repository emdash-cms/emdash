/**
 * A save carrying `_rev` must not overwrite a write that lands between the
 * runtime's `_rev` check and the read whose version guards the draft UPDATE.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("handleContentUpdate _rev against an interleaved write", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({ slug: "plain_posts", label: "Plain Posts", supports: [] });
		await registry.createField("plain_posts", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	/**
	 * Runs `write` inside the second call to `method`, before that call reads
	 * the row. The first call is the read the runtime validates `_rev` against
	 * (`findByIdOrSlug` reaches `findById` for a ULID), so the write lands after
	 * the token check and before the read that guards the update. The spy is
	 * removed before `write` runs so the interleaved save sees the real
	 * repository.
	 */
	function interleaveBeforeSecondRead(
		method: "findById" | "findByIdOrSlug",
		write: () => Promise<unknown>,
	) {
		const original = ContentRepository.prototype[method];
		let calls = 0;
		const spy = vi.spyOn(ContentRepository.prototype, method).mockImplementation(async function (
			this: ContentRepository,
			...args
		) {
			if (calls++ === 1) {
				spy.mockRestore();
				await write();
			}
			return original.apply(this, args as Parameters<typeof original>);
		});
	}

	it("returns CONFLICT instead of staging a draft over a write that landed between the two reads", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "live",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);

		const read = await runtime.handleContentGet("posts", id);
		expect(read.success).toBe(true);
		const staleRev = read.data!._rev;

		interleaveBeforeSecondRead("findById", async () => {
			const other = await runtime.handleContentUpdate("posts", id, {
				data: { title: "Other writer" },
			});
			expect(other.success).toBe(true);
		});

		const stale = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Stale writer" },
			_rev: staleRev,
		});

		expect(stale.success).toBe(false);
		expect(!stale.success && stale.error.code).toBe("CONFLICT");

		const after = await runtime.handleContentGet("posts", id);
		expect(after.data!.item.data.title).toBe("Other writer");
	});

	it("returns CONFLICT instead of overwriting columns on a collection without revisions", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			data: { title: "Plain" },
			slug: "plain",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const staleRev = created.data!._rev;

		interleaveBeforeSecondRead("findByIdOrSlug", async () => {
			const other = await runtime.handleContentUpdate("plain_posts", id, {
				data: { title: "Other writer" },
			});
			expect(other.success).toBe(true);
		});

		const stale = await runtime.handleContentUpdate("plain_posts", id, {
			data: { title: "Stale writer" },
			_rev: staleRev,
		});

		expect(stale.success).toBe(false);
		expect(!stale.success && stale.error.code).toBe("CONFLICT");

		const after = await runtime.handleContentGet("plain_posts", id);
		expect(after.data!.item.data.title).toBe("Other writer");
	});
});
