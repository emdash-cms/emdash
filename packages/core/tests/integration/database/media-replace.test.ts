import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectName,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("MediaRepository ready-file replacement", (dialect: DialectName) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("updates only replacement metadata for the expected ready storage key", async () => {
		const repo = new MediaRepository(ctx.db);
		const folder = await new MediaFolderRepository(ctx.db).create("Editorial");
		const original = await repo.create({
			filename: "hero.png",
			mimeType: "image/png",
			size: 120,
			width: 1200,
			height: 800,
			alt: "A mountain",
			caption: "Homepage hero",
			storageKey: "media/hero.png",
			contentHash: "sha256:before",
			blurhash: "before-blurhash",
			dominantColor: "#123456",
			authorId: "author-1",
		});
		await repo.update(original.id, { folderId: folder.id, focalX: 0.2, focalY: 0.8 });

		const replaced = await repo.replaceReadyFile(original.id, original.storageKey, {
			size: 60,
			width: 600,
			height: 400,
			contentHash: "sha256:after",
		});

		expect(replaced).toMatchObject({
			id: original.id,
			filename: "hero.png",
			mimeType: "image/png",
			size: 60,
			width: 600,
			height: 400,
			alt: "A mountain",
			caption: "Homepage hero",
			storageKey: "media/hero.png",
			contentHash: "sha256:after",
			blurhash: null,
			dominantColor: null,
			focalX: null,
			focalY: null,
			authorId: "author-1",
			folderId: folder.id,
			status: "ready",
			createdAt: original.createdAt,
		});
	});

	it("does not update a non-ready row or a row whose storage key changed", async () => {
		const repo = new MediaRepository(ctx.db);
		const pending = await repo.createPending({
			filename: "pending.png",
			mimeType: "image/png",
			size: 120,
			storageKey: "pending.png",
		});

		await expect(
			repo.replaceReadyFile(pending.id, pending.storageKey, {
				size: 60,
				width: 600,
				height: 400,
				contentHash: "sha256:after",
			}),
		).resolves.toBeNull();

		const ready = await repo.create({
			filename: "ready.png",
			mimeType: "image/png",
			size: 120,
			storageKey: "ready.png",
		});
		await expect(
			repo.replaceReadyFile(ready.id, "stale-key.png", {
				size: 60,
				width: 600,
				height: 400,
				contentHash: "sha256:after",
			}),
		).resolves.toBeNull();
	});
});
