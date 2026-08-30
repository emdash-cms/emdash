import { readFileSync } from "node:fs";

import type { Database, Storage } from "emdash";
import { OptionsRepository } from "emdash";
import { runMigrations } from "emdash/db";
import type { SeedFile } from "emdash/seed";
import { Kysely, SqliteDialect, sql } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openNodeSqliteDatabase } from "../../../core/src/db/node-sqlite-compat.js";
import { PLAYGROUND_MEDIA_ASSETS } from "../../src/db/playground-assets-storage.js";
import {
	initializePlayground,
	runPlaygroundInitialization,
} from "../../src/db/playground-initializer.js";

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

function createAssetStorage(failDownloadAt?: number): Storage & { allowDownloads(): void } {
	let downloadCount = 0;
	let failureEnabled = failDownloadAt !== undefined;
	return {
		allowDownloads() {
			failureEnabled = false;
		},
		async upload() {
			throw new Error("uploads are unavailable");
		},
		async download(key) {
			downloadCount++;
			if (failureEnabled && downloadCount === failDownloadAt) {
				throw new Error(`asset unavailable: ${key}`);
			}
			const asset = PLAYGROUND_MEDIA_ASSETS.find((candidate) => candidate.storageKey === key);
			if (!asset) throw new Error(`unknown asset: ${key}`);
			return {
				body: new Blob([new Uint8Array([1])]).stream(),
				contentType: asset.mimeType,
				size: asset.size,
			};
		},
		async delete() {
			throw new Error("deletes are unavailable");
		},
		async exists() {
			return true;
		},
		async list() {
			return { files: [] };
		},
		async getSignedUploadUrl() {
			throw new Error("signed uploads are unavailable");
		},
		getPublicUrl(key) {
			return `/_emdash/api/media/file/${key}`;
		},
	};
}

async function expectMediaUsageReady(db: Kysely<Database>): Promise<void> {
	const activation = await db
		.selectFrom("_emdash_media_usage_activation")
		.select("state")
		.where("task_key", "=", "incremental_capture")
		.executeTakeFirstOrThrow();
	expect(activation.state).toBe("active");

	const collections = await db
		.selectFrom("_emdash_media_usage_index_status")
		.select(["scope_key", "status", "capture_state", "reconciliation_required"])
		.where("adapter_id", "=", "content-media")
		.where("scope_type", "=", "collection")
		.orderBy("scope_key")
		.execute();
	expect(collections).toEqual([
		{
			scope_key: "pages",
			status: "complete",
			capture_state: "active",
			reconciliation_required: 0,
		},
		{
			scope_key: "posts",
			status: "complete",
			capture_state: "active",
			reconciliation_required: 0,
		},
	]);
	expect(await db.selectFrom("_emdash_media_usage_work").select("content_id").execute()).toEqual(
		[],
	);
}

describe("initializePlayground", () => {
	const databases: Kysely<Database>[] = [];

	afterEach(async () => {
		await Promise.all(databases.splice(0).map((db) => db.destroy()));
	});

	it("creates seven ready media rows referenced by the seeded posts", async () => {
		const db = createDatabase();
		databases.push(db);

		await initializePlayground(db, loadPlaygroundSeed(), createAssetStorage());

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
			expect(image.value).toMatchObject({ provider: "local" });
			expect(media.some(({ id }) => id === image.value.id)).toBe(true);
		}
		await expectMediaUsageReady(db);
	});

	it("leaves setup incomplete and retries after partial media preparation", async () => {
		const db = createDatabase();
		databases.push(db);
		const storage = createAssetStorage(4);
		const seed = loadPlaygroundSeed();

		await expect(initializePlayground(db, seed, storage)).rejects.toThrow("asset unavailable");
		expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBeNull();
		expect(await db.selectFrom("media").select("id").execute()).toHaveLength(3);

		storage.allowDownloads();
		await initializePlayground(db, seed, storage);

		expect(await db.selectFrom("media").select("id").execute()).toHaveLength(7);
		expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBe(true);
		await expectMediaUsageReady(db);
	});

	it("withholds setup completion until Media Usage reaches Ready", async () => {
		const db = createDatabase();
		databases.push(db);
		await runMigrations(db);
		await sql`CREATE TABLE test_media_usage_gate (blocked integer NOT NULL)`.execute(db);
		await sql`INSERT INTO test_media_usage_gate (blocked) VALUES (1)`.execute(db);
		await sql`
			CREATE TRIGGER test_block_media_usage_completion
			BEFORE UPDATE OF status ON _emdash_media_usage_index_status
			WHEN NEW.status = 'complete' AND (SELECT blocked FROM test_media_usage_gate) = 1
			BEGIN
				SELECT RAISE(FAIL, 'blocked media usage completion');
			END
		`.execute(db);
		const seed = loadPlaygroundSeed();
		const storage = createAssetStorage();

		await expect(initializePlayground(db, seed, storage)).rejects.toThrow(
			"Media Usage did not reach Ready",
		);
		expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBeNull();

		await sql`UPDATE test_media_usage_gate SET blocked = 0`.execute(db);
		await initializePlayground(db, seed, storage);

		expect(await new OptionsRepository(db).get("emdash:setup_complete")).toBe(true);
		await expectMediaUsageReady(db);
	});
});

describe("runPlaygroundInitialization", () => {
	it("lets a waiter observe readiness without sharing the owner's promise", async () => {
		let finish!: () => void;
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		let ready = false;
		const initialize = vi.fn(async () => {
			await blocked;
			ready = true;
		});
		const anchor = vi.fn();

		const first = runPlaygroundInitialization("binding:session", () => ready, initialize, anchor);
		const second = runPlaygroundInitialization("binding:session", () => ready, initialize, anchor);
		await Promise.resolve();
		expect(initialize).toHaveBeenCalledOnce();
		expect(anchor).toHaveBeenCalledOnce();

		finish();
		await Promise.all([first, second]);
	});

	it("lets a waiter retry after the owner fails", async () => {
		let attempt = 0;
		let ready = false;
		const initialize = vi.fn(async () => {
			attempt++;
			if (attempt === 1) throw new Error("initialization failed");
			ready = true;
		});

		const first = runPlaygroundInitialization(
			"binding:retry-session",
			() => ready,
			initialize,
			vi.fn(),
		);
		const second = runPlaygroundInitialization(
			"binding:retry-session",
			() => ready,
			initialize,
			vi.fn(),
		);

		await expect(first).rejects.toThrow("initialization failed");
		await expect(second).resolves.toBeUndefined();
		expect(initialize).toHaveBeenCalledTimes(2);
	});
});
