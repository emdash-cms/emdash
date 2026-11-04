import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	BACKUP_STORAGE_PREFIX,
	generateBackupJson,
	maybeRunScheduledBackup,
	runBackupToStorage,
	updateBackupSettings,
} from "../../../src/api/handlers/backup.js";
import { generateSnapshot } from "../../../src/api/handlers/snapshot.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { DownloadResult, Storage } from "../../../src/storage/types.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
} from "../../utils/test-db.js";

interface StoredFile {
	body: Uint8Array;
	contentType: string;
	lastModified: Date;
}

function createStorage(): Storage & { files: Map<string, StoredFile> } {
	const files = new Map<string, StoredFile>();

	return {
		files,
		async upload(options) {
			if (!(options.body instanceof Uint8Array)) {
				throw new Error("test storage only supports Uint8Array bodies");
			}
			files.set(options.key, {
				body: options.body,
				contentType: options.contentType,
				lastModified: new Date(),
			});
			return { key: options.key, url: `test://${options.key}`, size: options.body.byteLength };
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
				files: [...files.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, file]) => ({
						key,
						size: file.body.byteLength,
						lastModified: file.lastModified,
					})),
			};
		},
		async getSignedUploadUrl() {
			throw new Error("not implemented");
		},
		getPublicUrl(key) {
			return `test://${key}`;
		},
	};
}

async function insertPost(
	ctx: DialectTestContext,
	input: { id: string; slug: string; status: string; deletedAt?: string },
): Promise<void> {
	const timestamp = "2026-07-25T12:00:00.000Z";
	await sql`
		INSERT INTO ec_post (
			id, slug, status, title, content, rating, created_at, updated_at, deleted_at, version
		)
		VALUES (
			${input.id}, ${input.slug}, ${input.status}, ${input.slug}, ${JSON.stringify([])}, 4.5,
			${timestamp}, ${timestamp}, ${input.deletedAt ?? null}, 1
		)
	`.execute(ctx.db);
}

describeEachDialect("snapshot generation", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "rating",
			label: "Rating",
			type: "number",
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("exports preview content and portable schema types", async () => {
		await insertPost(ctx, { id: "published", slug: "published", status: "published" });
		await insertPost(ctx, { id: "draft", slug: "draft", status: "draft" });
		await insertPost(ctx, { id: "scheduled", slug: "scheduled", status: "scheduled" });
		await insertPost(ctx, {
			id: "trashed",
			slug: "trashed",
			status: "published",
			deletedAt: "2026-07-25T13:00:00.000Z",
		});

		const snapshot = await generateSnapshot(ctx.db);

		expect(snapshot.tables.ec_post?.map((row) => row.slug)).toEqual(["published"]);
		expect(snapshot.tables.ec_post?.[0]?.content).toBe(JSON.stringify([]));
		expect(snapshot.tables.ec_page).toBeUndefined();
		expect(snapshot.schema.ec_page?.columns).toContain("id");
		expect(snapshot.schema.ec_post?.columns.slice(0, 3)).toEqual(["id", "slug", "status"]);
		expect(snapshot.schema.ec_post?.columns.at(-1)).toBe("rating");
		expect(snapshot.schema.ec_post?.types).toMatchObject({
			id: "TEXT",
			version: "INTEGER",
			content: "JSON",
			rating: "REAL",
		});
	});

	it("exports full backups through manual and scheduled storage paths", async () => {
		await insertPost(ctx, { id: "published", slug: "published", status: "published" });
		await insertPost(ctx, { id: "draft", slug: "draft", status: "draft" });
		await insertPost(ctx, { id: "scheduled", slug: "scheduled", status: "scheduled" });
		await insertPost(ctx, {
			id: "trashed",
			slug: "trashed",
			status: "published",
			deletedAt: "2026-07-25T13:00:00.000Z",
		});

		const backup = JSON.parse(await generateBackupJson(ctx.db));
		expect(backup.tables.ec_post.map((row: { slug: string }) => row.slug).toSorted()).toEqual([
			"draft",
			"published",
			"scheduled",
			"trashed",
		]);

		const manualStorage = createStorage();
		const manual = await runBackupToStorage(ctx.db, manualStorage, 7);
		expect(manual.success).toBe(true);
		if (!manual.success) return;
		const manualFile = manualStorage.files.get(`${BACKUP_STORAGE_PREFIX}${manual.data.name}`);
		expect(JSON.parse(new TextDecoder().decode(manualFile?.body)).format).toBe("emdash-backup");

		const scheduledStorage = createStorage();
		await updateBackupSettings(ctx.db, { enabled: true, retention: 7 });
		await maybeRunScheduledBackup(ctx.db, scheduledStorage);
		expect(scheduledStorage.files.size).toBe(1);
		const scheduledFile = [...scheduledStorage.files.values()][0];
		expect(JSON.parse(new TextDecoder().decode(scheduledFile?.body)).format).toBe("emdash-backup");
	});
});
