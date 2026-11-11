/**
 * The room's wire protocol. Types 0 (sync) and 1 (awareness) are y-protocols messages as
 * y-websocket sends them. Type 100 is EmDash's: a varString of JSON, then an optional
 * varUint8Array holding a Yjs snapshot.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import {
	messageYjsSyncStep1,
	messageYjsSyncStep2,
	messageYjsUpdate,
	writeSyncStep1,
	writeSyncStep2,
	writeUpdate,
} from "y-protocols/sync";
import * as Y from "yjs";

import type { AwarenessEntry, Message, Notice, OutsideValue, RoomMessage } from "./types.js";

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_ROOM = 100;

const OUTSIDE_VALUES = {
	seo: true,
	author: true,
	publishedAt: true,
	terms: true,
	bylines: true,
	references: true,
} satisfies Record<OutsideValue, true>;

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
	return encodeMessage(MESSAGE_SYNC, (encoder) => writeSyncStep1(encoder, doc));
}

/** The updates `doc` has that a replica at `stateVector` lacks, or all of them. */
export function encodeSyncStep2(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
	return encodeMessage(MESSAGE_SYNC, (encoder) => writeSyncStep2(encoder, doc, stateVector));
}

export function encodeUpdate(update: Uint8Array): Uint8Array {
	return encodeMessage(MESSAGE_SYNC, (encoder) => writeUpdate(encoder, update));
}

export function encodeAwareness(entries: readonly AwarenessEntry[]): Uint8Array {
	const update = encoding.createEncoder();
	encoding.writeVarUint(update, entries.length);
	for (const entry of entries) {
		encoding.writeVarUint(update, entry.clientId);
		encoding.writeVarUint(update, entry.clock);
		encoding.writeVarString(update, JSON.stringify(entry.state));
	}
	return encodeMessage(MESSAGE_AWARENESS, (encoder) =>
		encoding.writeVarUint8Array(encoder, encoding.toUint8Array(update)),
	);
}

export function encodeRoomMessage(message: RoomMessage): Uint8Array {
	let json: Record<string, unknown>;
	let snapshot: Uint8Array | undefined;
	switch (message.type) {
		case "welcome":
			json = { type: message.type, lineage: message.lineage, access: message.access };
			snapshot = message.snapshot;
			break;
		case "save":
			json = { type: message.type };
			break;
		case "checkpoint":
			json = { type: message.type, editedBy: message.editedBy, rev: message.rev };
			snapshot = message.snapshot;
			break;
		case "notice":
			json = { type: message.type, notice: message.notice };
			break;
	}
	return encodeMessage(MESSAGE_ROOM, (encoder) => {
		encoding.writeVarString(encoder, JSON.stringify(json));
		if (snapshot) encoding.writeVarUint8Array(encoder, snapshot);
	});
}

/** Null for anything malformed, unknown or followed by extra bytes. Payloads are copies. */
export function decodeMessage(bytes: Uint8Array): Message | null {
	try {
		const decoder = decoding.createDecoder(bytes);
		const message = readMessage(decoder);
		// lib0 reads past the end of a cut-short message into the rest of its buffer, such as a
		// pooled Node.js `Buffer`, instead of throwing, and leaves the position past the end.
		return message && !decoding.hasContent(decoder) ? message : null;
	} catch {
		return null;
	}
}

function encodeMessage(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, type);
	write(encoder);
	return encoding.toUint8Array(encoder);
}

function readMessage(decoder: decoding.Decoder): Message | null {
	switch (decoding.readVarUint(decoder)) {
		case MESSAGE_SYNC:
			return readSync(decoder);
		case MESSAGE_AWARENESS:
			return readAwareness(readBytes(decoder));
		case MESSAGE_ROOM:
			return readRoomMessage(decoder);
		default:
			return null;
	}
}

function readSync(decoder: decoding.Decoder): Message | null {
	const subtype = decoding.readVarUint(decoder);
	const payload = readBytes(decoder);
	switch (subtype) {
		case messageYjsSyncStep1:
			Y.decodeStateVector(payload);
			return { type: "sync-step-1", stateVector: payload };
		case messageYjsSyncStep2:
			return { type: "sync-step-2", update: payload };
		case messageYjsUpdate:
			return { type: "sync-update", update: payload };
		default:
			return null;
	}
}

function readAwareness(update: Uint8Array): Message | null {
	const decoder = decoding.createDecoder(update);
	const count = decoding.readVarUint(decoder);
	const entries: AwarenessEntry[] = [];
	for (let index = 0; index < count; index++) {
		const clientId = decoding.readVarUint(decoder);
		const clock = decoding.readVarUint(decoder);
		const state: unknown = JSON.parse(readString(decoder));
		if (state !== null && !isRecord(state)) return null;
		entries.push({ clientId, clock, state });
	}
	return decoding.hasContent(decoder) ? null : { type: "awareness", entries, update };
}

function readRoomMessage(decoder: decoding.Decoder): RoomMessage | null {
	const json: unknown = JSON.parse(readString(decoder));
	const snapshot = decoding.hasContent(decoder) ? readBytes(decoder) : undefined;
	if (!isRecord(json)) return null;
	switch (json.type) {
		case "welcome":
			if (!snapshot || typeof json.lineage !== "string") return null;
			if (json.access !== "edit" && json.access !== "view") return null;
			return { type: "welcome", lineage: json.lineage, access: json.access, snapshot };
		case "save":
			return snapshot ? null : { type: "save" };
		case "checkpoint":
			if (!snapshot || !isStringArray(json.editedBy) || typeof json.rev !== "string") return null;
			return { type: "checkpoint", editedBy: json.editedBy, rev: json.rev, snapshot };
		case "notice": {
			const notice = snapshot ? null : readNotice(json.notice);
			return notice ? { type: "notice", notice } : null;
		}
		default:
			return null;
	}
}

function readNotice(value: unknown): Notice | null {
	if (!isRecord(value)) return null;
	switch (value.kind) {
		case "operation":
			return typeof value.by === "string" ? { kind: "operation", by: value.by } : null;
		case "outside":
			return isStringArray(value.fields) ? { kind: "outside", fields: value.fields } : null;
		case "values":
			return isStringArray(value.values) && value.values.every(isOutsideValue)
				? { kind: "values", values: value.values }
				: null;
		case "refused":
			return typeof value.code === "string" && typeof value.message === "string"
				? { kind: "refused", code: value.code, message: value.message }
				: null;
		default:
			return null;
	}
}

function readBytes(decoder: decoding.Decoder): Uint8Array {
	return decoding.readVarUint8Array(decoder).slice();
}

function readString(decoder: decoding.Decoder): string {
	return utf8.decode(readBytes(decoder));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOutsideValue(value: string): value is OutsideValue {
	return Object.hasOwn(OUTSIDE_VALUES, value);
}
