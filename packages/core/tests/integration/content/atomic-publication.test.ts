import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { createPostFixture } from "../../utils/fixtures.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("atomic content publication", (dialect) => {
	let ctx: DialectTestContext;
	let contentRepo: ContentRepository;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		contentRepo = new ContentRepository(ctx.db);
		revisionRepo = new RevisionRepository(ctx.db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownForDialect(ctx);
	});

	it("rolls back every promoted column when the staged slug constraint rejects", async () => {
		await contentRepo.create(createPostFixture({ slug: "taken", status: "published" }));
		const post = await contentRepo.create(createPostFixture({ slug: "initial" }));
		const draft = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Final title", _slug: "taken" },
		});
		await contentRepo.setDraftRevision("post", post.id, draft.id);
		const scheduledAt = new Date(Date.now() - 60_000).toISOString();
		await contentRepo.update("post", post.id, {
			status: "scheduled",
			scheduledAt,
		});
		const before = await contentRepo.findById("post", post.id);
		vi.spyOn(contentRepo, "findBySlugIncludingTrashed").mockResolvedValueOnce(null);

		await expect(
			contentRepo.publish("post", post.id, scheduledAt, true, scheduledAt),
		).rejects.toThrow();

		const after = await contentRepo.findById("post", post.id);
		expect(after).toEqual(before);
	});

	it("never leaves a dangling pointer when staging races guarded revision deletion", async () => {
		const post = await contentRepo.create(createPostFixture());
		const revision = await revisionRepo.create({
			collection: "post",
			entryId: post.id,
			data: { ...post.data, title: "Racing draft" },
		});
		const expected = await contentRepo.findById("post", post.id);
		expect(expected).not.toBeNull();

		await Promise.allSettled([
			contentRepo.replaceDraftRevision("post", post.id, revision.id, expected!),
			revisionRepo.deleteIfUnreferenced("post", post.id, revision.id),
		]);

		const [after, storedRevision] = await Promise.all([
			contentRepo.findById("post", post.id),
			revisionRepo.findById(revision.id),
		]);
		if (after?.draftRevisionId === revision.id) {
			expect(storedRevision).not.toBeNull();
		} else {
			expect(storedRevision).toBeNull();
		}
	});
});
