/**
 * Backup handler tests
 *
 * Covers: full-fidelity export (drafts + trash included), secrets exclusion,
 * archive naming/validation, settings clamping, storage archive lifecycle
 * (create, list, prune, delete), and the scheduled-run gate.
 */

import { sql } from "kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	BACKUP_STORAGE_PREFIX,
	archiveNameForDate,
	deleteBackupArchive,
	generateBackupJson,
	getBackupSettings,
	isValidArchiveName,
	listBackupArchives,
	maybeRunScheduledBackup,
	runBackupToStorage,
	updateBackupSettings,
} from "../../../src/api/handlers/backup.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import type { DownloadResult, Storage } from "../../../src/storage/types.js";
import { setupTestDatabaseWithCollections } from "../../utils/test-db.js";

// ── Storage fake ────────────────────────────────────────────────

interface StoredFile {
	key: string;
	body: Uint8Array;
	contentType: string;
	lastModified: Date;
}

function createFakeStorage(): Storage & { files: Map<string, StoredFile> } {
	const files = new Map<string, StoredFile>();

	return {
		files,
		async upload(options) {
			if (!(options.body instanceof Uint8Array)) {
				throw new Error("fake storage only supports Uint8Array bodies");
			}
			files.set(options.key, {
				key: options.key,
				body: options.body,
				contentType: options.contentType,
				lastModified: new Date(),
			});
			return { key: options.key, url: `fake://${options.key}`, size: options.body.byteLength };
		},
		async download(key): Promise<DownloadResult> {
			const file = files.get(key);
			if (!file) throw new Error(`not found: ${key}`);
			return {
				body: new Blob([file.body]).stream(),
				contentType: file.contentType,
				size: file.body.byteLength,
			};
		},
		async delete(key) {
			files.delete(key);
		},
		async exists(key) {
			return files.has(key);
		},
		async list(options) {
			const prefix = options?.prefix ?? "";
			return {
				files: [...files.values()]
					.filter((f) => f.key.startsWith(prefix))
					.map((f) => ({
						key: f.key,
						size: f.body.byteLength,
						lastModified: f.lastModified,
					})),
			};
		},
		async getSignedUploadUrl() {
			throw new Error("not implemented");
		},
		getPublicUrl(key) {
			return `fake://${key}`;
		},
	};
}

// ── Tests ───────────────────────────────────────────────────────

describe("backup handlers", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("generateBackupJson", () => {
		it("includes published, draft, and trashed content", async () => {
			await sql`
				INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
				VALUES ('pub1', 'published-post', 'published', 'Pub', 'c', datetime('now'), datetime('now'), 1)
			`.execute(db);
			await sql`
				INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
				VALUES ('draft1', 'draft-post', 'draft', 'Draft', 'c', datetime('now'), datetime('now'), 1)
			`.execute(db);
			await sql`
				INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, deleted_at, version)
				VALUES ('del1', 'trashed-post', 'published', 'Trashed', 'c', datetime('now'), datetime('now'), datetime('now'), 1)
			`.execute(db);

			const backup = JSON.parse(await generateBackupJson(db));

			expect(backup.format).toBe("emdash-backup");
			expect(backup.formatVersion).toBe(1);
			expect(backup.generatedAt).toBeTruthy();

			const slugs = backup.tables.ec_post.map((r: { slug: string }) => r.slug);
			expect(slugs).toContain("published-post");
			expect(slugs).toContain("draft-post");
			expect(slugs).toContain("trashed-post");
		});

		it("includes site settings but never secrets or auth tables", async () => {
			const options = new OptionsRepository(db);
			await options.set("site:title", "My Site");
			await options.set("emdash:site_title", "My Site");
			await options.set("emdash:site_tagline", "Tagline");
			await options.set("emdash:preview_secret", "super-secret-value");
			await options.set("plugin:some-plugin:api_key", "plugin-secret");
			await options.set("emdash:passkey_pending:user1", { challenge: "abc" });

			const backup = JSON.parse(await generateBackupJson(db));

			const optionNames = (backup.tables.options ?? []).map((r: { name: string }) => r.name);
			expect(optionNames).toContain("site:title");
			expect(optionNames).toContain("emdash:site_title");
			expect(optionNames).toContain("emdash:site_tagline");
			expect(optionNames).not.toContain("emdash:preview_secret");
			expect(optionNames).not.toContain("plugin:some-plugin:api_key");
			expect(optionNames).not.toContain("emdash:passkey_pending:user1");

			// Raw string check: no secret value anywhere in the payload
			const raw = await generateBackupJson(db);
			expect(raw).not.toContain("super-secret-value");
			expect(raw).not.toContain("plugin-secret");

			// Auth tables excluded entirely
			expect(backup.schema).not.toHaveProperty("users");
			expect(backup.schema).not.toHaveProperty("sessions");
			expect(backup.schema).not.toHaveProperty("credentials");
			expect(backup.schema).not.toHaveProperty("_emdash_api_tokens");
		});
	});

	describe("archive names", () => {
		it("round-trips through validation", () => {
			const name = archiveNameForDate(new Date("2026-07-09T08:45:12.345Z"));
			expect(name).toMatch(/^emdash-backup-2026-07-09T08-45-12-[0-9a-f]{8}\.json$/);
			expect(isValidArchiveName(name)).toBe(true);
		});

		it("generates unique names for the same second", () => {
			const date = new Date("2026-07-09T08:45:12.000Z");
			expect(archiveNameForDate(date)).not.toBe(archiveNameForDate(date));
		});

		it("rejects traversal and foreign names", () => {
			expect(isValidArchiveName("../../../etc/passwd")).toBe(false);
			expect(isValidArchiveName("emdash-backup-2026-07-09T08-45-12-abcd1234.json/../x")).toBe(
				false,
			);
			expect(isValidArchiveName("media/photo.jpg")).toBe(false);
			expect(isValidArchiveName("")).toBe(false);
		});
	});

	describe("settings", () => {
		it("defaults to disabled with retention 7", async () => {
			expect(await getBackupSettings(db)).toEqual({ enabled: false, retention: 7 });
		});

		it("persists and clamps retention", async () => {
			const result = await updateBackupSettings(db, { enabled: true, retention: 999 });
			expect(result.success).toBe(true);
			expect(await getBackupSettings(db)).toEqual({ enabled: true, retention: 30 });

			await updateBackupSettings(db, { enabled: true, retention: 0 });
			expect((await getBackupSettings(db)).retention).toBe(1);
		});
	});

	describe("archives in storage", () => {
		it("creates, lists, and deletes archives", async () => {
			const storage = createFakeStorage();

			const created = await runBackupToStorage(db, storage, 7);
			expect(created.success).toBe(true);
			if (!created.success) return;
			expect(isValidArchiveName(created.data.name)).toBe(true);
			expect(storage.files.has(`${BACKUP_STORAGE_PREFIX}${created.data.name}`)).toBe(true);

			const listed = await listBackupArchives(storage);
			expect(listed.success).toBe(true);
			if (!listed.success) return;
			expect(listed.data).toHaveLength(1);
			expect(listed.data[0]?.name).toBe(created.data.name);

			const deleted = await deleteBackupArchive(storage, created.data.name);
			expect(deleted.success).toBe(true);
			expect(storage.files.size).toBe(0);
		});

		it("rejects deleting invalid names without touching storage", async () => {
			const storage = createFakeStorage();
			const result = await deleteBackupArchive(storage, "../evil");
			expect(result.success).toBe(false);
			if (result.success) return;
			expect(result.error.code).toBe("VALIDATION_ERROR");
		});

		it("prunes archives beyond retention, oldest first", async () => {
			const storage = createFakeStorage();

			// Seed three archives with distinct timestamps in their names
			for (const stamp of ["2026-07-01T00-00-00", "2026-07-02T00-00-00", "2026-07-03T00-00-00"]) {
				const key = `${BACKUP_STORAGE_PREFIX}emdash-backup-${stamp}-abcd1234.json`;
				storage.files.set(key, {
					key,
					body: new Uint8Array([1]),
					contentType: "application/json",
					lastModified: new Date(),
				});
			}

			// Creating a fourth with retention 2 keeps only the 2 newest
			const created = await runBackupToStorage(db, storage, 2);
			expect(created.success).toBe(true);
			if (!created.success) return;

			const listed = await listBackupArchives(storage);
			expect(listed.success).toBe(true);
			if (!listed.success) return;
			expect(listed.data).toHaveLength(2);
			expect(listed.data[0]?.name).toBe(created.data.name);
			expect(listed.data[1]?.name).toBe("emdash-backup-2026-07-03T00-00-00-abcd1234.json");
		});

		it("ignores foreign files under the backups prefix when listing", async () => {
			const storage = createFakeStorage();
			storage.files.set(`${BACKUP_STORAGE_PREFIX}not-a-backup.txt`, {
				key: `${BACKUP_STORAGE_PREFIX}not-a-backup.txt`,
				body: new Uint8Array([1]),
				contentType: "text/plain",
				lastModified: new Date(),
			});

			const listed = await listBackupArchives(storage);
			expect(listed.success).toBe(true);
			if (!listed.success) return;
			expect(listed.data).toHaveLength(0);
		});
	});

	describe("maybeRunScheduledBackup", () => {
		it("does nothing when disabled or storage is missing", async () => {
			const storage = createFakeStorage();

			await maybeRunScheduledBackup(db, storage);
			expect(storage.files.size).toBe(0);

			await updateBackupSettings(db, { enabled: true, retention: 7 });
			await maybeRunScheduledBackup(db, undefined);
			expect(storage.files.size).toBe(0);
		});

		it("runs when enabled and skips within the daily interval", async () => {
			const storage = createFakeStorage();
			await updateBackupSettings(db, { enabled: true, retention: 7 });

			await maybeRunScheduledBackup(db, storage);
			expect(storage.files.size).toBe(1);

			// Immediately after, the last-run gate suppresses a second backup
			await maybeRunScheduledBackup(db, storage);
			expect(storage.files.size).toBe(1);
		});

		it("runs again once the interval has passed", async () => {
			const storage = createFakeStorage();
			await updateBackupSettings(db, { enabled: true, retention: 7 });

			// Simulate a last run 24h ago
			const options = new OptionsRepository(db);
			await options.set(
				"emdash:backups_last_run",
				new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
			);

			await maybeRunScheduledBackup(db, storage);
			expect(storage.files.size).toBe(1);
		});
	});
});
