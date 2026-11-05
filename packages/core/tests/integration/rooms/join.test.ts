import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { mapErrorStatus } from "../../../src/api/errors.js";
import { handleRoomJoin, type RoomJoinInput } from "../../../src/api/handlers/rooms.js";
import { encodeRev } from "../../../src/api/rev.js";
import { POST as joinRoute } from "../../../src/astro/routes/api/content/[collection]/[id]/room.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EntryLockRepository } from "../../../src/database/repositories/entry-locks.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import type { Fingerprint, RoomHost, TokenClaims } from "../../../src/rooms/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type Issued = Awaited<ReturnType<RoomHost["issueToken"]>>;

const EDITOR = { id: "user_editor", role: Role.EDITOR as RoleLevel, name: "Eddie" };
const AUTHOR = { id: "user_author", role: Role.AUTHOR as RoleLevel, name: null };
const CONTRIBUTOR = { id: "user_contributor", role: Role.CONTRIBUTOR as RoleLevel, name: "Cora" };
const SUBSCRIBER = { id: "user_subscriber", role: Role.SUBSCRIBER as RoleLevel, name: "Sam" };
const USERS = [EDITOR, AUTHOR, CONTRIBUTOR, SUBSCRIBER];

/** Answers each token request with the next result, repeating the last. */
function fakeRooms(...results: Issued[]) {
	const queue = results.length > 0 ? [...results] : [{ token: "token-1" }];
	return {
		issueToken: vi.fn(
			async (_roomId: string, _claims: TokenClaims): Promise<Issued> =>
				queue.length > 1 ? queue.shift()! : queue[0]!,
		),
		isOpen: vi.fn(async () => false),
		save: vi.fn(async () => null),
		release: vi.fn(async () => {}),
		notify: vi.fn(async () => {}),
		forgetTokens: vi.fn(async () => {}),
	} satisfies RoomHost;
}

describeEachDialect("room join", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let fingerprint: Fingerprint;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await ctx.db
			.insertInto("users")
			.values(
				USERS.map((user) => ({
					id: user.id,
					email: `${user.id}@example.com`,
					name: user.name,
					role: user.role,
					email_verified: 1,
				})),
			)
			.execute();
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "note", label: "Notes", supports: [] });
		await registry.createField("note", { slug: "title", label: "Title", type: "string" });
		runtime = createTestRuntime(ctx.db);
		const manifest = await runtime.getManifest();
		fingerprint = { version: manifest.version, commit: manifest.commit ?? "", hash: manifest.hash };
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function createEntry(
		options: { collection?: string; status?: string; authorId?: string; slug?: string } = {},
	) {
		return new ContentRepository(ctx.db).create({
			type: options.collection ?? "post",
			data: { title: "Original" },
			slug: options.slug ?? `entry-${Math.random().toString(36).slice(2, 8)}`,
			status: options.status ?? "draft",
			authorId: options.authorId ?? AUTHOR.id,
		});
	}

	function join(
		rooms: RoomHost | null,
		entry: { id: string },
		overrides: Partial<Omit<RoomJoinInput, "body" | "user">> & {
			user?: (typeof USERS)[number];
			body?: Partial<RoomJoinInput["body"]>;
		} = {},
	) {
		const { user = EDITOR, body, ...rest } = overrides;
		return handleRoomJoin(ctx.db, rooms, {
			collection: "post",
			id: entry.id,
			playground: false,
			basePath: "",
			getManifest: () => runtime.getManifest(),
			...rest,
			user: { email: `${user.id}@example.com`, ...user },
			body: { fingerprint, ...body },
		});
	}

	async function giveLockTo(entryId: string, userId: string, collection = "post") {
		await new EntryLockRepository(ctx.db).acquire({
			collection,
			entryId,
			userId,
			token: `tab-${userId}`,
			leaseSeconds: 300,
		});
	}

	it("gives co-editors a room on the join route's own path, with the checked entry", async () => {
		const entry = await createEntry({ slug: "hello" });
		const rooms = fakeRooms({ token: "secret" });

		const result = await join(rooms, { id: "hello" }, { basePath: "/blog" });

		expect(result).toEqual({
			success: true,
			data: {
				mode: "room",
				url: `/blog/_emdash/api/content/post/${entry.id}/room`,
				token: "secret",
				access: "edit",
			},
		});
		expect(rooms.issueToken).toHaveBeenCalledWith(`post:${entry.id}`, {
			userId: EDITOR.id,
			name: "Eddie",
			access: "edit",
			fingerprint,
			rev: encodeRev(entry),
			status: "draft",
			authorId: AUTHOR.id,
		});
	});

	it("joins users without edit access as viewers, named by their email when they have no name", async () => {
		const entry = await createEntry({ authorId: EDITOR.id });
		const rooms = fakeRooms();

		expect(await join(rooms, entry, { user: CONTRIBUTOR })).toMatchObject({
			data: { mode: "room", access: "view" },
		});
		expect(rooms.issueToken.mock.calls[0]?.[1]).toMatchObject({ access: "view", name: "Cora" });

		await join(rooms, await createEntry(), { user: AUTHOR });
		expect(rooms.issueToken.mock.calls[1]?.[1]).toMatchObject({
			access: "edit",
			name: "user_author@example.com",
		});
	});

	it("refuses users without content:read_drafts and entries in Trash", async () => {
		const entry = await createEntry();
		const rooms = fakeRooms();
		expect(await join(rooms, entry, { user: SUBSCRIBER })).toMatchObject({
			success: false,
			error: { code: "FORBIDDEN" },
		});

		await new ContentRepository(ctx.db).delete("post", entry.id);
		expect(await join(rooms, entry)).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});
		expect(rooms.issueToken).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for a collection that doesn't exist", async () => {
		const entry = await createEntry();
		const rooms = fakeRooms();
		expect(await join(rooms, entry, { collection: "missing" })).toMatchObject({
			success: false,
			error: { code: "NOT_FOUND" },
		});
	});

	it.each([
		["co-editing is off or the host can't run rooms", { rooms: null }],
		["the collection has no revisions", { collection: "note" }],
		["the session is a playground", { playground: true }],
	] as const)("gives single-editor mode when %s", async (_label, condition) => {
		const entry = await createEntry({ collection: "collection" in condition ? "note" : "post" });
		const rooms = fakeRooms();

		const result = await join("rooms" in condition ? null : rooms, entry, {
			...("collection" in condition ? { collection: "note" } : {}),
			...("playground" in condition ? { playground: true } : {}),
		});

		expect(result).toEqual({ success: true, data: { mode: "single-editor" } });
		expect(rooms.issueToken).not.toHaveBeenCalled();
	});

	it("gives single-editor mode to a caller who holds the entry's user lock, and keeps it", async () => {
		const entry = await createEntry();
		await giveLockTo(entry.id, EDITOR.id);
		const rooms = fakeRooms();

		expect(await join(rooms, entry)).toEqual({ success: true, data: { mode: "single-editor" } });
		expect(rooms.issueToken).not.toHaveBeenCalled();
		expect(await new EntryLockRepository(ctx.db).findLive("post", entry.id)).toMatchObject({
			userId: EDITOR.id,
		});
	});

	it("forgets the caller's tokens and warns, without the token, when the client asks for single-editor mode", async () => {
		const entry = await createEntry();
		const rooms = fakeRooms();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const result = await join(rooms, entry, { body: { singleEditor: true } });

			expect(result).toEqual({ success: true, data: { mode: "single-editor" } });
			expect(rooms.forgetTokens).toHaveBeenCalledWith(`post:${entry.id}`, EDITOR.id);
			expect(rooms.issueToken).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledTimes(1);
			const logged = String(warn.mock.calls[0]?.[0]);
			expect(logged).toMatch(/^\[co-editing\] /);
			expect(logged).toContain(`post:${entry.id}`);
			expect(logged).not.toContain("/_emdash/");
		} finally {
			warn.mockRestore();
		}
	});

	it.each([
		["the room can't store, or can't initialize from the entry"],
		["the token's build isn't the room's own"],
	])("gives single-editor mode when %s", async () => {
		const entry = await createEntry();

		expect(await join(fakeRooms(null), entry)).toEqual({
			success: true,
			data: { mode: "single-editor" },
		});
	});

	it("opens read-only when the room is at a connection limit", async () => {
		const entry = await createEntry();

		expect(await join(fakeRooms("full"), entry)).toEqual({
			success: true,
			data: { mode: "read-only" },
		});
	});

	it("refuses with ENTRY_LOCKED while another user holds a user lock, and takes it over on request", async () => {
		const entry = await createEntry();
		await giveLockTo(entry.id, AUTHOR.id);
		const rooms = fakeRooms();

		const refused = await join(rooms, entry);
		expect(refused).toMatchObject({
			success: false,
			error: {
				code: "ENTRY_LOCKED",
				message: "Another editor is holding this entry",
				details: { userId: AUTHOR.id, userName: null },
			},
		});
		expect(rooms.issueToken).not.toHaveBeenCalled();

		const viewer = await join(rooms, entry, { user: CONTRIBUTOR, body: { takeover: true } });
		expect(viewer).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
		const locks = new EntryLockRepository(ctx.db);
		expect(await locks.findLive("post", entry.id)).toMatchObject({ userId: AUTHOR.id });

		const takeover = await join(rooms, entry, { body: { takeover: true } });
		expect(takeover).toMatchObject({ success: true, data: { mode: "room", access: "edit" } });
		expect(await locks.findLive("post", entry.id)).toBeNull();
	});

	it.each([
		["the client is outdated", fakeRooms(), { version: "other" }],
		["the room is busy", fakeRooms("busy"), {}],
		["the room can't open", fakeRooms(null), {}],
		["the room is full", fakeRooms("full"), {}],
	] as const)(
		"keeps another user's lock when a takeover gets no room because %s",
		async (_, rooms, stale) => {
			const entry = await createEntry();
			await giveLockTo(entry.id, AUTHOR.id);

			const result = await join(rooms, entry, {
				body: { takeover: true, fingerprint: { ...fingerprint, ...stale } },
			});

			expect(result).not.toMatchObject({ success: true, data: { mode: "room" } });
			expect(await new EntryLockRepository(ctx.db).findLive("post", entry.id)).toMatchObject({
				userId: AUTHOR.id,
			});
		},
	);

	it("ignores another user's lock on a collection that takes no edit locks", async () => {
		const entry = await createEntry();
		await giveLockTo(entry.id, AUTHOR.id);
		await ctx.db.updateTable("_emdash_collections").set({ edit_locking: 0 }).execute();

		expect(await join(fakeRooms(), entry)).toMatchObject({
			success: true,
			data: { mode: "room" },
		});
	});

	it("answers ROOM_BUSY, a 409, while another process holds the claim or this one shuts down", async () => {
		const entry = await createEntry();

		const result = await join(fakeRooms("busy"), entry);

		expect(result).toMatchObject({ success: false, error: { code: "ROOM_BUSY" } });
		expect(mapErrorStatus("ROOM_BUSY")).toBe(409);
	});

	it.each(["version", "commit", "hash"] as const)(
		"answers CLIENT_OUTDATED, a 409, when the fingerprint's %s differs",
		async (key) => {
			const entry = await createEntry();
			const rooms = fakeRooms();

			const result = await join(rooms, entry, {
				body: { fingerprint: { ...fingerprint, [key]: "other" } },
			});

			expect(result).toMatchObject({ success: false, error: { code: "CLIENT_OUTDATED" } });
			expect(mapErrorStatus("CLIENT_OUTDATED")).toBe(409);
			expect(rooms.issueToken).not.toHaveBeenCalled();
		},
	);

	it("checks access again once when the room finds the entry changed", async () => {
		const entry = await createEntry({ authorId: CONTRIBUTOR.id });
		const repo = new ContentRepository(ctx.db);
		const rooms = fakeRooms({ token: "second" });
		rooms.issueToken.mockImplementationOnce(async () => {
			await repo.update("post", entry.id, { status: "published" });
			return "stale";
		});

		const result = await join(rooms, entry, { user: CONTRIBUTOR });

		expect(result).toMatchObject({
			success: true,
			data: { mode: "room", token: "second", access: "view" },
		});
		expect(rooms.issueToken).toHaveBeenCalledTimes(2);
		expect(rooms.issueToken.mock.calls[0]?.[1]).toMatchObject({ access: "edit", status: "draft" });
		const published = await repo.findById("post", entry.id);
		expect(rooms.issueToken.mock.calls[1]?.[1]).toMatchObject({
			access: "view",
			status: "published",
			rev: encodeRev(published!),
		});
	});

	it("answers ROOM_BUSY when the room finds the entry changed twice", async () => {
		const entry = await createEntry();
		const rooms = fakeRooms("stale");

		expect(await join(rooms, entry)).toMatchObject({
			success: false,
			error: { code: "ROOM_BUSY" },
		});
		expect(rooms.issueToken).toHaveBeenCalledTimes(2);
	});
});

describeEachDialect("room join route", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		runtime = createTestRuntime(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function callRoute(
		rooms: RoomHost,
		entryId: string,
		body: unknown,
		options: { tokenScopes?: string[] } = {},
	): Promise<Response> {
		const url = new URL(`http://localhost/_emdash/api/content/post/${entryId}/room`);
		return joinRoute({
			params: { collection: "post", id: entryId },
			request: new Request(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify(body),
			}),
			url,
			locals: {
				user: { id: EDITOR.id, role: EDITOR.role, name: EDITOR.name, email: "eddie@example.com" },
				tokenScopes: options.tokenScopes,
				emdash: { db: ctx.db, rooms, getManifest: () => runtime.getManifest() },
			},
		} as never);
	}

	it("joins with a session, and answers 409 for an outdated client", async () => {
		const entry = await new ContentRepository(ctx.db).create({
			type: "post",
			data: { title: "Original" },
			authorId: EDITOR.id,
		});
		const manifest = await runtime.getManifest();
		const fingerprint = { version: manifest.version, commit: manifest.commit, hash: manifest.hash };

		const joined = await callRoute(fakeRooms({ token: "secret" }), entry.id, { fingerprint });
		expect(joined.status).toBe(200);
		expect(await joined.json()).toMatchObject({
			data: { mode: "room", url: `/_emdash/api/content/post/${entry.id}/room`, token: "secret" },
		});

		const outdated = await callRoute(fakeRooms(), entry.id, {
			fingerprint: { ...fingerprint, hash: "other" },
		});
		expect(outdated.status).toBe(409);
	});

	it("refuses API tokens before anything else, and bodies without a fingerprint", async () => {
		const rooms = fakeRooms();

		const token = await callRoute(
			rooms,
			"01JXENTRY0000000000000000",
			{},
			{
				tokenScopes: ["content:read", "content:write"],
			},
		);
		expect(token.status).toBe(403);

		const invalid = await callRoute(rooms, "01JXENTRY0000000000000000", { takeover: true });
		expect(invalid.status).toBe(400);
		expect(rooms.issueToken).not.toHaveBeenCalled();
	});
});
