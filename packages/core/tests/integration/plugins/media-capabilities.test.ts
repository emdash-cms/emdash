import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import { parsePluginMediaMetadataPatch } from "../../../src/plugins/media.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import { LocalStorage } from "../../../src/storage/local.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

function plugin(capabilities: ResolvedPlugin["capabilities"]): ResolvedPlugin {
	return {
		id: "media-capability-test",
		version: "1.0.0",
		capabilities,
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [], fieldWidgets: {} },
		hooks: {},
		routes: {},
	};
}

describe("sandbox media capabilities", () => {
	let sqlite: BetterSqlite3.Database;
	let db: Kysely<Database>;
	let directory: string;
	let storage: LocalStorage;

	beforeEach(async () => {
		sqlite = new BetterSqlite3(":memory:");
		db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		directory = await mkdtemp(join(tmpdir(), "emdash-media-capability-"));
		storage = new LocalStorage({ directory, baseUrl: "https://media.example.test" });
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
		await rm(directory, { recursive: true, force: true });
	});

	it("returns expanded safe metadata for ready media only", async () => {
		const repo = new MediaRepository(db);
		const folder = await new MediaFolderRepository(db).create("Portraits");
		const ready = await repo.create({
			filename: "portrait.jpg",
			mimeType: "image/jpeg",
			size: 128,
			width: 640,
			height: 480,
			alt: "Portrait",
			caption: "Team portrait",
			storageKey: "private/original-portrait.jpg",
			contentHash: "sha1:known-file",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#334455",
			authorId: "private-author",
			folderId: folder.id,
		});
		const pending = await repo.createPending({
			filename: "pending.jpg",
			mimeType: "image/jpeg",
			storageKey: "private/pending.jpg",
		});

		const media = new PluginContextFactory({ db, storage }).createContext(
			plugin(["media:read"]),
		).media!;
		await expect(media.get(pending.id)).resolves.toBeNull();
		await expect(media.list()).resolves.toMatchObject({
			items: [expect.objectContaining({ id: ready.id })],
			hasMore: false,
		});
		const item = await media.get(ready.id);
		expect(item).toMatchObject({
			id: ready.id,
			width: 640,
			height: 480,
			alt: "Portrait",
			caption: "Team portrait",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#334455",
			folderId: folder.id,
			status: "ready",
		});
		expect(item).not.toHaveProperty("storageKey");
		expect(item).not.toHaveProperty("authorId");
		expect(item).not.toHaveProperty("contentHash");
		expect(item?.url).not.toContain("private/original-portrait.jpg");
	});

	it("reads bytes through a real storage adapter and enforces the actual stream size", async () => {
		const bytes = new Uint8Array([0, 1, 2, 255]);
		await storage.upload({
			key: "private/binary.bin",
			body: bytes,
			contentType: "application/octet-stream",
		});
		const repo = new MediaRepository(db);
		const item = await repo.create({
			filename: "binary.bin",
			mimeType: "application/octet-stream",
			size: 1,
			storageKey: "private/binary.bin",
			contentHash: "sha1:binary",
		});
		const overstated = await repo.create({
			filename: "overstated.bin",
			mimeType: "application/octet-stream",
			size: 20 * 1024 * 1024,
			storageKey: "private/binary.bin",
			contentHash: "sha1:overstated",
		});
		const media = new PluginContextFactory({ db, storage }).createContext(
			plugin(["media:bytes:read"]),
		).media!;

		await expect(media.get(item.id)).rejects.toThrow("Missing capability: media:read");
		await expect(media.readBytes!(item.id, { maxBytes: 3 })).rejects.toThrow(
			"Media exceeds the requested 3-byte limit",
		);
		await expect(media.readBytes!(item.id, { maxBytes: 0 })).rejects.toThrow(
			"maxBytes must be a positive integer",
		);
		await expect(media.readBytes!(item.id, { maxBytes: 16 * 1024 * 1024 + 1 })).rejects.toThrow(
			"no greater than",
		);
		await expect(media.readBytes!(item.id, { maxBytes: 4 })).resolves.toEqual({
			bytes,
			filename: "binary.bin",
			mimeType: "application/octet-stream",
			size: 4,
			contentHash: "sha1:binary",
		});
		await expect(media.readBytes!(overstated.id, { maxBytes: 4 })).resolves.toEqual({
			bytes,
			filename: "overstated.bin",
			mimeType: "application/octet-stream",
			size: 4,
			contentHash: "sha1:overstated",
		});

		await storage.delete("private/binary.bin");
		const failure = await media.readBytes!(item.id).catch((error: unknown) => error);
		expect(failure).toEqual(new Error("Failed to read media bytes"));
		expect(String(failure)).not.toContain("private/binary.bin");
	});

	it("reports a missing host storage adapter without widening authority", async () => {
		const media = new PluginContextFactory({ db }).createContext(
			plugin(["media:bytes:read"]),
		).media!;
		await expect(media.readBytes!("media-1")).rejects.toThrow("Media storage is not configured");
		await expect(media.get("media-1")).rejects.toThrow("Missing capability: media:read");
	});

	it("keeps byte and metadata mutation methods off ordinary media read access", () => {
		const media = new PluginContextFactory({ db, storage }).createContext(
			plugin(["media:read"]),
		).media!;
		expect(media.readBytes).toBeUndefined();
		expect(media.updateMetadata).toBeUndefined();
	});

	it("updates only ready-media alt, caption, and focal metadata", async () => {
		const repo = new MediaRepository(db);
		const item = await repo.create({
			filename: "landscape.jpg",
			mimeType: "image/jpeg",
			size: 16,
			width: 100,
			height: 50,
			storageKey: "private/landscape.jpg",
			contentHash: "sha1:landscape",
		});
		const pending = await repo.createPending({
			filename: "pending.jpg",
			mimeType: "image/jpeg",
			storageKey: "private/pending.jpg",
		});
		const media = new PluginContextFactory({ db, storage }).createContext(
			plugin(["media:metadata:write"]),
		).media!;

		await expect(media.get(item.id)).rejects.toThrow("Missing capability: media:read");
		await expect(media.updateMetadata!(pending.id, { alt: "Not yet" })).rejects.toThrow(
			"Media item is not ready or does not exist",
		);
		await expect(
			Reflect.apply(media.updateMetadata!, media, [
				item.id,
				{ alt: "Safe", storageKey: "other-file" },
			]),
		).rejects.toThrow("media.updateMetadata cannot change storageKey");
		await expect(Reflect.apply(media.updateMetadata!, media, [item.id, {}])).rejects.toThrow(
			"must change at least one metadata field",
		);
		await expect(repo.updateReadyMetadata(item.id, {})).rejects.toThrow(
			"requires at least one field",
		);
		await Promise.all([
			media.updateMetadata!(item.id, { alt: "Mountain view" }),
			media.updateMetadata!(item.id, { caption: "At sunrise" }),
		]);
		await media.updateMetadata!(item.id, { focalX: 0.25, focalY: 0.75 });

		await expect(repo.findById(item.id)).resolves.toMatchObject({
			alt: "Mountain view",
			caption: "At sunrise",
			focalX: 0.25,
			focalY: 0.75,
			size: 16,
			width: 100,
			height: 50,
			storageKey: "private/landscape.jpg",
			contentHash: "sha1:landscape",
		});
	});

	it("rejects attempts to smuggle file mutations into a metadata patch", () => {
		expect(() => parsePluginMediaMetadataPatch({})).toThrow(
			"must change at least one metadata field",
		);
		expect(() => parsePluginMediaMetadataPatch({ alt: "Safe", storageKey: "other-file" })).toThrow(
			"media.updateMetadata cannot change storageKey",
		);
		expect(() => parsePluginMediaMetadataPatch({ focalX: 0.5 })).toThrow(
			"focalX and focalY must both",
		);
	});
});

describeEachDialect("media metadata capability dialect parity", (dialect) => {
	let context: DialectTestContext;

	beforeEach(async () => {
		context = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(context);
	});

	it("merges concurrent field-specific updates without replacing file metadata", async () => {
		const repo = new MediaRepository(context.db);
		const item = await repo.create({
			filename: "dialect.jpg",
			mimeType: "image/jpeg",
			size: 16,
			storageKey: "private/dialect.jpg",
			contentHash: "sha1:dialect",
		});

		await Promise.all([
			repo.updateReadyMetadata(item.id, { alt: "Dialect alt" }),
			repo.updateReadyMetadata(item.id, { caption: "Dialect caption" }),
		]);

		await expect(repo.findById(item.id)).resolves.toMatchObject({
			alt: "Dialect alt",
			caption: "Dialect caption",
			storageKey: "private/dialect.jpg",
			contentHash: "sha1:dialect",
		});
	});
});
