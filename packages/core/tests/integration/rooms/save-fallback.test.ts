import {
	decodeMessage,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "@emdash-cms/admin/internal/co-editing";
import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { encodeRev } from "../../../src/api/rev.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { RoomRegistry, type AcceptedConnection } from "../../../src/rooms/node/registry.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import { CLOSE_CODES, roomId, type RoomConnection } from "../../../src/rooms/types.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const BUILD = { version: "1.0.0", commit: "abc123" };
const EDITOR = { id: "user_editor", role: Role.EDITOR as RoleLevel };
const AUTHOR = { id: "user_author", role: Role.AUTHOR as RoleLevel };
const CONTRIBUTOR = { id: "user_contributor", role: Role.CONTRIBUTOR as RoleLevel };
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

	type(title: string): void {
		this.doc.getMap("fields").set("title", title);
	}

	requestSave(): void {
		this.accepted?.receive(encodeRoomMessage({ type: "save" }));
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

describe("saving as the next co-editor after the site refuses the actor", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;
	let registry: RoomRegistry;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values(
				[EDITOR, AUTHOR, CONTRIBUTOR].map((user) => ({
					id: user.id,
					email: `${user.id}@example.com`,
					name: user.id,
					role: user.role,
					email_verified: 1,
					disabled: 0,
				})),
			)
			.execute();
		runtime = createTestRuntime(db);
		registry = new RoomRegistry({
			db,
			site: createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime))),
			build: BUILD,
			// Saves run only when a client asks.
			timers: { now: () => Date.now(), set: () => () => {} },
		});
		registry.activate();
	});

	afterEach(async () => {
		await registry.shutdown();
		await teardownTestDatabase(db);
	});

	async function join(id: string, userId: string): Promise<ClientSocket> {
		const room = roomId({ collection: "post", id });
		const row = await new ContentRepository(db).findById("post", id);
		if (!row) throw new Error(`No entry ${id}`);
		const { hash } = await runtime.getManifest();
		const issued = await registry.issueToken(room, {
			userId,
			name: userId,
			access: "edit",
			fingerprint: { ...BUILD, hash },
			rev: encodeRev(row),
			status: row.status,
			authorId: row.authorId,
		});
		if (typeof issued !== "object" || issued === null) throw new Error(`No token: ${issued}`);
		const socket = new ClientSocket();
		socket.accepted = registry.accept(room, issued.token, socket);
		socket.accepted?.receive(encodeSyncStep1(socket.doc));
		await vi.waitFor(() => expect(socket.synced).toBe(true));
		return socket;
	}

	function find(id: string) {
		return new ContentRepository(db).findById("post", id);
	}

	/**
	 * A draft by `authorId` that the author and an editor both edit, the editor last. Then the
	 * editor is disabled and the entry is published without the room hearing of it, and the editor
	 * asks for a save.
	 */
	async function saveAfterPublish(authorId: string) {
		const post = await new ContentRepository(db).create({
			type: "post",
			data: { title: "Before" },
			slug: "shared",
			authorId,
		});
		const author = await join(post.id, authorId);
		const editor = await join(post.id, EDITOR.id);
		author.type("From the author");
		await vi.waitFor(() => expect(editor.title()).toBe("From the author"));
		editor.type("From the editor");
		await vi.waitFor(() => expect(author.title()).toBe("From the editor"));

		await db.updateTable("users").set({ disabled: 1 }).where("id", "=", EDITOR.id).execute();
		await new ContentRepository(db).update("post", post.id, {
			status: "published",
			publishedAt: new Date().toISOString(),
		});
		editor.requestSave();
		return { id: post.id, author, editor };
	}

	it("saves nothing as a co-editor whose draft-only grant ended with a publish", async () => {
		const { id, author, editor } = await saveAfterPublish(CONTRIBUTOR.id);
		await vi.waitFor(() => expect(author.closedWith).toBe(CLOSE_CODES.rejoin));
		expect(editor.closedWith).toBe(CLOSE_CODES.rejoin);
		const row = await find(id);
		expect(row?.data.title).toBe("Before");
		expect(row?.draftRevisionId).toBeNull();
	});

	it("saves as a co-editor whose own rights cover the published entry", async () => {
		const { id, editor } = await saveAfterPublish(AUTHOR.id);
		await vi.waitFor(async () => expect((await find(id))?.draftRevisionId).toBeTruthy());
		expect(editor.closedWith).toBe(CLOSE_CODES.rejoin);
		const row = await find(id);
		const draftId = row?.draftRevisionId;
		if (!draftId) throw new Error("No draft revision");
		expect(row?.data.title).toBe("Before");
		const draft = await new RevisionRepository(db).findById(draftId);
		expect(draft).toMatchObject({ authorId: AUTHOR.id, data: { title: "From the editor" } });
	});
});
