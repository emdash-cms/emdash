import { readFileSync } from "node:fs";

import type { Database, Storage } from "emdash";
import { OptionsRepository } from "emdash";
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
