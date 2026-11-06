import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleRevisionList } from "../../../src/api/handlers/revision.js";
import { GET as listRevisions } from "../../../src/astro/routes/api/content/[collection]/[id]/revisions.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ENTRY_ID = "revision-author-entry";
const contributor = { id: "user-contributor", role: Role.CONTRIBUTOR };

describeEachDialect("revision list author", (dialect) => {
	let ctx: DialectTestContext;
	let revisionIds: { none: string; ada: string; linus: string; grace: string; gone: string };

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		const timestamp = new Date().toISOString();
		await ctx.db
			.insertInto("ec_post")
			.values({
				id: ENTRY_ID,
				slug: ENTRY_ID,
				status: "draft",
				created_at: timestamp,
				updated_at: timestamp,
				version: 1,
			})
			.execute();
		await ctx.db
			.insertInto("users")
			.values([
				{ id: "user-ada", email: "ada@example.com", name: " Ada ", role: 30, email_verified: 1 },
				{ id: "user-linus", email: "linus@example.com", name: null, role: 30, email_verified: 1 },
				{ id: "user-grace", email: "grace@example.com", name: "  ", role: 30, email_verified: 1 },
				{ id: "user-gone", email: "gone@example.com", name: "Gone", role: 30, email_verified: 1 },
			])
			.execute();

		const revisions = new RevisionRepository(ctx.db);
		const create = async (title: string, authorId?: string) =>
			(await revisions.create({ collection: "post", entryId: ENTRY_ID, data: { title }, authorId }))
				.id;
		revisionIds = {
			none: await create("By nobody"),
			ada: await create("By Ada", "user-ada"),
			linus: await create("By Linus", "user-linus"),
			grace: await create("By Grace", "user-grace"),
			gone: await create("By a deleted user", "user-gone"),
		};
		await new UserRepository(ctx.db).delete("user-gone");
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function get(query = "") {
		return listRevisions({
			params: { collection: "post", id: ENTRY_ID },
			url: new URL(`http://localhost/_emdash/api/content/post/${ENTRY_ID}/revisions${query}`),
			locals: {
				emdash: {
					handleRevisionList: (collection: string, entryId: string, params: { limit?: number }) =>
						handleRevisionList(ctx.db, collection, entryId, params),
				},
				user: contributor,
			},
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal route context
		} as unknown as APIContext);
	}

	it("returns each revision's author id and display name, newest first", async () => {
		const res = await get();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: {
				items: Array<{ id: string; authorId: string | null; author: unknown }>;
				total: number;
			};
		};

		expect(body.data.total).toBe(5);
		expect(body.data.items.map(({ id, authorId, author }) => ({ id, authorId, author }))).toEqual([
			{ id: revisionIds.gone, authorId: "user-gone", author: null },
			{
				id: revisionIds.grace,
				authorId: "user-grace",
				author: { id: "user-grace", name: null },
			},
			{
				id: revisionIds.linus,
				authorId: "user-linus",
				author: { id: "user-linus", name: null },
			},
			{ id: revisionIds.ada, authorId: "user-ada", author: { id: "user-ada", name: "Ada" } },
			{ id: revisionIds.none, authorId: null, author: null },
		]);
		expect(JSON.stringify(body)).not.toContain("@example.com");
	});
});
