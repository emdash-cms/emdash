import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import type { Database } from "../../src/database/types.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

let db: Kysely<Database>;
let comments: CommentRepository;

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);
	comments = new CommentRepository(db);
});

afterAll(async () => {
	await db.destroy();
});

function createComment(index: number) {
	return comments.create({
		collection: "post",
		contentId: "post-1",
		authorName: `Author ${index}`,
		authorEmail: `author-${index}@example.com`,
		body: `Comment ${index}`,
	});
}

describe("comment bulk status on D1", () => {
	it("updates the maximum 100 API ids with one shared timestamp and leaves other rows alone", async () => {
		const rows = await Promise.all(Array.from({ length: 101 }, (_, index) => createComment(index)));
		const updated = await comments.bulkUpdateStatus(
			rows.slice(0, 100).map((comment) => comment.id),
			"approved",
		);

		expect(updated).toBe(100);
		const stored = await db
			.selectFrom("_emdash_comments")
			.select(["id", "status", "updated_at"])
			.orderBy("id")
			.execute();
		const selected = stored.filter((row) =>
			rows.slice(0, 100).some((comment) => comment.id === row.id),
		);
		const untouched = stored.find((row) => row.id === rows[100]?.id);

		expect(selected).toHaveLength(100);
		expect(new Set(selected.map((row) => row.status))).toEqual(new Set(["approved"]));
		expect(new Set(selected.map((row) => row.updated_at)).size).toBe(1);
		expect(untouched?.status).toBe("pending");
		expect(untouched?.updated_at).toBe(rows[100]?.updatedAt);
	});

	it("handles empty, missing, and duplicate ids across a batch boundary", async () => {
		const first = await createComment(1);
		const second = await createComment(2);
		await db
			.updateTable("_emdash_comments")
			.set({ updated_at: "2020-01-01T00:00:00.000Z" })
			.where("id", "=", first.id)
			.execute();

		expect(await comments.bulkUpdateStatus([], "approved")).toBe(0);
		expect(
			await comments.bulkUpdateStatus(
				[...Array<string>(50).fill(first.id), second.id, first.id, "missing-comment"],
				"spam",
			),
		).toBe(2);

		const stored = await db
			.selectFrom("_emdash_comments")
			.select(["id", "status"])
			.where("id", "in", [first.id, second.id])
			.execute();
		expect(stored).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: first.id, status: "spam" }),
				expect.objectContaining({ id: second.id, status: "spam" }),
			]),
		);
		expect((await comments.findById(first.id))?.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
	});
});
