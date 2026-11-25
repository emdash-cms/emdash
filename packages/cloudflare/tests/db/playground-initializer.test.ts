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

	it("counts full media links without a Site URL setting in a fresh playground", async () => {
		const db = createDatabase();
		databases.push(db);
		const seed = loadPlaygroundSeed();
		const asset = PLAYGROUND_MEDIA_ASSETS[0]!;
		const origin = "https://preview.example.test";
		seed.content!.posts![0]!.data.content = [
			{
				_type: "block",
				_key: "copy-url",
				children: [{ _type: "span", text: "Download", marks: ["download"] }],
				markDefs: [
					{
						_type: "link",
						_key: "download",
						href: `${origin}/_emdash/api/media/file/${asset.storageKey}`,
					},
				],
			},
		];

		await initializePlayground(db, seed, origin);
		expect(await new OptionsRepository(db).get("site:url")).toBeNull();
		const usage = await db
			.selectFrom("_emdash_media_usage")
			.select(["reference_type", "field_path"])
			.where("media_id", "=", asset.id)
			.execute();
		expect(usage).toContainEqual({
			reference_type: "link",
			field_path: "content[0].markDefs[0].href",
		});
	});

	it("adds a missing setup origin to an initialized session without overwriting it later", async () => {
		const db = createDatabase();
		databases.push(db);
		const seed = loadPlaygroundSeed();
		await initializePlayground(db, seed);
		const options = new OptionsRepository(db);
		await options.set("emdash:site_title", "Edited title");
		await initializePlayground(db, seed, "https://preview.example.test");
		expect(await options.get("emdash:site_url")).toBe("https://preview.example.test");
		expect(await options.get("emdash:site_title")).toBe("Edited title");
		await initializePlayground(db, seed, "https://other.example.test");
		expect(await options.get("emdash:site_url")).toBe("https://preview.example.test");
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
});
