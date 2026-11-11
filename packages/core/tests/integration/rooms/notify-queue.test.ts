import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { withTransaction } from "../../../src/database/transaction.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { setRoomNotifier } from "../../../src/rooms/notifications.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import { roomId, type EntryRef, type RoomSite } from "../../../src/rooms/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { RecordingNotifier } from "../../utils/room-notifier.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = "user_editor";

describeEachDialect("Room notification queue", (dialect) => {
	let ctx: DialectTestContext;
	let notifier: RecordingNotifier;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		notifier = new RecordingNotifier();
		setRoomNotifier(notifier);
	});

	afterEach(async () => {
		setRoomNotifier(null);
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	async function createEntry(
		collection = "post",
		options: { slug?: string; locale?: string; translationOf?: string } = {},
	) {
		const item = await new ContentRepository(ctx.db).create({
			type: collection,
			data: { title: "Hello" },
			slug: options.slug ?? `entry-${crypto.randomUUID()}`,
			...options,
		});
		await notifier.take();
		const entry: EntryRef = { collection, id: item.id };
		return { item, entry, room: roomId(entry) };
	}

	it("notifies at once for a write outside any transaction", async () => {
		const { item, room } = await createEntry();

		await new ContentRepository(ctx.db).update("post", item.id, { data: { title: "Now" } });
		await waitForDeferredTasks();

		expect(notifier.calls).toEqual([{ roomId: room, outside: [], commits: 0 }]);
	});

	it("sends one notification per room, merged, once the outermost transaction commits", async () => {
		const a = await createEntry();
		const b = await createEntry();
		const db = notifier.observeCommits(ctx.db);

		await withTransaction(db, async (trx) => {
			await new ContentRepository(trx).update("post", a.item.id, { data: { title: "One" } });
			await withTransaction(trx, async (inner) => {
				const repo = new ContentRepository(inner);
				await repo.update("post", a.item.id, { authorId: "user_1" });
				await repo.update("post", b.item.id, { data: { title: "Two" } });
			});
			await waitForDeferredTasks();
			expect(notifier.calls).toEqual([]);
		});

		expect(await notifier.take()).toEqual([
			{ roomId: a.room, outside: ["author"], commits: 1 },
			{ roomId: b.room, outside: [], commits: 1 },
		]);
	});

	it("still notifies when the transaction throws", async () => {
		const { item, room } = await createEntry();

		await expect(
			withTransaction(ctx.db, async (trx) => {
				await new ContentRepository(trx).update("post", item.id, { data: { title: "Lost" } });
				throw new Error("Refused");
			}),
		).rejects.toThrow("Refused");

		expect(await notifier.rooms()).toEqual([[room, []]]);
	});

	describe("room saves", () => {
		let site: RoomSite;

		beforeEach(async () => {
			await ctx.db
				.insertInto("users")
				.values({
					id: EDITOR,
					email: "editor@example.com",
					name: "Editor",
					role: Role.EDITOR,
					email_verified: 1,
					disabled: 0,
				})
				.execute();
			const runtime = createTestRuntime(ctx.db);
			site = createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime)));
		});

		async function save(target: { entry: EntryRef }, data: object) {
			const loaded = await site.load(target.entry);
			if (!loaded) throw new Error("The entry is gone");
			return site.save(target.entry, {
				actorId: EDITOR,
				rev: loaded.rev,
				data: { ...data },
				kept: false,
				editedBy: [EDITOR],
			});
		}

		it("don't notify the room that saved", async () => {
			const post = await createEntry();

			expect(await save(post, { title: "From the room" })).toMatchObject({ ok: true });

			expect(await notifier.rooms()).toEqual([]);
		});

		it("notify the rooms of sibling locales they copy values into", async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
			const registry = new SchemaRegistry(ctx.db);
			await registry.createCollection({ slug: "note", label: "Notes", supports: [] });
			await registry.createField("note", { slug: "title", label: "Title", type: "string" });
			await registry.createField("note", {
				slug: "code",
				label: "Code",
				type: "string",
				translatable: false,
			});
			const en = await createEntry("note");
			const fr = await createEntry("note", { locale: "fr", translationOf: en.item.id });

			await save(en, { code: "B2" });

			expect(await notifier.rooms()).toEqual([[fr.room, []]]);
		});
	});
});
