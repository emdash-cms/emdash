import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	handleEditorialCommentCreate,
	handleEditorialCommentUpdate,
	handleEditorialMentionable,
	handleEditorialThreadCreate,
	handleEditorialThreadList,
	type EditorialActor,
	type EditorialEntryRef,
} from "../../../src/api/handlers/editorial-comments.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import {
	sendEditorialCommentNotifications,
	type EditorialCommentCreated,
} from "../../../src/editorial/notifications.js";
import type { EmailPipeline } from "../../../src/plugins/email.js";
import type { EmailMessage } from "../../../src/plugins/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ADA: EditorialActor = { id: "user-ada", role: Role.CONTRIBUTOR };
const GRACE: EditorialActor = { id: "user-grace", role: Role.EDITOR };
const LIN: EditorialActor = { id: "user-lin", role: Role.AUTHOR };
const SUBSCRIBER = "user-sub";
const DISABLED = "user-disabled";

const ANCHOR = { type: "entry" } as const;
const ADMIN_BASE = "https://example.com/_emdash";

function expectData<T>(
	result: { success: true; data: T } | { success: false; error: { code: string } },
): T {
	if (!result.success) throw new Error(`Expected success, got ${result.error.code}`);
	return result.data;
}

function fakeEmail(available = true) {
	const sent: EmailMessage[] = [];
	const email = {
		isAvailable: () => available,
		send: vi.fn(async (message: EmailMessage) => {
			sent.push(message);
		}),
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- notifications use only these two methods
	return { email: email as unknown as EmailPipeline, sent };
}

describeEachDialect("editorial mentions and notifications", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let entry: EditorialEntryRef;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		db = ctx.db;
		await db
			.insertInto("users")
			.values([
				...[
					{ actor: ADA, name: "Ada Lovelace" },
					{ actor: GRACE, name: "Grace Hopper" },
					{ actor: LIN, name: "Lin 100%_real" },
				].map(({ actor, name }) => ({
					id: actor.id,
					email: `${actor.id}@example.com`,
					name,
					role: actor.role,
					email_verified: 1,
					disabled: 0,
				})),
				{
					id: SUBSCRIBER,
					email: "sub@example.com",
					name: "Sub Scriber",
					role: Role.SUBSCRIBER,
					email_verified: 1,
					disabled: 0,
				},
				{
					id: DISABLED,
					email: "gone@example.com",
					name: "Ada Disabled",
					role: Role.EDITOR,
					email_verified: 1,
					disabled: 1,
				},
			])
			.execute();
		const item = await new ContentRepository(db).create({
			type: "post",
			data: { title: "Launch post" },
			authorId: LIN.id,
		});
		entry = { collection: "post", id: item.id };
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("rejects mentions of users who can't take part, on create and on edit", async () => {
		for (const id of [SUBSCRIBER, DISABLED, "user-missing"]) {
			const result = await handleEditorialThreadCreate(db, ADA, entry, {
				anchor: ANCHOR,
				body: `Thoughts, <@${id}>?`,
			});
			expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		}

		const thread = expectData(
			await handleEditorialThreadCreate(db, ADA, entry, { anchor: ANCHOR, body: "Draft" }),
		);
		const edit = await handleEditorialCommentUpdate(
			db,
			ADA,
			entry,
			thread.id,
			thread.comments[0]!.id,
			{
				body: `cc <@${SUBSCRIBER}>`,
			},
		);
		expect(edit).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("returns mentioned users with their current names", async () => {
		await handleEditorialThreadCreate(db, ADA, entry, {
			anchor: ANCHOR,
			body: `<@${GRACE.id}> can you check this?`,
		});
		await db
			.updateTable("users")
			.set({ name: "Rear Admiral Hopper" })
			.where("id", "=", GRACE.id)
			.execute();

		const [thread] = expectData(
			await handleEditorialThreadList(db, ADA, entry, { status: "open", limit: 50 }),
		).items;

		expect(thread!.mentions).toEqual([
			{ id: GRACE.id, name: "Rear Admiral Hopper", avatarUrl: null },
		]);
	});

	it("lists mentionable users by name, without email addresses", async () => {
		const all = expectData(await handleEditorialMentionable(db, entry, ""));
		expect(all.items.map((user) => user.id)).toEqual([ADA.id, GRACE.id, LIN.id]);
		expect(JSON.stringify(all)).not.toContain("@example.com");

		const ada = expectData(await handleEditorialMentionable(db, entry, "ada"));
		expect(ada.items.map((user) => user.id)).toEqual([ADA.id]);

		const literal = expectData(await handleEditorialMentionable(db, entry, "100%_"));
		expect(literal.items.map((user) => user.id)).toEqual([LIN.id]);
		const wildcard = expectData(await handleEditorialMentionable(db, entry, "%"));
		expect(wildcard.items.map((user) => user.id)).toEqual([LIN.id]);
	});

	async function startThread(actor: EditorialActor, body: string) {
		let created: EditorialCommentCreated | undefined;
		const thread = expectData(
			await handleEditorialThreadCreate(db, actor, entry, { anchor: ANCHOR, body }, (value) => {
				created = value;
			}),
		);
		return { thread, created: created! };
	}

	async function reply(actor: EditorialActor, threadId: string, body: string) {
		let created: EditorialCommentCreated | undefined;
		expectData(
			await handleEditorialCommentCreate(db, actor, entry, threadId, { body }, (value) => {
				created = value;
			}),
		);
		return created!;
	}

	it("emails mentioned users and earlier participants, but not the author", async () => {
		const { email, sent } = fakeEmail();
		const { thread, created } = await startThread(ADA, `<@${GRACE.id}> is this claim sourced?`);

		await sendEditorialCommentNotifications(db, email, { ...created, adminBaseUrl: ADMIN_BASE });
		expect(sent.map((message) => message.to)).toEqual([`${GRACE.id}@example.com`]);
		expect(sent[0]!.subject).toBe('Ada Lovelace mentioned you on "Launch post"');
		expect(sent[0]!.text).toContain("@Grace Hopper is this claim sourced?");
		expect(sent[0]!.text).toContain(
			`${ADMIN_BASE}/admin/content/post/${entry.id}?thread=${thread.id}`,
		);

		sent.length = 0;
		const graceReply = await reply(GRACE, thread.id, `Adding <@${LIN.id}>, who wrote it.`);
		await sendEditorialCommentNotifications(db, email, { ...graceReply, adminBaseUrl: ADMIN_BASE });
		expect(
			sent
				.map((message) => [message.to, message.subject])
				.toSorted(([a], [b]) => a!.localeCompare(b!)),
		).toEqual([
			[`${ADA.id}@example.com`, 'Grace Hopper commented on "Launch post"'],
			[`${LIN.id}@example.com`, 'Grace Hopper mentioned you on "Launch post"'],
		]);
	});

	it("skips participants who can no longer comment", async () => {
		const { email, sent } = fakeEmail();
		const { thread } = await startThread(ADA, "Needs a source.");
		await db.updateTable("users").set({ role: Role.SUBSCRIBER }).where("id", "=", ADA.id).execute();

		const created = await reply(GRACE, thread.id, "Agreed.");
		const count = await sendEditorialCommentNotifications(db, email, {
			...created,
			adminBaseUrl: ADMIN_BASE,
		});

		expect(count).toBe(0);
		expect(sent).toEqual([]);
	});

	it("still saves the comment and sends nothing without an email provider", async () => {
		const { email, sent } = fakeEmail(false);
		const { thread, created } = await startThread(ADA, `<@${GRACE.id}> please look`);

		const count = await sendEditorialCommentNotifications(db, email, {
			...created,
			adminBaseUrl: ADMIN_BASE,
		});

		expect(thread.comments).toHaveLength(1);
		expect(count).toBe(0);
		expect(email.send).not.toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("doesn't call the created hook when the write is refused", async () => {
		const onCreated = vi.fn();

		await handleEditorialThreadCreate(
			db,
			ADA,
			entry,
			{ anchor: ANCHOR, body: `<@${SUBSCRIBER}>` },
			onCreated,
		);

		expect(onCreated).not.toHaveBeenCalled();
	});
});
