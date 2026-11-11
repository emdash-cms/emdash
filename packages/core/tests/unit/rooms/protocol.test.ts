import {
	MESSAGE_AWARENESS,
	MESSAGE_ROOM,
	MESSAGE_SYNC,
	decodeMessage,
	encodeAwareness,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
	type Message,
	type RoomMessage,
} from "@emdash-cms/admin/internal/co-editing";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

function docWith(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText("t").insert(0, text);
	return doc;
}

function decoded<T extends Message["type"]>(bytes: Uint8Array, type: T) {
	const message = decodeMessage(bytes);
	expect(message?.type).toBe(type);
	return message as Extract<Message, { type: T }>;
}

/** A type 100 message with an arbitrary JSON text and optional trailing parts. */
function rawRoomMessage(json: string, ...parts: Uint8Array[]): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, MESSAGE_ROOM);
	encoding.writeVarString(encoder, json);
	for (const part of parts) encoding.writeVarUint8Array(encoder, part);
	return encoding.toUint8Array(encoder);
}

function raw(write: (encoder: encoding.Encoder) => void): Uint8Array {
	const encoder = encoding.createEncoder();
	write(encoder);
	return encoding.toUint8Array(encoder);
}

const snapshot = Y.encodeSnapshot(Y.snapshot(docWith("saved")));

describe("sync messages", () => {
	it("round trips sync step 1 with the document's state vector", () => {
		const doc = docWith("hello");

		expect(decoded(encodeSyncStep1(doc), "sync-step-1").stateVector).toEqual(
			Y.encodeStateVector(doc),
		);
	});

	it("round trips sync step 2 with only what the other replica lacks", () => {
		const room = docWith("hello");
		const replica = new Y.Doc();
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(room));
		room.getText("t").insert(5, " world");

		const message = decoded(encodeSyncStep2(room, Y.encodeStateVector(replica)), "sync-step-2");
		Y.applyUpdate(replica, message.update);

		expect(replica.getText("t").toJSON()).toBe("hello world");
		expect(message.update.byteLength).toBeLessThan(Y.encodeStateAsUpdate(room).byteLength);
	});

	it("round trips an incremental update", () => {
		const room = new Y.Doc();
		const replica = new Y.Doc();
		const updates: Uint8Array[] = [];
		room.on("update", (update: Uint8Array) => updates.push(update));
		room.getMap("fields").set("title", "Hello");

		const message = decoded(encodeUpdate(updates[0]!), "sync-update");
		Y.applyUpdate(replica, message.update);

		expect(replica.getMap("fields").get("title")).toBe("Hello");
	});

	it("copies payloads out of the received buffer", () => {
		const bytes = encodeUpdate(new Uint8Array([1, 2, 3]));
		const message = decoded(bytes, "sync-update");
		bytes.fill(0);

		expect([...message.update]).toEqual([1, 2, 3]);
	});

	it("rejects a sync step 1 whose state vector doesn't decode", () => {
		const bytes = raw((encoder) => {
			encoding.writeVarUint(encoder, MESSAGE_SYNC);
			encoding.writeVarUint(encoder, 0);
			encoding.writeVarUint8Array(encoder, new Uint8Array([5, 1]));
		});

		expect(decodeMessage(bytes)).toBeNull();
	});

	it("rejects an unknown sync subtype", () => {
		const bytes = raw((encoder) => {
			encoding.writeVarUint(encoder, MESSAGE_SYNC);
			encoding.writeVarUint(encoder, 3);
			encoding.writeVarUint8Array(encoder, new Uint8Array([0]));
		});

		expect(decodeMessage(bytes)).toBeNull();
	});
});

describe("awareness messages", () => {
	it("round trips states and removals", () => {
		const entries = [
			{ clientId: 7, clock: 3, state: { user: { id: "u1", name: "Ana" }, cursor: { anchor: 1 } } },
			{ clientId: 4_294_967_295, clock: 0, state: null },
		];

		expect(decoded(encodeAwareness(entries), "awareness").entries).toEqual(entries);
	});

	it("reads what a y-protocols Awareness sends", () => {
		const awareness = new Awareness(new Y.Doc());
		awareness.setLocalState({ user: { name: "Ben" }, field: "title" });
		const bytes = raw((encoder) => {
			encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
			encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [awareness.clientID]));
		});

		expect(decoded(bytes, "awareness").entries).toEqual([
			{ clientId: awareness.clientID, clock: 1, state: { user: { name: "Ben" }, field: "title" } },
		]);
		awareness.destroy();
	});

	it("writes what a y-protocols Awareness reads", () => {
		const awareness = new Awareness(new Y.Doc());
		const decoder = decoding.createDecoder(
			encodeAwareness([{ clientId: 12, clock: 2, state: { user: { name: "Ana" } } }]),
		);
		expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AWARENESS);
		applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), "test");

		expect(awareness.getStates().get(12)).toEqual({ user: { name: "Ana" } });
		awareness.destroy();
	});

	it("keeps the raw update, which a y-protocols Awareness applies", () => {
		const sender = new Awareness(new Y.Doc());
		sender.setLocalState({ user: { name: "Ben" } });
		const update = encodeAwarenessUpdate(sender, [sender.clientID]);
		const bytes = raw((encoder) => {
			encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
			encoding.writeVarUint8Array(encoder, update);
		});
		const receiver = new Awareness(new Y.Doc());

		const message = decoded(bytes, "awareness");
		applyAwarenessUpdate(receiver, message.update, "test");

		expect(message.update).toEqual(update);
		expect(receiver.getStates().get(sender.clientID)).toEqual({ user: { name: "Ben" } });
		sender.destroy();
		receiver.destroy();
	});

	it("rejects a state that isn't an object or null", () => {
		const bytes = raw((encoder) => {
			encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
			encoding.writeVarUint8Array(
				encoder,
				raw((update) => {
					encoding.writeVarUint(update, 1);
					encoding.writeVarUint(update, 1);
					encoding.writeVarUint(update, 1);
					encoding.writeVarString(update, '"cursor"');
				}),
			);
		});

		expect(decodeMessage(bytes)).toBeNull();
	});
});

describe("room messages", () => {
	const messages: RoomMessage[] = [
		{ type: "welcome", lineage: "lineage-1", access: "edit", snapshot },
		{ type: "welcome", lineage: "lineage-1", access: "view", snapshot },
		{ type: "save" },
		{ type: "checkpoint", editedBy: ["u2", "u1"], rev: "rev-2", snapshot },
		{ type: "notice", notice: { kind: "operation", by: "u1" } },
		{ type: "notice", notice: { kind: "outside", fields: ["title", "body"] } },
		{ type: "notice", notice: { kind: "values", values: ["seo", "terms", "references"] } },
		{ type: "notice", notice: { kind: "refused", code: "VALIDATION_ERROR", message: "Too long" } },
	];

	it.each(messages.map((message) => [message.type, message] as const))(
		"round trips %s",
		(_type, message) => {
			expect(decodeMessage(encodeRoomMessage(message))).toEqual(message);
		},
	);

	it.each([
		["JSON that doesn't parse", rawRoomMessage("{")],
		["JSON that isn't an object", rawRoomMessage('["save"]')],
		["an unknown type", rawRoomMessage('{"type":"hello"}')],
		[
			"a welcome without a snapshot",
			rawRoomMessage('{"type":"welcome","lineage":"l","access":"edit"}'),
		],
		[
			"a welcome with an unknown access level",
			rawRoomMessage('{"type":"welcome","lineage":"l","access":"admin"}', snapshot),
		],
		["a welcome without a lineage", rawRoomMessage('{"type":"welcome","access":"edit"}', snapshot)],
		["a save with a snapshot", rawRoomMessage('{"type":"save"}', snapshot)],
		[
			"a checkpoint without a snapshot",
			rawRoomMessage('{"type":"checkpoint","editedBy":[],"rev":"r"}'),
		],
		[
			"a checkpoint with a non-string editor",
			rawRoomMessage('{"type":"checkpoint","editedBy":["u1",2],"rev":"r"}', snapshot),
		],
		["a checkpoint without a rev", rawRoomMessage('{"type":"checkpoint","editedBy":[]}', snapshot)],
		[
			"a notice with a snapshot",
			rawRoomMessage('{"type":"notice","notice":{"kind":"operation","by":"u1"}}', snapshot),
		],
		["a notice of an unknown kind", rawRoomMessage('{"type":"notice","notice":{"kind":"party"}}')],
		["a notice that isn't an object", rawRoomMessage('{"type":"notice","notice":"saved"}')],
		[
			"a values notice naming an unknown value",
			rawRoomMessage('{"type":"notice","notice":{"kind":"values","values":["seo","title"]}}'),
		],
		[
			"a refused notice without a message",
			rawRoomMessage('{"type":"notice","notice":{"kind":"refused","code":"X"}}'),
		],
		[
			"bytes after the snapshot",
			rawRoomMessage(
				'{"type":"welcome","lineage":"l","access":"edit"}',
				snapshot,
				new Uint8Array([1]),
			),
		],
		[
			"JSON that isn't UTF-8",
			raw((encoder) => {
				encoding.writeVarUint(encoder, MESSAGE_ROOM);
				encoding.writeVarUint8Array(encoder, new Uint8Array([0x7b, 0xff, 0x7d]));
			}),
		],
	])("rejects %s", (_name, bytes) => {
		expect(decodeMessage(bytes)).toBeNull();
	});

	it("rejects a message cut short, even when its buffer holds the missing bytes", () => {
		const whole = encodeRoomMessage({ type: "welcome", lineage: "l", access: "edit", snapshot });

		expect(decodeMessage(whole.subarray(0, whole.length - 1))).toBeNull();
	});
});

describe("message framing", () => {
	it("rejects empty messages, unknown types and extra bytes", () => {
		expect(decodeMessage(new Uint8Array(0))).toBeNull();
		expect(decodeMessage(new Uint8Array([2, 0]))).toBeNull();
		const update = encodeUpdate(new Uint8Array([1]));
		expect(decodeMessage(new Uint8Array([...update, 0]))).toBeNull();
	});
});
