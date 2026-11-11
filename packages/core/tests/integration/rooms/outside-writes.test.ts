import {
	decodeMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
} from "@emdash-cms/admin/internal/co-editing";
import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { encodeRev } from "../../../src/api/rev.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { runInFreshRequestContext } from "../../../src/request-context.js";
import { RoomRegistry, type AcceptedConnection } from "../../../src/rooms/node/registry.js";
import { createRoomSite } from "../../../src/rooms/site.js";
import { roomId, type RoomConnection } from "../../../src/rooms/types.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const BUILD = { version: "1.0.0", commit: "abc123" };
const EDITOR = "user_editor";
const FROM_ROOM = Symbol("from-room");

/** A client socket speaking the room protocol through what the registry accepted. */
class ClientSocket implements RoomConnection {
	readonly doc = new Y.Doc();
	accepted: AcceptedConnection | null = null;

	constructor() {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== FROM_ROOM) this.accepted?.receive(encodeUpdate(update));
		});
	}

	send(bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		if (message?.type === "sync-step-1") {
			queueMicrotask(() => this.accepted?.receive(encodeSyncStep2(this.doc, message.stateVector)));
		} else if (message?.type === "sync-step-2" || message?.type === "sync-update") {
			Y.applyUpdate(this.doc, message.update, FROM_ROOM);
		}
	}

	close(): void {}
}

describe("outside writes reaching an open room", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;
	let registry: RoomRegistry;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		await db
			.insertInto("users")
			.values({
				id: EDITOR,
				email: "editor@example.com",
				name: "Editor",
				role: Role.EDITOR,
				email_verified: 1,
				disabled: 0,
			})
			.execute();
		runtime = createTestRuntime(db);
		registry = new RoomRegistry({
			db,
			site: createRoomSite((fn) => runInFreshRequestContext(() => fn(runtime))),
			build: BUILD,
		});
		registry.activate();
	});

	afterEach(async () => {
		await registry.shutdown();
		await teardownTestDatabase(db);
	});

	it("merges an API update into the room's document", async () => {
		const item = await new ContentRepository(db).create({
			type: "post",
			data: { title: "Before" },
			slug: "shared",
			authorId: EDITOR,
		});
		const room = roomId({ collection: "post", id: item.id });
		const { hash } = await runtime.getManifest();
		const issued = await registry.issueToken(room, {
			userId: EDITOR,
			name: "Editor",
			access: "edit",
			fingerprint: { ...BUILD, hash },
			rev: encodeRev(item),
			status: item.status,
			authorId: item.authorId,
		});
		if (typeof issued !== "object" || issued === null) throw new Error(`No token: ${issued}`);
		const socket = new ClientSocket();
		socket.accepted = registry.accept(room, issued.token, socket);
		socket.accepted?.receive(encodeSyncStep1(socket.doc));
		const fields = socket.doc.getMap("fields");
		await vi.waitFor(() => expect(fields.get("title")).toBe("Before"));

		const updated = await runtime.handleContentUpdate("post", item.id, {
			data: { title: "From the API" },
		});
		expect(updated.success).toBe(true);

		await vi.waitFor(() => expect(fields.get("title")).toBe("From the API"));
	});
});
