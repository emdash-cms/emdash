import { readFileSync } from "node:fs";

import type { Database } from "emdash";
import { handleMediaUsageProgress, OptionsRepository } from "emdash";
import type { SeedFile } from "emdash/seed";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openNodeSqliteDatabase } from "../../../core/src/db/node-sqlite-compat.js";
import { PLAYGROUND_MEDIA_ASSETS } from "../../src/db/playground-assets-storage.js";
import { initializePlayground } from "../../src/db/playground-initializer.js";

const seedUrl = new URL("../../../../demos/playground/seed/seed.json", import.meta.url);

function loadPlaygroundSeed(): SeedFile {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- repository-owned seed fixture
	return JSON.parse(readFileSync(seedUrl, "utf8")) as SeedFile;
}

function createDatabase(): Kysely<Database> {
	return new Kysely<Database>({
		dialect: new SqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
	});
}

describe("initializePlayground", () => {
	const databases: Kysely<Database>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((db) => db.destroy()));
	});

	it("creates seven ready media rows referenced by the seeded posts", async () => {
		const db = createDatabase();
		databases.push(db);

		await initializePlayground(db, loadPlaygroundSeed());

		const media = await db
			.selectFrom("media")
			.select(["id", "storage_key", "status"])
			.orderBy("id")
			.execute();
		expect(media).toHaveLength(7);
		expect(media.every(({ status }) => status === "ready")).toBe(true);

		const result = await sql<{ slug: string; featured_image: string | null }>`
			SELECT slug, featured_image
			FROM ec_posts
			WHERE locale = ${"en"}
			ORDER BY slug
		`.execute(db);
		const images = result.rows.flatMap((post) =>
			post.featured_image ? [{ slug: post.slug, value: JSON.parse(post.featured_image) }] : [],
		);
		expect(images).toHaveLength(7);
		for (const image of images) {
			const asset = PLAYGROUND_MEDIA_ASSETS.find(({ id }) => id === image.value.id);
			expect(asset).toBeDefined();
			expect(image.value).toMatchObject({
				provider: "local",
				filename: asset?.filename,
				meta: { storageKey: asset?.storageKey },
			});
		}

		const progress = await handleMediaUsageProgress(db);
		expect(progress.success).toBe(true);
		if (progress.success) {
			expect(progress.data).toMatchObject({
				status: "ready",
				readyCollections: 2,
				totalCollections: 2,
			});
		}
		expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBe(true);
	});

	it("seeds example editorial threads that visitors can reply to and resolve", async () => {
		const db = createDatabase();
		databases.push(db);

		await initializePlayground(db, loadPlaygroundSeed());

		const threads = await db
			.selectFrom("_emdash_editorial_threads")
			.select(["id", "anchor", "status"])
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		expect(threads.map((thread) => JSON.parse(thread.anchor))).toMatchObject([
			{ type: "text", quote: "you spend more time migrating than building" },
			{ type: "field", field: "excerpt" },
		]);
		expect(threads.every((thread) => thread.status === "open")).toBe(true);

		const replies = await db
			.selectFrom("_emdash_editorial_comments")
			.select("author_id")
			.where("thread_id", "=", threads[0]!.id)
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		expect(replies.map((reply) => reply.author_id)).toEqual([
			"playground-reviewer",
			"playground-admin",
		]);
	});

	it("seeds the example threads once when initialization runs again", async () => {
		const db = createDatabase();
		databases.push(db);

		await initializePlayground(db, loadPlaygroundSeed());
		await new OptionsRepository(db).delete("emdash:setup_complete");
		await initializePlayground(db, loadPlaygroundSeed());

		const threads = await db.selectFrom("_emdash_editorial_threads").select("id").execute();
		expect(threads).toHaveLength(2);
	});
});
