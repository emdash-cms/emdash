import { afterEach, beforeEach, expect, it } from "vitest";

import { handleContentCreate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { setRoomNotifier } from "../../../src/rooms/notifications.js";
import { roomId } from "../../../src/rooms/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { RecordingNotifier } from "../../utils/room-notifier.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("Room notifications from content writes", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;
	let notifier: RecordingNotifier;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		repo = new ContentRepository(ctx.db);
		notifier = new RecordingNotifier();
		setRoomNotifier(notifier);
	});

	afterEach(async () => {
		setRoomNotifier(null);
		await teardownForDialect(ctx);
	});

	async function createPost(
		slug = "hello",
		options: { locale?: string; translationOf?: string } = {},
	) {
		const item = await repo.create({ type: "post", data: { title: "Hello" }, slug, ...options });
		await notifier.take();
		return { item, room: roomId({ collection: "post", id: item.id }) };
	}

	it("notifies for every write to an entry, naming the author and publication date it writes", async () => {
		const { item, room } = await createPost();
		const later = new Date(Date.now() + 86_400_000).toISOString();

		await repo.update("post", item.id, { data: { title: "Columns" } });
		expect(await notifier.rooms()).toEqual([[room, []]]);
		await repo.update("post", item.id, { authorId: "user_1", publishedAt: later });
		expect(await notifier.rooms()).toEqual([[room, ["author", "publishedAt"]]]);
		await repo.updateDraftAware("post", item.id, { data: { title: "Draft" }, authorId: "user_2" });
		expect(await notifier.rooms()).toEqual([[room, ["author"]]]);
		await repo.schedule("post", item.id, later);
		await repo.unschedule("post", item.id);
		expect(await notifier.rooms()).toEqual([
			[room, []],
			[room, []],
		]);
		await repo.publish("post", item.id);
		expect(await notifier.rooms()).toEqual([[room, ["publishedAt"]]]);
		await repo.unpublish("post", item.id);
		expect(await notifier.rooms()).toEqual([[room, []]]);
	});

	it("notifies for draft and revision writes", async () => {
		const { item, room } = await createPost();
		const revisions = new RevisionRepository(ctx.db);
		const revision = await revisions.create({
			collection: "post",
			entryId: item.id,
			data: { title: "Staged" },
		});

		await repo.setDraftRevision("post", item.id, revision.id);
		await repo.discardDraft("post", item.id);
		await repo.restoreDraftRevision("post", item.id, { title: "Restored draft" }, "user_1");
		await repo.restoreRevision("post", item.id, { title: "Restored" }, "user_1");

		expect(await notifier.rooms()).toEqual([
			[room, []],
			[room, []],
			[room, []],
			[room, []],
		]);
	});

	it("notifies for Trash, a restore by slug and a permanent delete", async () => {
		const { item, room } = await createPost("trashed");

		await repo.delete("post", item.id);
		await repo.restore("post", "trashed");
		await repo.delete("post", item.id);
		await repo.permanentDelete("post", item.id);

		expect(await notifier.rooms()).toEqual([
			[room, []],
			[room, []],
			[room, []],
			[room, []],
		]);
	});

	it("doesn't notify for writes that change no row", async () => {
		const { item } = await createPost();
		await repo.delete("post", item.id);
		await notifier.take();

		await repo.delete("post", item.id);
		await expect(repo.update("post", item.id, { data: { title: "Gone" } })).rejects.toThrow();

		expect(await notifier.rooms()).toEqual([]);
	});

	it("notifies the sibling locales whose values a sync copies, not the source", async () => {
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "code",
			label: "Code",
			type: "string",
			translatable: false,
		});
		const en = await createPost("en");
		const fr = await createPost("fr", { locale: "fr", translationOf: en.item.id });
		const group = en.item.translationGroup;
		if (!group) throw new Error("No translation group");

		await repo.syncNonTranslatableFields("post", en.item.id, group, { code: "A1" });

		expect(await notifier.rooms()).toEqual([[fr.room, []]]);
	});

	async function relatePostsToPages() {
		await new RelationRepository(ctx.db).create({
			slug: "post_related_pages",
			parentCollection: "post",
			childCollection: "page",
			parentLabel: "Posts",
			childLabel: "Related pages",
		});
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "related",
			label: "Related",
			type: "reference",
			validation: {
				relation: "post_related_pages",
				relationSide: "parent",
				targetCollection: "page",
			},
		});
		return createTestRuntime(ctx.db);
	}

	async function createPage(
		slug: string,
		options: { locale?: string; translationOf?: string } = {},
	) {
		const item = await repo.create({ type: "page", data: { title: slug }, slug, ...options });
		return { item, room: roomId({ collection: "page", id: item.id }) };
	}

	it("names references when an update selects them and when publishing promotes them to every locale", async () => {
		const runtime = await relatePostsToPages();
		const page = await handleContentCreate(ctx.db, "page", {
			data: { title: "Page" },
			slug: "page",
		});
		if (!page.success) throw new Error(page.error.message);
		const { item, room } = await createPost();
		const fr = await createPost("hello-fr", { locale: "fr", translationOf: item.id });

		const updated = await runtime.handleContentUpdate("post", item.id, {
			references: { related: [page.data.item.id] },
		});
		expect(updated.success).toBe(true);
		expect(await notifier.rooms()).toEqual([
			[room, []],
			[room, ["references"]],
		]);

		const published = await runtime.handleContentPublish("post", item.id);
		expect(published.success).toBe(true);
		const byRoom = new Map(await notifier.rooms());
		expect(byRoom).toEqual(
			new Map([
				[room, ["publishedAt", "references"]],
				[fr.room, ["references"]],
				[roomId({ collection: "page", id: page.data.item.id }), ["references"]],
			]),
		);
	});

	it("names references in every locale on the other end of a published selection, added or removed", async () => {
		const runtime = await relatePostsToPages();
		const first = await createPage("first");
		const firstFr = await createPage("first-fr", { locale: "fr", translationOf: first.item.id });
		const second = await createPage("second");
		const { item } = await createPost();
		await runtime.handleContentUpdate("post", item.id, {
			references: { related: [first.item.id] },
		});
		await runtime.handleContentPublish("post", item.id);
		await notifier.take();

		await runtime.handleContentUpdate("post", item.id, {
			references: { related: [second.item.id] },
		});
		const published = await runtime.handleContentPublish("post", item.id);

		expect(published.success).toBe(true);
		const byRoom = new Map(await notifier.rooms());
		expect(byRoom.get(first.room)).toEqual(["references"]);
		expect(byRoom.get(firstFr.room)).toEqual(["references"]);
		expect(byRoom.get(second.room)).toEqual(["references"]);
	});
});
