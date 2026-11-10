import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { ApiResponseError } from "../../src/lib/api/client";
import { REMOTE } from "../../src/lib/co-editing/replica/origins";
import type { CoEditing, RoomSaveError } from "../../src/lib/co-editing/types";
import { LoopbackRoom, settle, type FakeSocket } from "./loopback-room";
import {
	FINGERPRINT,
	MANIFEST,
	resetTransportHealth,
	startSession,
	type TestSession,
} from "./session-harness";

const types = (socket: FakeSocket | undefined) => socket?.received.map((message) => message.type);
const roomView = (view: CoEditing) => {
	if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
	return view;
};
const seedTitle = (doc: Y.Doc) => doc.getMap("fields").set("title", "Hello");

let sessions: TestSession[] = [];
const open = (room: LoopbackRoom, overrides?: Parameters<typeof startSession>[1]) => {
	const session = startSession(room, overrides);
	sessions.push(session);
	return session;
};

beforeEach(resetTransportHealth);
afterEach(() => {
	for (const { session } of sessions) session.dispose();
	sessions = [];
	resetTransportHealth();
});

describe("joining and syncing", () => {
	it("sends step 1 after welcome, answers the room's step 1, and sends presence once synced", async () => {
		const room = new LoopbackRoom({ seed: seedTitle });
		const s = open(room);
		await settle();
		expect(types(room.sockets[0])).toEqual(["sync-step-1", "sync-step-2", "awareness"]);
		expect(room.sockets[0]?.url).toBe(
			`ws://${location.host}/_emdash/api/content/posts/01ENTRY/room?token=t1`,
		);
		const view = roomView(s.view());
		expect(view).toMatchObject({
			access: "edit",
			editable: true,
			offline: false,
		});
		expect(view.room.fields.get("title")).toBe("Hello");
	});

	it("sends local updates only after its sync step 2", async () => {
		const room = new LoopbackRoom({ manual: true });
		const s = open(room);
		await settle();
		const socket = room.sockets[0]!;
		socket.pumpIn(); // welcome
		expect(types(socket)).toEqual([]);
		expect(socket.outbox).toHaveLength(1);
		s.replica().doc.getMap("fields").set("title", "Early");
		expect(socket.outbox).toHaveLength(1);
		socket.pumpIn(); // the room's step 1
		s.replica().doc.getMap("fields").set("title", "Later");
		while (socket.pumpOut());
		expect(types(socket)).toEqual(["sync-step-1", "sync-step-2", "sync-update"]);
		expect(room.doc.getMap("fields").get("title")).toBe("Later");
	});

	it("sends presence only once live", async () => {
		const room = new LoopbackRoom({ manual: true });
		const s = open(room);
		await settle();
		const socket = room.sockets[0]!;
		socket.pumpIn();
		socket.pumpIn();
		while (socket.pumpOut());
		s.replica().awareness.setLocalStateField("field", "title");
		expect(types(socket)).toEqual(["sync-step-1", "sync-step-2"]);
		expect(s.view().mode).toBe("pending");
		socket.pumpIn(); // the room's step 2
		while (socket.pumpOut());
		expect(types(socket)).toEqual(["sync-step-1", "sync-step-2", "awareness"]);
		expect(s.view().mode).toBe("room");
	});

	it("as a viewer, sends only step 1 and presence", async () => {
		const room = new LoopbackRoom({ seed: seedTitle });
		room.access = "view";
		const s = open(room);
		await settle();
		s.replica().doc.getMap("fields").set("title", "Mine");
		await settle();
		expect(types(room.sockets[0])).toEqual(["sync-step-1", "awareness"]);
		expect(room.doc.getMap("fields").get("title")).toBe("Hello");
		expect(roomView(s.view())).toMatchObject({
			access: "view",
			editable: false,
		});
	});

	it("applies remote updates with the remote origin", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		const origins: unknown[] = [];
		s.replica().doc.on("afterTransaction", (transaction: Y.Transaction) =>
			origins.push(transaction.origin),
		);
		room.peer().getMap("fields").set("title", "From a peer");
		await settle();
		expect(origins).toEqual([REMOTE]);
		expect(roomView(s.view()).room.fields.get("title")).toBe("From a peer");
	});

	it("passes notices and checkpoints to the page", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		room.notice({ kind: "values", values: ["seo"] });
		const rev = room.checkpoint(undefined, ["user-1"]);
		await settle();
		expect(s.events).toEqual([
			{ kind: "values", values: ["seo"] },
			{ kind: "checkpoint", rev, editedBy: ["user-1"] },
		]);
	});
});

describe("lineage", () => {
	it("never sends anything to a room of another lineage, then joins it fresh", async () => {
		const room = new LoopbackRoom({ seed: seedTitle });
		const s = open(room);
		await settle();
		const first = s.replica();
		roomView(s.view()).room.fields.set({ title: "Covered" });
		await settle();
		room.checkpoint();
		await settle();
		expect(roomView(s.view()).room.getSaveState().covered).toBe(true);
		room.restart("lineage-2", (doc) => doc.getMap("fields").set("title", "Other"));
		await settle();
		const foreign = room.sockets[1];
		expect(foreign?.closed).toBe(true);
		expect(foreign?.received).toEqual([]);
		expect(room.doc.getMap("fields").get("title")).toBe("Other");
		expect(s.replica()).not.toBe(first);
		expect(roomView(s.view()).room.fields.get("title")).toBe("Other");
		expect(s.recoveries).toEqual([]);
	});

	it("saves uncovered edits as a recovery revision before joining another lineage", async () => {
		const room = new LoopbackRoom({ seed: seedTitle });
		const s = open(room);
		await settle();
		roomView(s.view()).room.fields.set({ title: "Unsaved", summary: "Mine" });
		await settle();
		room.restart("lineage-2");
		await settle();
		expect(room.sockets[1]?.received).toEqual([]);
		expect(s.recoveries).toEqual([
			{ data: { title: "Unsaved", summary: "Mine", body: [] }, slug: null },
		]);
		expect(s.events).toContainEqual({ kind: "recovered" });
		expect(s.view().mode).toBe("room");
	});
});

describe("closes and retries", () => {
	it("rejoins after a rejoin close with the same replica and edits", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		const replica = s.replica();
		roomView(s.view()).room.fields.set({ title: "Typed" });
		room.close(4400);
		await settle();
		expect(s.replica()).toBe(replica);
		expect(s.joins).toHaveLength(2);
		expect(roomView(s.view()).room.getSaveState().covered).toBe(false);
		expect(room.doc.getMap("fields").get("title")).toBe("Typed");
	});

	it("shows both people to each other at once after one of them rejoins", async () => {
		const room = new LoopbackRoom();
		const ana = open(room);
		const ben = open(room);
		await settle();
		const peersOf = (s: TestSession) =>
			[...s.replica().awareness.getStates().keys()].filter(
				(id) => id !== s.replica().awareness.clientID,
			);
		expect(peersOf(ana)).toEqual([ben.replica().awareness.clientID]);
		expect(peersOf(ben)).toEqual([ana.replica().awareness.clientID]);

		room.sockets[0]!.serverClose(4400);
		await settle();

		expect(ana.joins).toHaveLength(2);
		expect(peersOf(ana)).toEqual([ben.replica().awareness.clientID]);
		expect(peersOf(ben)).toEqual([ana.replica().awareness.clientID]);
	});

	it("closes the socket when the browser goes offline, and shows offline after 5 s", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		roomView(s.view()).room.fields.set({ title: "Offline edit" });
		const joins = s.joins.length;
		s.setOnline(false);
		expect(room.sockets[0]?.closed).toBe(true);
		expect(roomView(s.view())).toMatchObject({ offline: false, editable: true });
		await s.after(4999);
		expect(roomView(s.view()).offline).toBe(false);
		await s.after(1);
		const view = roomView(s.view());
		expect(view).toMatchObject({ offline: true, editable: true });
		await expect(view.room.whenCovered({ save: true })).rejects.toMatchObject({
			reason: "offline",
		});
		await s.after(60_000);
		expect(s.joins).toHaveLength(joins);
		s.setOnline(true);
		await settle();
		expect(s.joins).toHaveLength(joins + 1);
		expect(roomView(s.view()).offline).toBe(false);
		expect(room.doc.getMap("fields").get("title")).toBe("Offline edit");
	});

	it("says the room can't be reached, not that the browser is offline, while joins fail online", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		for (let attempt = 0; attempt < 10; attempt++) s.answer({ kind: "failed" });
		room.sockets[0]!.serverClose(1011);
		await settle();
		await s.after(5000);
		expect(roomView(s.view())).toMatchObject({ offline: true, unreachable: true });

		s.setOnline(false);
		expect(roomView(s.view())).toMatchObject({ offline: true, unreachable: false });
	});

	it("waits for the network when the first join fails offline, then joins the room", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "failed" });
		s.setOnline(false);
		await s.after(60_000);
		expect(s.joins).toHaveLength(1);
		expect(s.view()).toMatchObject({ mode: "pending", waiting: true });

		s.setOnline(true);
		await settle();
		expect(s.joins).toHaveLength(2);
		expect(s.view().mode).toBe("room");
	});

	it("retries once the browser is back online, even when its online event is missed", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "failed" });
		s.setOnline(false);
		await s.after(60_000);
		expect(s.joins).toHaveLength(1);

		s.setOnline(true, { event: false });
		await s.after(5000);
		expect(s.joins).toHaveLength(2);
		expect(s.view().mode).toBe("room");
	});

	it("waits for the network in a tab opened offline", async () => {
		const room = new LoopbackRoom();
		const s = open(room, { online: () => false });
		s.answer({ kind: "failed" });
		await s.after(60_000);
		expect(s.joins).toHaveLength(1);

		s.setOnline(true);
		await settle();
		expect(s.joins).toHaveLength(2);
		expect(s.view().mode).toBe("room");
	});

	it("opens in single-editor mode at once when a first join fails online", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "failed" });
		await settle();
		expect(s.joins).toHaveLength(1);
		expect(s.view()).toMatchObject({ mode: "single-editor", canJoin: true });
	});

	it("joins in single-editor mode after a browser session's third socket fails to open", async () => {
		const room = new LoopbackRoom();
		room.refuse = 3;
		const s = open(room);
		for (let retry = 0; retry < 4; retry++) await s.after(2000);
		expect(s.joins.map((request) => request.singleEditor)).toEqual([false, false, false, true]);
		expect(s.view()).toMatchObject({ mode: "single-editor", canJoin: false });
		expect(document.cookie).toContain("emdash-co-editing=failed=3&single=1");
	});

	it("never pins single-editor mode once a socket has opened", async () => {
		const room = new LoopbackRoom();
		const first = open(room);
		await settle();
		first.session.dispose();
		room.refuse = 3;
		const s = open(room);
		for (let retry = 0; retry < 4; retry++) await s.after(2000);
		expect(s.joins.every((request) => !request.singleEditor)).toBe(true);
	});

	it("doesn't count a socket closed by its own dispose", async () => {
		const room = new LoopbackRoom();
		room.stall = true;
		const s = open(room);
		await settle();
		expect(room.sockets).toHaveLength(1);
		s.session.dispose();
		await settle();
		expect(room.sockets[0]?.closed).toBe(true);
		expect(document.cookie).not.toContain("failed");
	});

	it("keeps uncovered edits in the tab when the entry is deleted, until Reload", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		roomView(s.view()).room.fields.set({ title: "Keep me" });
		room.close(4402);
		await settle();
		const view = roomView(s.view());
		expect(view).toMatchObject({ kept: "deleted", editable: true });
		await expect(view.room.whenCovered({ save: false })).rejects.toMatchObject({ reason: "gone" });
		expect(view.room.fields.get("title")).toBe("Keep me");
		view.reload();
		expect(s.reloads).toBe(1);
		expect(s.view().mode).toBe("reloading");
	});

	it("joins again in single-editor mode when the co-editing chunk fails to load, keeping Join", async () => {
		const room = new LoopbackRoom();
		let loads = 0;
		const s = open(room, {
			loadReplicaModule: () =>
				++loads === 1
					? Promise.reject(new Error("offline"))
					: import("../../src/lib/co-editing/replica/index"),
		});
		await settle();
		expect(s.joins.map((request) => request.singleEditor)).toEqual([false, true]);
		const view = s.view();
		if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
		expect(view.canJoin).toBe(true);
		view.takeOver(() => {});
		await settle();
		expect(s.view().mode).toBe("room");
	});

	it("tries a recovery revision again after a network error", async () => {
		const room = new LoopbackRoom();
		const failures = [new TypeError("Failed to fetch")];
		let attempts = 0;
		const s = open(room, {
			async saveRecovery() {
				attempts++;
				const failure = failures.shift();
				if (failure) throw failure;
			},
		});
		await settle();
		roomView(s.view()).room.fields.set({ title: "Typed" });
		s.answer({ kind: "outdated" });
		room.close(4400);
		await settle();
		expect(attempts).toBe(1);
		expect(s.view().mode).toBe("room");
		await s.after(1000);
		expect(attempts).toBe(2);
		expect(s.view().mode).toBe("reloading");
	});

	it("keeps the edits in the tab when the server refuses the recovery revision", async () => {
		const room = new LoopbackRoom();
		let attempts = 0;
		const s = open(room, {
			async saveRecovery() {
				attempts++;
				throw new ApiResponseError(413, "PAYLOAD_TOO_LARGE", "Too large");
			},
		});
		await settle();
		roomView(s.view()).room.fields.set({ title: "Typed" });
		s.answer({ kind: "outdated" });
		room.close(4400);
		await s.after(5000);
		expect(attempts).toBe(1);
		expect(roomView(s.view()).kept).toBe("recovery-failed");
	});

	it("counts edits as saved once a recovery revision holds them, before reloading as outdated", async () => {
		const room = new LoopbackRoom();
		const coveredAtReload: boolean[] = [];
		const s: TestSession = open(room, {
			reload: () => coveredAtReload.push(s.replica().editing.getSaveState().covered),
		});
		await settle();
		roomView(s.view()).room.fields.set({ title: "Typed" });
		s.answer({ kind: "outdated" });
		room.close(4400);
		await settle();
		expect(s.recoveries).toHaveLength(1);
		expect(coveredAtReload).toEqual([true]);
		expect(s.view().mode).toBe("reloading");
	});

	it("joins in single-editor mode instead of reloading when outdated twice within a minute", async () => {
		const room = new LoopbackRoom();
		const first = open(room);
		first.answer({ kind: "outdated" });
		await settle();
		expect(first.reloads).toBe(1);
		const second = open(room);
		second.answer({ kind: "outdated" });
		await settle();
		expect(second.reloads).toBe(0);
		expect(second.joins.map((request) => request.singleEditor)).toEqual([false, true]);
		expect(second.view()).toMatchObject({ mode: "single-editor", canJoin: false });
	});
});

describe("Take over and Join", () => {
	it("joins with takeover, and falls back to the lock's takeover on single-editor mode", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "locked" });
		await settle();
		const view = s.view();
		if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
		expect(view.canJoin).toBe(true);
		let fallbacks = 0;
		s.answer({ kind: "single-editor" });
		view.takeOver(() => fallbacks++);
		await settle();
		expect(s.joins.at(-1)).toMatchObject({ takeover: true, singleEditor: false });
		expect(fallbacks).toBe(1);
		const again = s.view();
		if (again.mode !== "single-editor") throw new Error("Expected single-editor mode");
		again.takeOver(() => fallbacks++);
		await settle();
		expect(s.view().mode).toBe("room");
		expect(fallbacks).toBe(1);
	});

	it("keeps a Take over through a busy room's retry, then falls back to the lock's takeover", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "locked" });
		await settle();
		const view = s.view();
		if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
		let fallbacks = 0;
		s.answer({ kind: "busy" });
		s.answer({ kind: "locked" });
		view.takeOver(() => fallbacks++);
		await settle();
		expect(fallbacks).toBe(0);
		await s.after(5000);
		expect(s.joins.map((request) => request.takeover)).toEqual([false, true, true]);
		expect(fallbacks).toBe(1);
	});

	it("takes the lock instead of reloading an out-of-date admin over unsaved form edits", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "locked" });
		await settle();
		const view = s.view();
		if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
		let fallbacks = 0;
		s.answer({ kind: "outdated" });
		view.takeOver(() => fallbacks++, { unsaved: true });
		await settle();
		expect(s.reloads).toBe(0);
		expect(fallbacks).toBe(1);
		expect(s.events).toContainEqual({ kind: "outdated" });
		expect(s.view()).toMatchObject({ mode: "single-editor", canJoin: true });

		const clean = s.view();
		if (clean.mode !== "single-editor") throw new Error("Expected single-editor mode");
		s.answer({ kind: "outdated" });
		clean.takeOver(() => fallbacks++);
		await settle();
		expect(s.reloads).toBe(1);
		expect(fallbacks).toBe(1);
	});

	it("starts in single-editor mode without a join where the host runs no rooms", async () => {
		const room = new LoopbackRoom();
		const s = startSession(room, {}, ["body"], { ...MANIFEST, coEditing: false });
		sessions.push(s);
		await settle();
		expect(s.joins).toEqual([]);
		expect(s.view()).toMatchObject({ mode: "single-editor", canJoin: true });
	});

	it("takes the lock without a join where the host runs no rooms", async () => {
		const room = new LoopbackRoom();
		const s = startSession(room, {}, ["body"], { ...MANIFEST, coEditing: false });
		sessions.push(s);
		await settle();
		const view = s.view();
		if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
		let fallbacks = 0;
		view.takeOver(() => fallbacks++);
		await settle();
		expect(s.joins).toEqual([]);
		expect(fallbacks).toBe(1);
	});

	it("falls back to the lock's takeover when a Take over's join fails or is refused", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		s.answer({ kind: "locked" });
		await settle();
		let fallbacks = 0;
		for (const outcome of [{ kind: "failed" }, { kind: "forbidden" }] as const) {
			const view = s.view();
			if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
			s.answer(outcome);
			view.takeOver(() => fallbacks++);
			await settle();
		}
		expect(s.joins.map((request) => request.takeover)).toEqual([false, true, true]);
		expect(fallbacks).toBe(2);
	});

	it("sends the fingerprint pinned at creation on every join", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		room.close(4400);
		await settle();
		s.answer({ kind: "busy" });
		room.close(4400);
		await settle();
		await s.after(5000);
		expect(s.joins.length).toBeGreaterThanOrEqual(4);
		for (const request of s.joins) expect(request.fingerprint).toEqual(FINGERPRINT);
	});
});

describe("access on a rejoin", () => {
	it("stops editing once a rejoin's welcome grants only viewing, before the sync completes", async () => {
		const room = new LoopbackRoom({ manual: true });
		const s = open(room);
		await settle();
		const first = room.sockets[0]!;
		while (first.pumpIn() || first.pumpOut());
		await settle();
		expect(roomView(s.view())).toMatchObject({ editable: true });

		room.access = "view";
		room.close(4400);
		await settle();
		const second = room.sockets.at(-1)!;
		expect(second).not.toBe(first);
		second.pumpIn(); // welcome

		expect(roomView(s.view())).toMatchObject({ access: "view", editable: false });
	});
});

describe("whenCovered rejections", () => {
	it("rejects without edit access, for a viewer's own edits", async () => {
		const room = new LoopbackRoom();
		const s = open(room);
		await settle();
		const { room: editing } = roomView(s.view());
		editing.fields.set({ title: "Mine" });
		room.access = "view";
		const waiting = editing.whenCovered({ save: false });
		room.close(4400);
		await expect(waiting).rejects.toMatchObject({
			reason: "access",
		} satisfies Partial<RoomSaveError>);
		await settle();
		expect(roomView(s.view())).toMatchObject({ kept: "access", editable: true });
	});
});
