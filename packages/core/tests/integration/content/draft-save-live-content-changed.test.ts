/**
 * handleContentUpdate reports liveContentChanged so edge invalidation can
 * skip pure draft staging on revision-supporting collections.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("handleContentUpdate liveContentChanged", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createCollection({
			slug: "plain_posts",
			label: "Plain Posts",
			supports: [],
		});
		await registry.createField("plain_posts", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		runtime = createTestRuntime(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("is false for draft-only data save on revision collections", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "live",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Draft edit" },
		});
		expect(saved.success).toBe(true);
		expect(saved.success && saved.liveContentChanged).toBe(false);
	});

	it("is false when data+slug are staged as a draft revision", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "live",
		});
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);

		const saved = await runtime.handleContentUpdate("posts", id, {
			data: { title: "Live" },
			slug: "live-renamed",
		});
		expect(saved.success).toBe(true);
		expect(saved.success && saved.liveContentChanged).toBe(false);
	});

	it("is true when live metadata changes on a revision collection", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "live-meta",
		});
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);

		const saved = await runtime.handleContentUpdate("posts", id, {
			publishedAt: "2020-01-01T00:00:00.000Z",
		});
		expect(saved.success).toBe(true);
		expect(saved.success && saved.liveContentChanged).toBe(true);
	});

	it("defaults unclassified update fields to live-changing", async () => {
		const created = await runtime.handleContentCreate("posts", {
			data: { title: "Live" },
			slug: "future-meta",
		});
		const id = created.data!.item.id;
		await runtime.handleContentPublish("posts", id);

		const saved = await runtime.handleContentUpdate("posts", id, {
			// @ts-expect-error - simulates a future live field before it joins the public input type
			futureLiveField: "changed",
		});
		expect(saved.success).toBe(true);
		expect(saved.success && saved.liveContentChanged).toBe(true);
	});

	it("is true for data updates on collections without revisions", async () => {
		const created = await runtime.handleContentCreate("plain_posts", {
			data: { title: "Plain" },
			slug: "plain",
		});
		const id = created.data!.item.id;

		const updated = await runtime.handleContentUpdate("plain_posts", id, {
			data: { title: "Plain edited" },
		});
		expect(updated.success).toBe(true);
		expect(updated.success && updated.liveContentChanged).toBe(true);
	});
});
