import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as postReaction } from "../../../src/astro/routes/api/comments/[collection]/[contentId]/reactions.js";
import { CommentRepository } from "../../../src/database/repositories/comment.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("POST /comments/:collection/:contentId/reactions voter identity", () => {
	let db: Kysely<Database>;
	let comments: CommentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		comments = new CommentRepository(db);
		await new ContentRepository(db).create({
			id: "post-1",
			type: "post",
			slug: "post-1",
			data: { title: "Post" },
			status: "published",
			publishedAt: new Date().toISOString(),
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function approvedComment(): Promise<string> {
		const comment = await comments.create({
			collection: "post",
			contentId: "post-1",
			authorName: "Jane",
			authorEmail: "jane@example.com",
			body: "Great post!",
			status: "approved",
		});
		return comment.id;
	}

	async function like(ip: string, commentId: string) {
		const request = new Request("http://localhost/_emdash/api/comments/post/post-1/reactions", {
			method: "POST",
			headers: { "content-type": "application/json", "x-real-ip": ip },
			body: JSON.stringify({ commentId }),
		});
		const res = await postReaction({
			params: { collection: "post", contentId: "post-1" },
			request,
			locals: { emdash: { db, config: { trustedProxyHeaders: ["x-real-ip"] } } },
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
		} as unknown as APIContext);
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- test response shape
		const json = (await res.json()) as { data?: { reacted: boolean; counts: unknown } };
		return { status: res.status, reacted: json.data?.reacted, counts: json.data?.counts };
	}

	it("treats another address in the same IPv6 /64 as the same voter", async () => {
		const commentId = await approvedComment();

		expect(await like("2001:db8:bad:1::1", commentId)).toEqual({
			status: 200,
			reacted: true,
			counts: { like: 1 },
		});
		expect(await like("2001:db8:bad:1::2", commentId)).toEqual({
			status: 200,
			reacted: false,
			counts: {},
		});
	});

	it("counts voters on different IPv6 /64 networks separately", async () => {
		const commentId = await approvedComment();

		await like("2001:db8:1:1::10", commentId);
		expect((await like("2001:db8:2:1::10", commentId)).counts).toEqual({ like: 2 });
	});

	it("counts IPv4 voters by address", async () => {
		const commentId = await approvedComment();

		await like("198.51.100.7", commentId);
		expect((await like("198.51.100.8", commentId)).counts).toEqual({ like: 2 });
	});

	it("applies the reaction rate limit to a whole IPv6 /64", async () => {
		for (let host = 1; host <= 30; host++) {
			const res = await like(`2001:db8:bad:1::${host.toString(16)}`, await approvedComment());
			expect(res.status).toBe(200);
		}

		const commentId = await approvedComment();
		expect((await like("2001:db8:bad:1::1f", commentId)).status).toBe(429);
		expect((await like("2001:db8:bad:2::1", commentId)).status).toBe(200);
	});
});
