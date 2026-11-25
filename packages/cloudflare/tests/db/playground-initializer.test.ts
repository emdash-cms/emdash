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

	it("seeds an open text thread with a reply and an open field thread", async () => {
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

		const threads = await db.selectFrom("_emdash_editorial_threads").select("anchor").execute();
		expect(threads).toHaveLength(2);

		// The rerun rewrites the post from the seed; the text thread must still point at its quote.
		const anchor = threads
			.map((thread) => JSON.parse(thread.anchor))
			.find((candidate) => candidate.type === "text");
		const post = await sql<{ content: string }>`
			SELECT content FROM ec_posts WHERE slug = ${"building-for-the-long-term"} AND locale = ${"en"}
		`.execute(db);
		const blocks = JSON.parse(post.rows[0]!.content) as Array<{
			_key?: string;
			children: Array<{ text?: string }>;
		}>;
		const block = blocks.find((candidate) => candidate._key === anchor.blockKey);
		const text = block?.children.map((child) => child.text ?? "").join("") ?? "";
		expect(text.slice(anchor.start, anchor.end)).toBe(anchor.quote);
	});
	it("restores an example thread or reply that an earlier attempt didn't create", async () => {
		const db = createDatabase();
		databases.push(db);

		await initializePlayground(db, loadPlaygroundSeed());
		await db
			.deleteFrom("_emdash_editorial_comments")
			.where("author_id", "=", "playground-admin")
			.execute();
		const excerpt = await db
			.selectFrom("_emdash_editorial_threads")
			.select("id")
			.where("anchor", "like", '%"excerpt"%')
			.executeTakeFirstOrThrow();
		await db.deleteFrom("_emdash_editorial_comments").where("thread_id", "=", excerpt.id).execute();
		await db.deleteFrom("_emdash_editorial_threads").where("id", "=", excerpt.id).execute();
		await new OptionsRepository(db).delete("emdash:setup_complete");
		await initializePlayground(db, loadPlaygroundSeed());

		const threads = await db
			.selectFrom("_emdash_editorial_threads")
			.select(["id", "anchor"])
			.orderBy("created_at")
			.orderBy("id")
			.execute();
		expect(threads.map((thread) => JSON.parse(thread.anchor))).toMatchObject([
			{ type: "text" },
			{ type: "field", field: "excerpt" },
		]);
		const replies = await db
			.selectFrom("_emdash_editorial_comments")
			.select("author_id")
			.where("thread_id", "=", threads[0]!.id)
			.execute();
		expect(
			replies.map((reply) => reply.author_id ?? "").toSorted((a, b) => a.localeCompare(b)),
		).toEqual(["playground-admin", "playground-reviewer"]);
	});

	it("skips the example threads when posts have no content or excerpt field", async () => {
		const db = createDatabase();
		databases.push(db);
		const seed = loadPlaygroundSeed();
		const posts = seed.collections?.find((collection) => collection.slug === "posts");
		posts!.fields = posts!.fields.filter(
			(field) => field.slug !== "content" && field.slug !== "excerpt",
		);
		for (const entry of seed.content?.posts ?? []) {
			delete entry.data.content;
			delete entry.data.excerpt;
		}

		await initializePlayground(db, seed);

		expect(await db.selectFrom("_emdash_editorial_threads").select("id").execute()).toEqual([]);
		expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBe(true);
	});
	it("adds no example reviewer when the example post isn't in the seed", async () => {
		const db = createDatabase();
		databases.push(db);
		const seed = loadPlaygroundSeed();
		seed.content!.posts = seed.content!.posts!.filter(
			(entry) => entry.slug !== "building-for-the-long-term",
		);

		await initializePlayground(db, seed);

		expect(await db.selectFrom("_emdash_editorial_threads").select("id").execute()).toEqual([]);
		expect(
			await db.selectFrom("users").select("id").where("id", "=", "playground-reviewer").execute(),
		).toEqual([]);
	});
});
