import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { EditorialThreadRepository } from "../../src/database/repositories/editorial-threads.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const ADA = "user-ada";
const NOW = "2026-11-06T12:00:00.000Z";
const LATER = "2026-11-06T12:00:01.000Z";

let db: Kysely<Database>;
let threads: EditorialThreadRepository;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	threads = new EditorialThreadRepository(db);
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	await db
		.insertInto("users")
		.values({
			id: ADA,
			email: "ada@example.com",
			name: "Ada",
			role: 40,
			email_verified: 1,
			avatar_url: null,
			data: null,
		})
		.execute();
});

afterAll(async () => {
	await db.destroy();
});

function createThread() {
	return threads.createThread({
		collection: "post",
		entryId: "entry-1",
		anchor: { type: "entry" },
		createdBy: ADA,
		body: "Source?",
		now: NOW,
	});
}

describe("editorial thread writes on D1", () => {
	it("leaves no thread behind when its first comment can't be stored", async () => {
		await sql`
			CREATE TRIGGER fail_editorial_comment_insert
			BEFORE INSERT ON _emdash_editorial_comments
			BEGIN SELECT RAISE(ABORT, 'comment insert rejected'); END
		`.execute(db);

		await expect(createThread()).rejects.toThrow("comment insert rejected");
		expect(await db.selectFrom("_emdash_editorial_threads").select("id").execute()).toEqual([]);
	});

	it("keeps a comment live when deleting it fails partway", async () => {
		const { threadId, commentId } = await createThread();
		await threads.addComment({ threadId, authorId: ADA, body: "Here.", now: NOW });
		await sql`
			CREATE TRIGGER fail_editorial_thread_touch
			BEFORE UPDATE ON _emdash_editorial_threads
			WHEN NEW.updated_at = ${sql.lit(LATER)}
			BEGIN SELECT RAISE(ABORT, 'thread touch rejected'); END
		`.execute(db);

		await expect(threads.deleteComment({ commentId, threadId, now: LATER })).rejects.toThrow(
			"thread touch rejected",
		);
		expect((await threads.findComment(commentId))?.deletedAt).toBeNull();
	});

	it("keeps no reply when reopening its resolved thread fails", async () => {
		const { threadId } = await createThread();
		await threads.setStatus({ threadId, status: "resolved", userId: ADA, now: NOW });
		await sql`
			CREATE TRIGGER fail_editorial_thread_reopen
			BEFORE UPDATE ON _emdash_editorial_threads
			WHEN NEW.status = 'open'
			BEGIN SELECT RAISE(ABORT, 'thread reopen rejected'); END
		`.execute(db);

		await expect(
			threads.addComment({ threadId, authorId: ADA, body: "Here.", now: LATER }),
		).rejects.toThrow("thread reopen rejected");
		expect((await threads.getThread(threadId))?.comments).toHaveLength(1);
		expect((await threads.findThread(threadId))?.status).toBe("resolved");
	});

	it("reopens a resolved thread with a reply", async () => {
		const { threadId } = await createThread();
		await threads.setStatus({ threadId, status: "resolved", userId: ADA, now: NOW });

		expect(
			await threads.addComment({ threadId, authorId: ADA, body: "Here.", now: LATER }),
		).toEqual(expect.any(String));
		expect((await threads.findThread(threadId))?.status).toBe("open");
	});

	it("deletes the thread with its last live comment", async () => {
		const { threadId, commentId } = await createThread();

		expect(await threads.deleteComment({ commentId, threadId, now: LATER })).toBe(true);
		expect(await threads.findThread(threadId)).toBeNull();
		expect(await threads.findComment(commentId)).toBeNull();
	});
});
