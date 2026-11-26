import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleRevisionEditors } from "../../../src/api/handlers/revision.js";
import { GET as listEditors } from "../../../src/astro/routes/api/content/[collection]/[id]/revisions/editors.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ENTRY_ID = "revision-editors-entry";
const ada = { id: "user-ada", name: "Ada" };
const linus = { id: "user-linus", name: "Linus" };
const grace = { id: "user-grace", name: "Grace" };

describeEachDialect("revision editors", (dialect) => {
	let ctx: DialectTestContext;
	let revisions: RevisionRepository;

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
			.values(
				[ada, linus, grace, { id: "user-gone", name: "Gone" }].map(({ id, name }) => ({
					id,
					name,
					email: `${id}@example.com`,
					role: 30,
					email_verified: 1,
				})),
			)
			.execute();
		revisions = new RevisionRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	const save = async (authorId: string | undefined, editedBy?: string[]) =>
		(
			await revisions.create({
				collection: "post",
				entryId: ENTRY_ID,
				data: { title: "Hello" },
				authorId,
				editedBy,
			})
		).id;

	function get(since: string | null, user: { id: string; role: RoleLevel }) {
		const query = since ? `?since=${since}` : "";
		return listEditors({
			params: { collection: "post", id: ENTRY_ID },
			url: new URL(
				`http://localhost/_emdash/api/content/post/${ENTRY_ID}/revisions/editors${query}`,
			),
			locals: {
				emdash: {
					handleRevisionEditors: (collection: string, entryId: string, from: string | null) =>
						handleRevisionEditors(ctx.db, collection, entryId, from),
				},
				user,
			},
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal route context
		} as unknown as APIContext);
	}

	async function editors(since: string | null) {
		const res = await get(since, { id: "user-author", role: Role.AUTHOR });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { items: unknown[] } };
		return body.data.items;
	}

	it("names everyone in the revisions newer than `since`, newest first and once each", async () => {
		await save("user-grace");
		const live = await save("user-grace");
		await save("user-linus", ["user-linus", "user-ada"]);
		await save("user-ada");

		expect(await editors(live)).toEqual([ada, linus]);
		expect(await editors(null)).toEqual([ada, linus, grace]);
	});

	it("names no one for a revision that records no one, and a deleted account once", async () => {
		const live = await save("user-grace");
		await save("user-gone", ["user-gone", "user-ada"]);
		await save(undefined);
		await save("user-gone");
		await new UserRepository(ctx.db).delete("user-gone");

		expect(await editors(live)).toEqual([null, ada]);
	});

	it("names everyone, however many sets of editors there are", async () => {
		const ids = Array.from({ length: 101 }, (_, index) => `user-${String(index).padStart(3, "0")}`);
		await ctx.db
			.insertInto("users")
			.values(
				ids.map((id) => ({
					id,
					name: id,
					email: `${id}@example.com`,
					role: 30,
					email_verified: 1,
				})),
			)
			.execute();
		for (const id of ids) {
			await save(id);
			await save(id);
		}

		const named = await editors(null);

		expect(named).toEqual(ids.toReversed().map((id) => ({ id, name: id })));
	});

	it("is refused to a Subscriber", async () => {
		const res = await get(null, { id: "user-subscriber", role: Role.SUBSCRIBER });
		expect(res.status).toBe(403);
	});
});
