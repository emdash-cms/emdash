import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/asset/[id]/[filename].js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { createMediaAccess } from "../../../src/plugins/context.js";
import { LocalStorage } from "../../../src/storage/local.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("opaque media asset route", () => {
	let db: Kysely<Database>;
	let directory: string;
	let storage: LocalStorage;

	beforeEach(async () => {
		db = await setupTestDatabase();
		directory = await mkdtemp(join(tmpdir(), "emdash-media-asset-"));
		storage = new LocalStorage({ directory, baseUrl: "https://media.example.test" });
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		await rm(directory, { recursive: true, force: true });
	});

	it("serves a ready item through its redacted plugin URL", async () => {
		const bytes = new Uint8Array([0, 255, 17, 42]);
		const storageKey = "private/original.bin";
		await storage.upload({
			key: storageKey,
			body: bytes,
			contentType: "application/octet-stream",
		});
		const item = await new MediaRepository(db).create({
			filename: "original.bin",
			mimeType: "application/octet-stream",
			size: bytes.byteLength,
			storageKey,
		});
		const metadata = await createMediaAccess(db).get(item.id);
		expect(metadata?.url).toBe(
			`/_emdash/api/media/asset/${encodeURIComponent(item.id)}/original.bin`,
		);
		expect(metadata?.url).not.toContain(storageKey);

		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- route test supplies the Astro fields read by GET
		const response = await GET({
			params: { id: item.id, filename: item.filename },
			locals: { emdash: { db, storage }, user: { id: "reader", role: 10 } },
		} as Parameters<typeof GET>[0]);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
		expect(response.headers.get("Content-Disposition")).toBe("attachment");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	it("does not serve pending media or a mismatched filename", async () => {
		const pending = await new MediaRepository(db).createPending({
			filename: "pending.bin",
			mimeType: "application/octet-stream",
			storageKey: "private/pending.bin",
		});
		for (const filename of [pending.filename, "other.bin"]) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- route test supplies the Astro fields read by GET
			const response = await GET({
				params: { id: pending.id, filename },
				locals: { emdash: { db, storage }, user: { id: "reader", role: 10 } },
			} as Parameters<typeof GET>[0]);
			expect(response.status).toBe(404);
		}
	});
});
