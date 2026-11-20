import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MediaFolderRepository } from "../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../src/database/repositories/media.js";
import type { Database } from "../../src/database/types.js";

interface D1Media {
	id: string;
	filename: string;
	storageKey: string;
}

let db: Kysely<Database>;
let media: MediaRepository;
let folders: MediaFolderRepository;
const items: D1Media[] = [];
const folderNames: string[] = [];

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
	media = new MediaRepository(db);
	folders = new MediaFolderRepository(db);

	for (const filename of [
		`${"ascii-common-prefix-".repeat(3)}target.txt`,
		`${"ascii-common-prefix-".repeat(3)}other.txt`,
		`${"æøå".repeat(18)}target.txt`,
		`${"æøå".repeat(18)}other.txt`,
		"wildcard-heavy-" + "%_\\".repeat(18) + ".txt",
	]) {
		const item = await media.create({
			filename,
			mimeType: "text/plain",
			storageKey: `d1-search/${filename}`,
		});
		items.push({ id: item.id, filename: item.filename, storageKey: item.storageKey });
	}

	const key = "01M66PYKARAMWV7H63E8S28HYA.01M66PYM1K0Y37FSW9F9XXMP3F.jpg";
	const keyed = await media.create({
		filename: "D1 key search.jpg",
		mimeType: "image/jpeg",
		storageKey: key,
	});
	items.push({ id: keyed.id, filename: keyed.filename, storageKey: keyed.storageKey });

	for (const name of [
		`${"folder-common-prefix-".repeat(3)}target`,
		`${"folder-common-prefix-".repeat(3)}other`,
		`${"æøå".repeat(18)}target`,
		`${"æøå".repeat(18)}other`,
		"wildcard-%_\\-folder",
		"Ｎｆｋｃ Folder",
	]) {
		folderNames.push((await folders.create(name)).name);
	}
});

afterAll(async () => {
	await db.destroy();
});

describe("media search on D1", () => {
	it("matches the complete long filename, including multibyte and wildcard-heavy values", async () => {
		for (const item of items.slice(0, 5)) {
			expect(
				(await media.findMany({ q: item.filename, limit: 20 })).items.map((row) => row.id),
			).toEqual([item.id]);
		}
	});

	it("matches the storage key and relative or absolute URL without hitting D1's LIKE limit", async () => {
		const item = items.at(-1)!;
		const queries = [
			item.storageKey,
			"01m66pym1k",
			`/_emdash/api/media/file/${item.storageKey}?download=1#preview`,
			`https://example.test/_emdash/api/media/file/${item.storageKey}?download=1#preview`,
		];

		for (const q of queries) {
			expect((await media.findMany({ q })).items).toContainEqual(
				expect.objectContaining({ id: item.id, storageKey: item.storageKey }),
			);
		}
	});

	it("matches long normalized folder names and literal wildcard characters", async () => {
		for (const name of folderNames) {
			expect((await folders.findMany({ q: name })).items.map((folder) => folder.name)).toEqual([
				name,
			]);
		}
		expect(
			(await folders.findMany({ q: "nfkc folder" })).items.map((folder) => folder.name),
		).toEqual(["Ｎｆｋｃ Folder"]);
	});
});
