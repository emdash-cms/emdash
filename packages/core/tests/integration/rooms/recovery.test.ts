import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it } from "vitest";

import { encodeRev } from "../../../src/api/rev.js";
import { POST as saveRecovery } from "../../../src/astro/routes/api/content/[collection]/[id]/revisions.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import { MAX_RECOVERY_BYTES } from "../../../src/rooms/limits.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = { id: "user_editor", role: Role.EDITOR as RoleLevel };
const AUTHOR = { id: "user_author", role: Role.AUTHOR as RoleLevel };
const CONTRIBUTOR = { id: "user_contributor", role: Role.CONTRIBUTOR as RoleLevel };

describeEachDialect("recovery revisions route", (dialect) => {
	let ctx: DialectTestContext;
	let entryId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await ctx.db
			.insertInto("users")
			.values(
				[EDITOR, AUTHOR, CONTRIBUTOR].map((user) => ({
					id: user.id,
					email: `${user.id}@example.com`,
					name: user.id,
					role: user.role,
					email_verified: 1,
				})),
			)
			.execute();
		const entry = await new ContentRepository(ctx.db).create({
			type: "post",
			data: { title: "Original" },
			slug: "original",
			status: "draft",
			authorId: AUTHOR.id,
		});
		entryId = entry.id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function post(
		body: unknown,
		options: { user?: { id: string; role: RoleLevel }; tokenScopes?: string[]; id?: string } = {},
	): Promise<Response> {
		const id = options.id ?? entryId;
		const url = new URL(`http://localhost/_emdash/api/content/post/${id}/revisions`);
		return saveRecovery({
			params: { collection: "post", id },
			request: new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify(body),
			}),
			url,
			locals: {
				user: options.user ?? EDITOR,
				tokenScopes: options.tokenScopes,
				emdash: { db: ctx.db },
			},
		} as never) as Promise<Response>;
	}

	async function pointers() {
		const item = await new ContentRepository(ctx.db).findById("post", entryId);
		return {
			draft: item?.draftRevisionId,
			live: item?.liveRevisionId,
			rev: item && encodeRev(item),
		};
	}

	function recoveryRows() {
		return ctx.db
			.selectFrom("revisions")
			.select(["id", "kind", "data", "author_id", "edited_by"])
			.where("entry_id", "=", entryId)
			.where("kind", "=", "recovery")
			.execute();
	}

	it("stores the document as a recovery revision by the caller, moving no pointer", async () => {
		const before = await pointers();

		const response = await post({
			data: { title: "Unsaved", field_from_before_a_schema_change: [1, 2] },
			slug: "unsaved",
		});

		expect(response.status).toBe(201);
		const { data } = (await response.json()) as { data: { id: string } };
		const rows = await recoveryRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: data.id,
			kind: "recovery",
			author_id: EDITOR.id,
			edited_by: null,
		});
		expect(JSON.parse(rows[0]!.data)).toEqual({
			title: "Unsaved",
			field_from_before_a_schema_change: [1, 2],
			_slug: "unsaved",
		});
		expect(await pointers()).toEqual(before);
	});

	it("stores and lists datetimes as sent, even ones that don't parse", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", { slug: "starts_at", label: "Starts", type: "datetime" });
		await registry.createField("post", { slug: "ends_at", label: "Ends", type: "datetime" });
		const data = { title: "Unsaved", starts_at: "2026-11-05T10:00:00+02:00", ends_at: "next Tue" };

		const response = await post({ data, slug: "unsaved" });

		expect(response.status).toBe(201);
		const listed = await new RevisionRepository(ctx.db).findByEntry("post", entryId);
		expect(listed.find((revision) => revision.data._slug === "unsaved")?.data).toEqual({
			...data,
			_slug: "unsaved",
		});
	});

	it("saves for an entry in Trash, and a null slug", async () => {
		await new ContentRepository(ctx.db).delete("post", entryId);

		const response = await post({ data: { title: "Unsaved" }, slug: null });

		expect(response.status).toBe(201);
		const rows = await recoveryRows();
		expect(JSON.parse(rows[0]!.data)).toEqual({ title: "Unsaved", _slug: null });
	});

	it("refuses a revision over the size limit with 413", async () => {
		const response = await post({
			data: { title: "x".repeat(MAX_RECOVERY_BYTES) },
			slug: "unsaved",
		});

		expect(response.status).toBe(413);
		expect(await recoveryRows()).toEqual([]);
	});

	it.each([
		["data that isn't an object", { data: ["title"], slug: "unsaved" }],
		["no slug", { data: { title: "Unsaved" } }],
	])("refuses %s with 400", async (_label, body) => {
		expect((await post(body)).status).toBe(400);
		expect(await recoveryRows()).toEqual([]);
	});

	it("needs edit access to the entry and a signed-in session, but no lock", async () => {
		const body = { data: { title: "Unsaved" }, slug: "unsaved" };
		await ctx.db
			.insertInto("_emdash_entry_locks")
			.values({
				collection: "post",
				entry_id: entryId,
				user_id: EDITOR.id,
				token: "tab",
				acquired_at: "2026-01-01T00:00:00.000Z",
				expires_at: "2999-01-01T00:00:00.000Z",
			})
			.execute();

		expect((await post(body, { user: CONTRIBUTOR })).status).toBe(403);
		expect((await post(body, { tokenScopes: ["content:read", "content:write"] })).status).toBe(403);
		expect((await post(body, { id: "01JXMISSING00000000000000" })).status).toBe(404);
		expect(await recoveryRows()).toEqual([]);

		expect((await post(body, { user: AUTHOR })).status).toBe(201);
	});
});
