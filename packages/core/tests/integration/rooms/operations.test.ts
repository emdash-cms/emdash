import {
	decodeMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "@emdash-cms/admin/internal/co-editing";
import { Role } from "@emdash-cms/auth";
import type { APIContext, APIRoute } from "astro";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { encodeRev } from "../../../src/api/rev.js";
import { POST as discardRoute } from "../../../src/astro/routes/api/content/[collection]/[id]/discard-draft.js";
import { POST as publishRoute } from "../../../src/astro/routes/api/content/[collection]/[id]/publish.js";
import { DELETE as unscheduleRoute } from "../../../src/astro/routes/api/content/[collection]/[id]/schedule.js";
import { POST as restoreRoute } from "../../../src/astro/routes/api/revisions/[revisionId]/restore.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { RoomRegistry, type AcceptedConnection } from "../../../src/rooms/node/registry.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import { CLOSE_CODES, roomId, type RoomConnection } from "../../../src/rooms/types.js";
import {
	connectMcpHarness,
	currentRev,
	extractText,
	isErrorResult,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const BUILD = { version: "1.0.0", commit: "abc123" };
const EDITOR = "user_editor";
const DISABLED = "user_disabled";
const ACTOR = { id: EDITOR, role: Role.EDITOR };
const FROM_ROOM = Symbol("from-room");

/** A client socket speaking the room protocol through what the registry accepted. */
class ClientSocket implements RoomConnection {
	readonly doc = new Y.Doc();
	accepted: AcceptedConnection | null = null;
	synced = false;
	closedWith: number | null = null;

	constructor() {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== FROM_ROOM) this.accepted?.receive(encodeUpdate(update));
		});
	}

	title(): unknown {
		return this.doc.getMap("fields").get("title");
	}

	/** Sends the edit to the room as a Yjs update. */
	type(title: string): void {
		this.doc.getMap("fields").set("title", title);
	}

	send(bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (message?.type === "sync-step-1") {
			queueMicrotask(() => this.accepted?.receive(encodeSyncStep2(this.doc, message.stateVector)));
		} else if (message?.type === "sync-step-2" || message?.type === "sync-update") {
			Y.applyUpdate(this.doc, message.update, FROM_ROOM);
			if (message.type === "sync-step-2") this.synced = true;
		}
	}

	close(code: number): void {
		this.closedWith ??= code;
	}
}

function paragraph(text: string, marks: string[] = []) {
	return [
		{
			_type: "block",
			_key: "a",
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: "s", text, marks }],
		},
	];
}

describeEachDialect("operations in an open room", (dialect) => {
	let ctx: DialectTestContext;
	let harness: McpHarness;
	let runtime: EmDashRuntime;
	let registry: RoomRegistry | undefined;
	let siteDown = false;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await ctx.db
			.insertInto("users")
			.values([
				{
					id: EDITOR,
					email: "editor@example.com",
					name: "Editor",
					role: Role.EDITOR,
					email_verified: 1,
					disabled: 0,
				},
				{
					id: DISABLED,
					email: "disabled@example.com",
					name: "Disabled",
					role: Role.EDITOR,
					email_verified: 1,
					disabled: 1,
				},
			])
			.execute();
		siteDown = false;
		harness = await connectMcpHarness({
			db: ctx.db,
			userId: EDITOR,
			userRole: Role.EDITOR,
			runtimeOptions: {
				createRoomHost: (owner) => {
					const site = createRoomSite((fn) => runInFreshRequestContext(() => fn(owner)));
					registry = new RoomRegistry({
						db: ctx.db,
						site: {
							...site,
							save: (entry, input) =>
								siteDown ? Promise.reject(new Error("The site is down")) : site.save(entry, input),
						},
						build: BUILD,
						// Saves run only when asked, so an edit stays unsaved until an operation saves it.
						timers: { now: () => Date.now(), set: () => () => {} },
					});
					return registry;
				},
			},
		});
		runtime = harness.runtime;
		rooms().activate();
	});

	afterEach(async () => {
		await registry?.shutdown();
		registry = undefined;
		await harness.cleanup();
		await teardownForDialect(ctx);
	});

	function rooms(): RoomRegistry {
		if (!registry) throw new Error("The runtime has no room host");
		return registry;
	}

	function createPost(title: string, data: Record<string, unknown> = {}) {
		return new ContentRepository(ctx.db).create({
			type: "post",
			data: { title, ...data },
			slug: title.toLowerCase(),
			authorId: EDITOR,
		});
	}

	async function openRoom(id: string): Promise<ClientSocket> {
		const room = roomId({ collection: "post", id });
		const row = await new ContentRepository(ctx.db).findById("post", id);
		if (!row) throw new Error(`No entry ${id}`);
		const { hash } = await runtime.getManifest();
		const issued = await rooms().issueToken(room, {
			userId: EDITOR,
			name: "Editor",
			access: "edit",
			fingerprint: { ...BUILD, hash },
			rev: encodeRev(row),
			status: row.status,
			authorId: row.authorId,
		});
		if (typeof issued !== "object" || issued === null) throw new Error(`No token: ${issued}`);
		const socket = new ClientSocket();
		socket.accepted = rooms().accept(room, issued.token, socket);
		socket.accepted?.receive(encodeSyncStep1(socket.doc));
		await vi.waitFor(() => expect(socket.synced).toBe(true));
		return socket;
	}

	/** A co-editor types once the operation's hold starts, before the operation writes. */
	function typeDuringHold(socket: ClientSocket, title: string): void {
		const host = rooms();
		const save = host.save.bind(host);
		vi.spyOn(host, "save").mockImplementation(async (...args) => {
			const held = await save(...args);
			socket.type(title);
			return held;
		});
	}

	/** The entry's row, in Trash too, and its draft values, or its live values without a draft. */
	async function stored(id: string) {
		const row = await new ContentRepository(ctx.db).findByIdIncludingTrashed("post", id);
		if (!row) throw new Error(`No entry ${id}`);
		const draft = row.draftRevisionId
			? await new RevisionRepository(ctx.db).findById(row.draftRevisionId)
			: null;
		return { row, data: draft?.data ?? row.data };
	}

	async function storedRev(id: string): Promise<string> {
		const row = await new ContentRepository(ctx.db).findById("post", id);
		if (!row) throw new Error(`No entry ${id}`);
		return encodeRev(row);
	}

	function callRoute(
		route: APIRoute,
		options: { method: string; path: string; params: Record<string, string>; userId?: string },
	): Promise<Response> {
		const url = `http://localhost/_emdash/api${options.path}`;
		return Promise.resolve(
			route({
				params: options.params,
				request: new Request(url, { method: options.method }),
				url: new URL(url),
				locals: {
					user: { id: options.userId ?? EDITOR, role: Role.EDITOR },
					emdash: harness.handlers,
				},
				cache: { enabled: false, invalidate: vi.fn() },
			} as unknown as APIContext),
		);
	}

	function publishOverRest(id: string, userId?: string): Promise<Response> {
		return callRoute(publishRoute, {
			method: "POST",
			path: `/content/post/${id}/publish`,
			params: { collection: "post", id },
			userId,
		});
	}

	it("publishes edits the room hadn't saved yet", async () => {
		const post = await createPost("Before");
		const socket = await openRoom(post.id);
		socket.type("Typed in the room");

		const published = await runtime.handleContentPublish("post", post.id, {
			actor: ACTOR,
			origin: { source: "api" },
		});

		expect(published.success).toBe(true);
		expect((await stored(post.id)).row).toMatchObject({
			status: "published",
			data: { title: "Typed in the room" },
		});
	});

	it("refuses a caller's _rev while the room holds edits it hasn't saved", async () => {
		const quiet = await createPost("Quiet");
		await openRoom(quiet.id);
		const busy = await createPost("Busy");
		const socket = await openRoom(busy.id);
		socket.type("Typed in the room");
		const options = { actor: ACTOR, origin: { source: "mcp" } } as const;

		const accepted = await runtime.handleContentPublish("post", quiet.id, {
			...options,
			_rev: await storedRev(quiet.id),
		});
		const refused = await runtime.handleContentPublish("post", busy.id, {
			...options,
			_rev: await storedRev(busy.id),
		});

		expect(accepted.success).toBe(true);
		expect(refused).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect((await stored(busy.id)).row.status).toBe("draft");
	});

	it("writes a restored revision over edits typed during the restore", async () => {
		const post = await createPost("Before");
		const revision = await new RevisionRepository(ctx.db).create({
			collection: "post",
			entryId: post.id,
			data: { title: "Restored" },
		});
		const socket = await openRoom(post.id);
		typeDuringHold(socket, "Typed during the restore");

		const restored = await runtime.handleRevisionRestore(revision.id, EDITOR, Role.EDITOR);

		expect(restored.success).toBe(true);
		await vi.waitFor(() => expect(socket.title()).toBe("Restored"));
	});

	it("discards the draft over the room's edits, saved or typed during the discard", async () => {
		const post = await createPost("Live");
		await runtime.handleContentPublish("post", post.id);
		await runtime.handleContentUpdate("post", post.id, { data: { title: "Draft" } });
		const socket = await openRoom(post.id);
		socket.type("Typed before the discard");
		typeDuringHold(socket, "Typed during the discard");

		const response = await callRoute(discardRoute, {
			method: "POST",
			path: `/content/post/${post.id}/discard-draft`,
			params: { collection: "post", id: post.id },
		});

		expect(response.status).toBe(200);
		await vi.waitFor(() => expect(socket.title()).toBe("Live"));
	});

	it("saves the room's edits before an unschedule", async () => {
		const post = await createPost("Before");
		await runtime.handleContentSchedule("post", post.id, "2099-01-01T00:00:00.000Z");
		const socket = await openRoom(post.id);
		socket.type("Typed in the room");

		const response = await callRoute(unscheduleRoute, {
			method: "DELETE",
			path: `/content/post/${post.id}/schedule`,
			params: { collection: "post", id: post.id },
		});

		expect(response.status).toBe(200);
		const { row, data } = await stored(post.id);
		expect(row.scheduledAt).toBeNull();
		expect(data.title).toBe("Typed in the room");
	});

	it("refuses to restore rich text the editor can't represent while the room is open", async () => {
		const highlighted = paragraph("Marked", ["highlight"]);
		const revisions = new RevisionRepository(ctx.db);
		const open = await createPost("Open", { content: paragraph("Plain") });
		const openRevision = await revisions.create({
			collection: "post",
			entryId: open.id,
			data: { title: "Open", content: highlighted },
		});
		const closed = await createPost("Closed", { content: paragraph("Plain") });
		const closedRevision = await revisions.create({
			collection: "post",
			entryId: closed.id,
			data: { title: "Closed", content: highlighted },
		});
		await openRoom(open.id);

		const refused = await callRoute(restoreRoute, {
			method: "POST",
			path: `/revisions/${openRevision.id}/restore`,
			params: { revisionId: openRevision.id },
		});
		const restored = await runtime.handleRevisionRestore(closedRevision.id, EDITOR, Role.EDITOR);

		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ error: { code: "ROOM_UNSUPPORTED_CONTENT" } });
		expect((await stored(open.id)).data.content).toEqual(paragraph("Plain"));
		expect(restored.success).toBe(true);
		expect((await stored(closed.id)).data.content).toEqual(highlighted);
	});

	it.each([
		["scheduled publishing", { source: "scheduler" }],
		["a plugin", { source: "plugin", pluginId: "test-plugin" }],
	] as const)("publishes the saved draft for %s, without the room", async (_name, origin) => {
		const post = await createPost("Saved");
		const socket = await openRoom(post.id);
		socket.type("Typed in the room");

		const published = await runtime.handleContentPublish("post", post.id, {
			_rev: await storedRev(post.id),
			actor: ACTOR,
			origin,
		});

		expect(published.success).toBe(true);
		expect((await stored(post.id)).row.data.title).toBe("Saved");
	});

	it("fails the operation with the status of the room's failed save", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const post = await createPost("Before");
		const socket = await openRoom(post.id);
		socket.type("Typed in the room");

		const forbidden = await publishOverRest(post.id, DISABLED);
		siteDown = true;
		const unavailable = await publishOverRest(post.id);

		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toMatchObject({ error: { code: "SITE_UNAVAILABLE" } });
		expect((await stored(post.id)).row.status).toBe("draft");
	});

	it("names the update's _rev when content_update's publish conflicts", async () => {
		const post = await createPost("Before");
		const socket = await openRoom(post.id);
		socket.type("Typed in the room");

		const result = await harness.client.callTool({
			name: "content_update",
			arguments: {
				collection: "post",
				id: post.id,
				_rev: await storedRev(post.id),
				data: { content: "Saved by the update." },
				status: "published",
			},
		});

		expect(isErrorResult(result)).toBe(true);
		expect(extractText(result)).toMatch(/^\[CONFLICT\] The fields were saved/);
		const savedRev = await currentRev(harness.client, "post", post.id);
		expect(result).toMatchObject({ _meta: { code: "CONFLICT", details: { _rev: savedRev } } });
		const { row, data } = await stored(post.id);
		expect(row.status).toBe("draft");
		expect(data.content).toEqual([expect.objectContaining({ _type: "block" })]);
	});

	it("starts the room over with deleted when the entry moves to Trash", async () => {
		const post = await createPost("Before");
		const socket = await openRoom(post.id);
		socket.type("Typed in the room");

		const result = await harness.client.callTool({
			name: "content_delete",
			arguments: { collection: "post", id: post.id },
		});

		expect(isErrorResult(result)).toBe(false);
		await vi.waitFor(() => expect(socket.closedWith).toBe(CLOSE_CODES.deleted));
		const { row, data } = await stored(post.id);
		expect(row.deletedAt).not.toBeNull();
		expect(data.title).toBe("Typed in the room");
	});
});
