/**
 * Clients with the shipped editor and `ySyncPlugin`, each on its own Y document, edit one entry
 * through a `Room` over the memory store, or over room storage in a database, and the fake site,
 * from a fixed seed. Every link delivers in order and the seed only interleaves links. Rooms
 * restart, saves go unrecorded, outside writes and operations land, and at the end every client
 * rejoins and the run checks that replicas converge, checkpoints only grow, no covered word is
 * lost and no word is stored twice.
 *
 * Each inserted word is one CJK character, so no deletion can leave part of a word behind or
 * join two parts into another.
 */

import {
	readField,
	decodeMessage,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
	snapshotContains,
} from "@emdash-cms/admin/internal/co-editing";
import {
	PortableTextFilledDefaults,
	portableTextExtensions,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import { PortableTextYSync } from "@emdash-cms/admin/internal/portable-text-y-sync";
import { Editor, Extension } from "@tiptap/core";
import { ContentMatch, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { ySyncPlugin, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import type { Kysely } from "kysely";
import * as Y from "yjs";

import { timestampOffset } from "../../../src/database/repositories/entry-locks.js";
import type { Database } from "../../../src/database/types.js";
import { type DocumentField } from "../../../src/rooms/document.js";
import { hashValue } from "../../../src/rooms/hash.js";
import { KyselyRoomStore } from "../../../src/rooms/kysely-store.js";
import { CLAIM_EXPIRY_MS, OPERATION_HOLD_MS } from "../../../src/rooms/limits.js";
import { Room } from "../../../src/rooms/room.js";
import { decodeCheckpoint } from "../../../src/rooms/snapshot.js";
import {
	CLOSE_CODES,
	RoomSaveError,
	roomId,
	type CheckpointInput,
	type CloseCode,
	type EntryRef,
	type RecoveryInput,
	type RoomConnection,
	type RoomRecord,
	type RoomSite,
	type RoomStore,
	type RoomTimers,
	type SaveResult,
} from "../../../src/rooms/types.js";
import { FakeSite } from "./fake-site.js";
import { MemoryRoomStore } from "./memory-store.js";
import { BUILD, ENTRY, FINGERPRINT } from "./test-room.js";

const CLIENTS = 3;
const STEPS = 300;
const SETTLE_ROUNDS = 80;
const QUIET_ROUNDS = 5;
const SETTLE_TICK_MS = 3000;
const PLUGIN_TYPE = "callout";
const BODY = "body";
const VALUE_KEYS = ["title", "summary", "slug"] as const;
const FIELDS: DocumentField[] = [
	{ slug: "title", type: "string" },
	{ slug: "summary", type: "text" },
	{ slug: BODY, type: "portableText" },
];
const DOCUMENT_FIELDS: DocumentField[] = [...FIELDS, { slug: "slug", type: "slug" }];
const ROOM_ID = roomId(ENTRY);
const FIRST_WORD = 0x4e00;
const LAST_WORD = 0x9fff;

/** Marks a client's own applies of what the room sent, so they aren't sent back. */
const REMOTE = Symbol("remote");

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(items: readonly T[], r: number): T =>
	items[Math.min(items.length - 1, Math.floor(r * items.length))]!;

const isWord = (code: number) => code >= FIRST_WORD && code <= LAST_WORD;

function wordsIn(text: string, out: string[] = []): string[] {
	for (let index = 0; index < text.length; index++) {
		if (isWord(text.charCodeAt(index))) out.push(text[index]!);
	}
	return out;
}

/** Every word in a JSON value: span text, plugin block data and plain values alike. */
function wordsInJson(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") wordsIn(value, out);
	else if (Array.isArray(value)) for (const item of value) wordsInJson(item, out);
	else if (value && typeof value === "object") {
		for (const item of Object.values(value)) wordsInJson(item, out);
	}
	return out;
}

function countWords(values: readonly unknown[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const word of wordsInJson(values)) counts.set(word, (counts.get(word) ?? 0) + 1);
	return counts;
}

function contentWords(content: Y.Item["content"]): string[] {
	if (content instanceof Y.ContentString) return wordsIn(content.str);
	if (content instanceof Y.ContentAny) return wordsInJson(content.arr);
	if (content instanceof Y.ContentEmbed) return wordsInJson(content.embed);
	return [];
}

/** The shared document as plain JSON: rich text read without a schema, and the values map. */
function documentJson(doc: Y.Doc): { body: unknown; fields: Record<string, unknown> } {
	return {
		body: yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(`field:${BODY}`)),
		fields: doc.getMap("fields").toJSON(),
	};
}

/** The document's JSON in canonical form, so attribute order doesn't count. */
const documentHash = (doc: Y.Doc) => hashValue(JSON.parse(JSON.stringify(documentJson(doc))));

/**
 * What the run knows about every word: which a checkpoint contained, which an edit or a writer
 * outside the room removed, and how often a block rewrite copied each one.
 */
class Ledger {
	readonly seen = new Set<string>();
	readonly copies = new Map<string, number>();
	/** Removed from the room's document by a client's update: an edit or a block replacement. */
	readonly editDeleted = new Set<string>();
	/** Removed from the stored entry by an outside write or a restore. */
	readonly removedFromStore = new Set<string>();
	/** Words a checkpoint contained or a room save stored. */
	readonly covered = new Set<string>();
	readonly failures: string[] = [];
	/** Restores releasing with `overwrite`, whose merges may remove what was typed during the hold. */
	overwriting = 0;
	/** The room's document, as of the last client update it applied. */
	roomDoc: Y.Doc | null = null;

	/** What a save stored before each room write, so a merge is judged only on saved words. */
	readonly #savedBefore = new WeakMap<Y.Transaction, Set<string>>();

	fail(message: string): void {
		if (this.failures.length < 10) this.failures.push(message);
	}

	beforeObserve(transaction: Y.Transaction): void {
		if (typeof transaction.origin !== "symbol" || transaction.beforeState.size === 0) return;
		this.#savedBefore.set(transaction, new Set(savedWords(transaction.doc)));
	}

	/**
	 * Reads each transaction of every document. A client's update applied by the room is an edit,
	 * so a word it removes from the room's document was deleted by an edit. The room's own writes
	 * have symbol origins: on a document that already had content they are merges, which write
	 * stored values only into fields the document hasn't changed. A word a client's local
	 * transaction writes again is a copy, as when y-tiptap rewrites a block: concurrent rewrites
	 * keep both. A merge never copies a word.
	 */
	observe(transaction: Y.Transaction): void {
		const { origin } = transaction;
		if (origin === REMOTE) return;
		const fresh = transaction.beforeState.size === 0;
		const inserted = insertedWords(transaction);
		if (origin instanceof Link) {
			this.roomDoc = transaction.doc;
			for (const word of removedWords(transaction, inserted)) this.editDeleted.add(word);
			return;
		}
		if (typeof origin === "symbol" && !fresh && this.overwriting === 0) {
			const before = this.#savedBefore.get(transaction);
			for (const word of removedWords(transaction, inserted)) {
				if (!before?.has(word) || this.removedFromStore.has(word)) continue;
				this.fail(`a merge removed ${describe(word)}, which no outside write or restore removed`);
			}
		}
		for (const word of inserted) {
			if (!this.seen.has(word)) this.seen.add(word);
			else if (!fresh && typeof origin !== "symbol") {
				this.copies.set(word, (this.copies.get(word) ?? 0) + 1);
			}
		}
	}
}

/** Words a transaction deleted that the document no longer holds anywhere. */
function removedWords(transaction: Y.Transaction, inserted: readonly string[]): string[] {
	const deleted = new Set<string>();
	Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
		if (!(struct instanceof Y.Item)) return;
		for (const word of contentWords(struct.content)) deleted.add(word);
	});
	for (const word of inserted) deleted.delete(word);
	if (deleted.size === 0) return [];
	const present = new Set(savedWords(transaction.doc));
	return [...deleted].filter((word) => !present.has(word));
}

/**
 * The words a save of the document would store. y-tiptap can leave a stale block attribute on a
 * reused plugin block element, which the converter ignores and `documentJson` would count.
 */
function savedWords(doc: Y.Doc): string[] {
	try {
		return wordsInJson(DOCUMENT_FIELDS.map((field) => readField(doc, field)));
	} catch {
		return wordsInJson(documentJson(doc));
	}
}

function insertedWords(transaction: Y.Transaction): string[] {
	const words: string[] = [];
	for (const [client, after] of transaction.afterState) {
		const before = transaction.beforeState.get(client) ?? 0;
		if (after <= before) continue;
		const structs = transaction.doc.store.clients.get(client) ?? [];
		for (let index = structs.length - 1; index >= 0; index--) {
			const struct = structs[index]!;
			if (struct.id.clock < before) break;
			if (struct instanceof Y.Item && !struct.deleted) words.push(...contentWords(struct.content));
		}
	}
	return words;
}

let activeLedger: Ledger | null = null;
const observed = new WeakSet<Y.Doc>();
const CLIENT_ID = Symbol("clientID");

/**
 * Makes a run repeat from its seed: Yjs client IDs, which order concurrent inserts, and the
 * editor's random block keys come from the seed. Every document a run creates, the room's
 * included, reports its transactions to the ledger.
 */
function installDeterminism(seed: number): () => void {
	const ids = mulberry32(seed ^ 0x5bd1e995);
	const used = new Set<number>();
	const descriptor = Object.getOwnPropertyDescriptor(Y.Doc.prototype, "clientID");
	Object.defineProperty(Y.Doc.prototype, "clientID", {
		configurable: true,
		get(this: Y.Doc & { [CLIENT_ID]?: number }) {
			return this[CLIENT_ID];
		},
		set(this: Y.Doc & { [CLIENT_ID]?: number }, _random: number) {
			let id = Math.floor(ids() * 0xffffffff);
			while (used.has(id)) id = Math.floor(ids() * 0xffffffff);
			used.add(id);
			this[CLIENT_ID] = id;
			if (!observed.has(this)) {
				observed.add(this);
				this.on("beforeTransaction", (transaction: Y.Transaction) =>
					activeLedger?.beforeObserve(transaction),
				);
				this.on("afterTransaction", (transaction: Y.Transaction) =>
					activeLedger?.observe(transaction),
				);
			}
		},
	});
	const random = Math.random;
	Math.random = mulberry32(seed ^ 0x27d4eb2f);
	return () => {
		Math.random = random;
		if (descriptor) Object.defineProperty(Y.Doc.prototype, "clientID", descriptor);
		else delete (Y.Doc.prototype as { clientID?: number }).clientID;
	};
}

interface Timer {
	at: number;
	order: number;
	run: () => void;
	instance: RoomInstance;
	cancelled: boolean;
}

/** A clock that only moves when the run moves it. */
class VirtualClock {
	now = Date.parse("2026-11-04T12:00:00Z");
	#timers: Timer[] = [];
	#order = 0;

	timers(instance: RoomInstance): RoomTimers {
		return {
			now: () => this.now,
			set: (ms, run) => {
				if (instance.dead) return () => {};
				const timer: Timer = {
					at: this.now + ms,
					order: this.#order++,
					run,
					instance,
					cancelled: false,
				};
				this.#timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
		};
	}

	/** Moves the clock, firing due timers in order and letting each one's work run. */
	async advance(ms: number): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			this.#timers = this.#timers.filter((timer) => !timer.cancelled && !timer.instance.dead);
			let next: Timer | undefined;
			for (const timer of this.#timers) {
				if (timer.at > end) continue;
				if (!next || timer.at < next.at || (timer.at === next.at && timer.order < next.order)) {
					next = timer;
				}
			}
			if (!next) break;
			this.now = Math.max(this.now, next.at);
			next.cancelled = true;
			next.run();
			await drain();
		}
		this.now = end;
	}
}

/** Lets every queued microtask run: the room, store and site only await each other. */
async function drain(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

interface SiteCall {
	instance: RoomInstance;
	kind: "load" | "save" | "recovery";
	input?: CheckpointInput;
	run: () => Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
}

/**
 * One process running a `Room`. Once dead, its store calls and timers never resolve or fire, its
 * sockets are gone, and the site still commits what it already sent. In a takeover run its claim
 * stays until it expires.
 */
class RoomInstance {
	dead = false;
	/** When it died, on the run's clock. */
	diedAt = 0;
	readonly room: Room;

	constructor(
		run: Run,
		readonly host: string,
	) {
		this.room = new Room({
			entry: ENTRY,
			site: run.siteFor(this),
			store: run.storeFor(this),
			build: BUILD,
			timers: run.clock.timers(this),
		});
	}
}

const never = <T>() => new Promise<T>(() => {});

/** Records every checkpoint room storage holds, and the words each one contains. */
class HarnessStore {
	readonly #ledger: Ledger;
	#lineage: string | null = null;
	#checkpoint: string | null = null;
	/** Every update stored in the current lineage, without garbage collection. */
	#shadow: Y.Doc | null = null;
	writes = 0;

	constructor(ledger: Ledger) {
		this.#ledger = ledger;
	}

	get checkpoint(): Y.Snapshot | null {
		return this.#checkpoint === null ? null : decodeCheckpoint(this.#checkpoint);
	}

	/** A process's room storage, recording each write that succeeds. `stored` reads every update back. */
	track(store: RoomStore, stored: () => Uint8Array[] | Promise<Uint8Array[]>): RoomStore {
		return {
			load: () => store.load(),
			append: async (updates) => {
				await store.append(updates);
				this.writes++;
				for (const update of updates) this.#shadowApply(update);
			},
			writeRecord: async (record, update) => {
				await store.writeRecord(record, update);
				this.writes++;
				const fresh = record.lineage === this.#lineage ? null : stored();
				this.#recorded(record, update, fresh instanceof Promise ? await fresh : fresh);
			},
			compact: async (state) => {
				await store.compact(state);
				this.writes++;
				this.#shadowApply(state);
			},
			drop: async () => {
				await store.drop();
				this.writes++;
				this.#lineage = null;
				this.#checkpoint = null;
				this.#shadow = null;
			},
			touch: () => store.touch(),
			claim: () => store.claim(),
			renew: () => store.renew(),
			release: () => store.release(),
		};
	}

	/** `stored` holds every stored update when the record starts a new lineage. */
	#recorded(record: RoomRecord, update: Uint8Array | undefined, stored: Uint8Array[] | null): void {
		if (stored) {
			this.#lineage = record.lineage;
			this.#checkpoint = null;
			this.#shadow = new Y.Doc({ gc: false });
			for (const each of stored) this.#shadowApply(each);
		} else if (update) {
			this.#shadowApply(update);
		}
		if (record.checkpoint === this.#checkpoint) return;
		const checkpoint = decodeCheckpoint(record.checkpoint);
		if (this.#checkpoint !== null && !snapshotContains(checkpoint, this.checkpoint!)) {
			this.#ledger.fail(`checkpoint doesn't contain the one before it (lineage ${record.lineage})`);
		}
		this.#checkpoint = record.checkpoint;
		const shadow = this.#shadow!;
		if (!snapshotContains(Y.snapshot(shadow), checkpoint)) {
			this.#ledger.fail("checkpoint holds updates room storage doesn't");
			return;
		}
		const at = Y.createDocFromSnapshot(shadow, checkpoint);
		for (const word of savedWords(at)) this.#ledger.covered.add(word);
		at.destroy();
	}

	#shadowApply(update: Uint8Array): void {
		if (this.#shadow) Y.applyUpdate(this.#shadow, update, REMOTE);
	}
}

type Down = { kind: "message"; bytes: Uint8Array } | { kind: "close"; code: CloseCode };

/** One socket: messages each way, in order. */
class Link implements RoomConnection {
	readonly up: Uint8Array[] = [];
	readonly down: Down[] = [];
	closed = false;

	constructor(
		readonly client: Client,
		readonly instance: RoomInstance,
	) {}

	send(message: Uint8Array): void {
		if (!this.closed) this.down.push({ kind: "message", bytes: message });
	}

	close(code: CloseCode): void {
		if (!this.closed) this.down.push({ kind: "close", code });
	}
}

class Client {
	doc: Y.Doc | null = null;
	editor: Editor | null = null;
	element: HTMLElement | null = null;
	link: Link | null = null;
	/** The join in flight, so a join that a restart abandoned is ignored. */
	join: number | null = null;
	lineage: string | null = null;
	/** The last checkpoint this replica's lineage reported. */
	checkpoint: Y.Snapshot | null = null;

	constructor(
		readonly index: number,
		readonly userId: string,
	) {}

	/** A new, empty replica, sending its own edits over the current link. */
	createDoc(): Y.Doc {
		const doc = new Y.Doc();
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === REMOTE || this.doc !== doc) return;
			this.link?.up.push(encodeUpdate(update));
		});
		this.doc = doc;
		return doc;
	}

	/**
	 * The editor, created only once the replica has synced, as the real client stays read-only
	 * until then, so an empty editor never writes a paragraph.
	 */
	createEditor(): void {
		const doc = this.doc!;
		const fragment = doc.getXmlFragment(`field:${BODY}`);
		const element = document.createElement("div");
		document.body.append(element);
		const sync = Extension.create({
			name: "roomHarnessSync",
			priority: 1000,
			addProseMirrorPlugins: () => [ySyncPlugin(fragment)],
		});
		this.editor = new Editor({
			element,
			extensions: [
				...portableTextExtensions(),
				PortableTextFilledDefaults,
				PortableTextYSync,
				sync,
			],
			injectCSS: false,
			content: "",
		});
		this.element = element;
	}

	discard(): void {
		try {
			this.editor?.destroy();
		} catch {
			// An editor can be mid-dispatch when its run fails.
		}
		this.element?.remove();
		this.doc?.destroy();
		this.editor = null;
		this.element = null;
		this.doc = null;
		this.lineage = null;
		this.checkpoint = null;
	}

	/** Whether the replica holds updates its lineage's last checkpoint doesn't contain. */
	uncovered(): boolean {
		if (!this.doc) return false;
		return !this.checkpoint || !snapshotContains(this.checkpoint, Y.snapshot(this.doc));
	}

	/** Every document field, read without the schema, as a recovery revision holds them. */
	recovery(): RecoveryInput {
		const data: Record<string, unknown> = {};
		let slug: string | null = null;
		for (const field of DOCUMENT_FIELDS) {
			try {
				const value = readField(this.doc!, field);
				if (field.slug === "slug") slug = typeof value === "string" ? value : null;
				else data[field.slug] = value;
			} catch {
				// A recovery revision leaves out a field that can't serialize.
			}
		}
		return { data, slug, editedBy: [this.userId] };
	}
}

function textPositions(doc: ProseMirrorNode): number[] {
	const out: number[] = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) {
			for (let index = 0; index <= node.content.size; index++) out.push(pos + 1 + index);
			return false;
		}
		return true;
	});
	return out;
}

function textblocks(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; pos: number }> {
	const out: Array<{ node: ProseMirrorNode; pos: number }> = [];
	doc.descendants((node, pos) => {
		if (node.isTextblock) {
			out.push({ node, pos });
			return false;
		}
		return true;
	});
	return out;
}

function within(doc: ProseMirrorNode, pos: number, name: string): boolean {
	const $pos = doc.resolve(pos);
	for (let depth = $pos.depth; depth > 0; depth--) {
		if ($pos.node(depth).type.name === name) return true;
	}
	return false;
}

function setSel(editor: Editor, anchor: number, head = anchor): void {
	editor.view.dispatch(
		editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)),
	);
}

/**
 * TipTap's `keyboardShortcut` captures transactions without `try`/`finally`: when a keydown
 * handler throws, the editor keeps capturing and swallows every later dispatch. A browser keydown
 * never goes through that command.
 */
function press(editor: Editor, name: string): void {
	try {
		editor.commands.keyboardShortcut(name);
	} finally {
		const capturing = editor as unknown as {
			isCapturingTransaction: boolean;
			capturedTransaction: unknown;
		};
		if (capturing.isCapturingTransaction) {
			capturing.isCapturingTransaction = false;
			capturing.capturedTransaction = null;
		}
	}
}

function command(editor: Editor, name: string, ...args: unknown[]): void {
	const commands = editor.commands as unknown as Record<
		string,
		((...a: unknown[]) => boolean) | undefined
	>;
	const run = commands[name];
	if (!run) throw new Error(`The editor has no ${name} command`);
	run(...args);
}

function rangeSel(editor: Editor, r: number[]): void {
	const positions = textPositions(editor.state.doc);
	const start = Math.min(Math.floor(r[0]! * positions.length), positions.length - 1);
	const span = r[1]! < 0.6 ? 1 + Math.floor(r[2]! * 6) : Math.floor(r[2]! * 40);
	setSel(editor, positions[start]!, positions[Math.min(positions.length - 1, start + span)]!);
}

const paragraphJson = (text: string) => ({
	type: "paragraph",
	content: [{ type: "text", text }],
});

const MARKS = ["toggleBold", "toggleItalic", "toggleCode", "setLink", "unsetLink"];

type Op = [name: string, weight: number, run: (e: Editor, r: number[], word: () => string) => void];

/** The edits a client makes, each with fresh words. */
const OPS: Op[] = [
	[
		"type",
		22,
		(e, r, word) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			e.view.dispatch(e.state.tr.insertText(word()));
		},
	],
	[
		"deleteRange",
		10,
		(e, r) => {
			rangeSel(e, r);
			press(e, "Backspace");
		},
	],
	[
		"joinBlocks",
		6,
		(e, r) => {
			const block = pick(textblocks(e.state.doc), r[0]!);
			if (r[1]! < 0.6) {
				setSel(e, block.pos + 1);
				press(e, "Backspace");
			} else {
				setSel(e, block.pos + 1 + block.node.content.size);
				press(e, "Delete");
			}
		},
	],
	[
		"enter",
		8,
		(e, r) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			press(e, "Enter");
		},
	],
	[
		"tab",
		3,
		(e, r) => {
			const positions = textPositions(e.state.doc).filter((pos) =>
				within(e.state.doc, pos, "listItem"),
			);
			if (positions.length === 0) return;
			setSel(e, pick(positions, r[0]!));
			press(e, r[1]! < 0.5 ? "Tab" : "Shift-Tab");
		},
	],
	[
		"toggleList",
		4,
		(e, r) => {
			rangeSel(e, r);
			command(e, r[3]! < 0.5 ? "toggleBulletList" : "toggleOrderedList");
		},
	],
	[
		"blockquote",
		3,
		(e, r) => {
			rangeSel(e, r);
			command(e, "toggleBlockquote");
		},
	],
	[
		"mark",
		6,
		(e, r) => {
			rangeSel(e, r);
			const name = pick(MARKS, r[3]!);
			if (name === "setLink") command(e, name, { href: `https://e.com/${Math.floor(r[4]! * 9)}` });
			else command(e, name);
		},
	],
	[
		"blockType",
		5,
		(e, r) => {
			rangeSel(e, r);
			const v = Math.floor(r[3]! * 6);
			if (v < 3) command(e, "setHeading", { level: 1 + v });
			else if (v < 5) command(e, "setParagraph");
			else command(e, "toggleCodeBlock");
		},
	],
	[
		"pluginBlock",
		2,
		(e, r, word) => {
			setSel(e, pick(textPositions(e.state.doc), r[0]!));
			command(e, "insertContent", {
				type: "pluginBlock",
				attrs: { blockType: PLUGIN_TYPE, id: "", data: { text: word() } },
			});
		},
	],
	[
		"deleteAtom",
		2,
		(e, r) => {
			const atoms: number[] = [];
			e.state.doc.descendants((node, pos) => {
				if (node.isAtom && node.isBlock) atoms.push(pos);
			});
			if (atoms.length === 0) return;
			e.view.dispatch(
				e.state.tr.setSelection(NodeSelection.create(e.state.doc, pick(atoms, r[0]!))),
			);
			press(e, "Backspace");
		},
	],
	[
		"pasteBlocks",
		2,
		(e, r, word) => {
			rangeSel(e, r);
			command(e, "insertContent", [
				paragraphJson(word()),
				{ type: "bulletList", content: [{ type: "listItem", content: [paragraphJson(word())] }] },
				paragraphJson(word()),
			]);
		},
	],
	[
		"selectAllDelete",
		0.3,
		(e) => {
			command(e, "selectAll");
			press(e, "Backspace");
		},
	],
];
const OP_TOTAL = OPS.reduce((sum, op) => sum + op[1], 0);

function drawOp(r: number): Op {
	let x = r * OP_TOTAL;
	for (const op of OPS) {
		x -= op[1];
		if (x <= 0) return op;
	}
	return OPS[0]!;
}

function textBlock(key: string, style: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block",
		_key: key,
		style,
		markDefs: [],
		children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
		...extra,
	};
}

interface Operation {
	kind: "publish" | "restore";
	instance: RoomInstance;
	hold: string | null;
	heldAt: number;
}

export interface RunResult {
	seed: number;
	failures: string[];
	/** The events the run took, for reading a failure. */
	events: string[];
}

class Run {
	readonly rng: () => number;
	readonly ledger = new Ledger();
	readonly clock = new VirtualClock();
	readonly site: FakeSite;
	readonly store: HarnessStore;
	/** Room storage in memory, or null when rooms store in the database. */
	readonly #memory: MemoryRoomStore | null;
	readonly #db: Kysely<Database> | null;
	readonly #dead: RoomInstance[] = [];
	#hosts = 0;
	readonly clients: Client[];
	readonly calls: SiteCall[] = [];
	readonly events: string[] = [];
	instance: RoomInstance;
	operation: Operation | null = null;
	restartAfterSave = false;
	#words = 0;
	#keys = 0;
	#joins = 0;

	constructor(seed: number, db: Kysely<Database> | null) {
		this.rng = mulberry32(seed);
		const word = () => this.word();
		this.site = new FakeSite({
			fields: FIELDS,
			slug: word(),
			pluginTypes: [PLUGIN_TYPE],
			data: {
				title: word(),
				summary: `${word()} ${word()}`,
				body: [
					textBlock("a", "normal", `${word()} ${word()} ${word()}`),
					textBlock("b", "h2", `${word()} ${word()}`),
					textBlock("c", "normal", `${word()} ${word()}`, { listItem: "bullet", level: 1 }),
					textBlock("d", "normal", word(), { listItem: "bullet", level: 1 }),
					{ _type: PLUGIN_TYPE, _key: "e", id: "callout-1", text: word() },
					textBlock("f", "normal", `${word()} ${word()}`),
				],
			},
		});
		this.site.notify = (outside) => this.instance.room.notify(outside);
		this.#db = db;
		this.#memory = db ? null : new MemoryRoomStore(() => this.clock.now);
		this.store = new HarnessStore(this.ledger);
		this.instance = this.#newInstance();
		this.clients = Array.from(
			{ length: CLIENTS },
			(_, index) => new Client(index, `user-${index}`),
		);
	}

	word(): string {
		const code = FIRST_WORD + this.#words++;
		if (code > LAST_WORD) throw new Error("The run ran out of words");
		return String.fromCharCode(code);
	}

	key(): string {
		return `k${this.#keys++}`;
	}

	log(event: string): void {
		this.events.push(event);
	}

	/** The site as one process sees it: every call waits until the run lets it through. */
	siteFor(instance: RoomInstance): RoomSite {
		const gated = <T>(
			kind: SiteCall["kind"],
			run: () => Promise<T>,
			input?: CheckpointInput,
		): Promise<T> => {
			if (instance.dead) return never();
			return new Promise<T>((resolve, reject) => {
				this.calls.push({
					instance,
					kind,
					input,
					run,
					resolve: (value) => resolve(value as T),
					reject,
				});
			});
		};
		return {
			load: (entry: EntryRef) => gated("load", () => this.site.load(entry)),
			save: (entry: EntryRef, input: CheckpointInput) =>
				gated("save", () => this.site.save(entry, input), structuredClone(input)),
			saveRecovery: (entry: EntryRef, recovery: RecoveryInput) =>
				gated("recovery", () => this.site.saveRecovery(entry, recovery)),
		};
	}

	#newInstance(): RoomInstance {
		return new RoomInstance(this, `host-${++this.#hosts}`);
	}

	storeFor(instance: RoomInstance): RoomStore {
		const store = this.#storeOf(instance);
		const guard = <T>(call: () => Promise<T>): Promise<T> => (instance.dead ? never() : call());
		return {
			load: () => guard(() => store.load()),
			append: (updates) => guard(() => store.append(updates)),
			writeRecord: (record, update) => guard(() => store.writeRecord(record, update)),
			compact: (state) => guard(() => store.compact(state)),
			drop: () => guard(() => store.drop()),
			touch: () => guard(() => store.touch()),
			claim: () => guard(() => store.claim()),
			renew: () => guard(() => store.renew()),
			release: () => guard(() => store.release()),
		};
	}

	#storeOf(instance: RoomInstance): RoomStore {
		const memory = this.#memory;
		if (memory) return this.store.track(memory, () => memory.updates);
		const db = this.#db!;
		const tracked = this.store.track(new KyselyRoomStore(db, ROOM_ID, instance.host), () =>
			storedUpdates(db),
		);
		return {
			...tracked,
			claim: async () => {
				await this.#expireClaims(db);
				return tracked.claim();
			},
		};
	}

	/**
	 * Expires the claims of processes that died at least a minute ago on the run's clock, as the
	 * database clock would have by then.
	 */
	async #expireClaims(db: Kysely<Database>): Promise<void> {
		const due = this.#dead
			.filter((instance) => this.clock.now - instance.diedAt >= CLAIM_EXPIRY_MS)
			.map((instance) => instance.host);
		if (due.length === 0) return;
		await db
			.updateTable("_emdash_rooms")
			.set({ claimed_at: timestampOffset(db, -(CLAIM_EXPIRY_MS / 1000 + 1)) })
			.where("room_id", "=", ROOM_ID)
			.where("part", "=", 0)
			.where("host", "in", due)
			.execute();
	}

	/** Whether a dead process could still renew its claim, which would let it write again. */
	async deadCanRenew(): Promise<boolean> {
		const db = this.#db;
		if (!db) return false;
		for (const instance of this.#dead) {
			if (await new KyselyRoomStore(db, ROOM_ID, instance.host).renew()) return true;
		}
		return false;
	}

	/** Lets the oldest site call through. The site commits even if its caller has died. */
	async releaseCall(index: number): Promise<void> {
		const [call] = this.calls.splice(index, 1);
		if (!call) return;
		if (call.kind !== "save") this.log(`site:${call.kind}`);
		let result: unknown;
		try {
			result = await call.run();
		} catch (error) {
			if (!call.instance.dead) call.reject(error);
			await drain();
			return;
		}
		const saved = call.kind === "save" && (result as SaveResult).ok;
		if (saved && call.input) {
			for (const word of wordsInJson([call.input.data, call.input.slug])) {
				this.ledger.covered.add(word);
			}
		}
		if (call.kind === "save") {
			const save = result as SaveResult;
			this.log(`site:save:${save.ok ? "ok" : save.reason}${call.instance.dead ? ":dead" : ""}`);
		}
		if (saved && this.restartAfterSave && call.instance === this.instance) {
			this.restartAfterSave = false;
			this.restart("unrecorded");
		} else if (!call.instance.dead) {
			call.resolve(result);
		}
		await drain();
	}

	/**
	 * The room's process dies: what it didn't store is lost, and its sockets close. With room
	 * storage in the database its claim holds until it expires, so the next process takes the
	 * room over only then.
	 */
	restart(why: string): void {
		this.log(`restart:${why}`);
		const old = this.instance;
		old.dead = true;
		old.diedAt = this.clock.now;
		if (this.#memory) this.#memory.claimed = false;
		else this.#dead.push(old);
		this.operation = null;
		this.ledger.overwriting = 0;
		for (const client of this.clients) {
			client.join = null;
			if (client.link?.instance === old) this.dropLink(client);
		}
		this.instance = this.#newInstance();
	}

	dropLink(client: Client): void {
		const link = client.link;
		if (!link) return;
		link.closed = true;
		client.link = null;
		if (!link.instance.dead) link.instance.room.disconnect(link);
	}

	/** Asks the room for a token, as the join route does, and connects with it. */
	startJoin(client: Client): void {
		if (client.link || client.join !== null) return;
		client.join = ++this.#joins;
		this.log(`join:${client.index}`);
		void this.#join(client, this.instance, client.join);
	}

	async #join(client: Client, instance: RoomInstance, join: number): Promise<void> {
		const entry = this.site.current;
		let result: Awaited<ReturnType<Room["issueToken"]>>;
		try {
			result = await instance.room.issueToken({
				userId: client.userId,
				name: client.userId,
				access: "edit",
				fingerprint: FINGERPRINT,
				rev: entry.rev,
				status: entry.status,
				authorId: entry.authorId,
			});
		} catch (error) {
			if (client.join === join) client.join = null;
			this.ledger.fail(`a token request threw: ${String(error)}`);
			return;
		}
		if (client.join !== join || instance.dead) return;
		client.join = null;
		if (typeof result === "object" && result !== null) this.connect(client, instance, result.token);
		else this.log(`join:${client.index}:${String(result)}`);
	}

	connect(client: Client, instance: RoomInstance, token: string): void {
		const link = new Link(client, instance);
		client.link = link;
		const doc = client.doc ?? client.createDoc();
		instance.room.connect(link, token);
		link.up.push(encodeSyncStep1(doc));
	}

	deliverUp(client: Client, count: number, log = false): void {
		const link = client.link;
		if (!link) return;
		if (log && link.up.length) this.log(`up:${client.index}:${Math.min(count, link.up.length)}`);
		for (let index = 0; index < count && client.link === link; index++) {
			const bytes = link.up.shift();
			if (!bytes) return;
			if (!link.instance.dead) link.instance.room.receive(link, bytes);
		}
	}

	receiveDown(client: Client, count: number, log = false): void {
		const link = client.link;
		if (!link) return;
		if (log && link.down.length)
			this.log(`down:${client.index}:${Math.min(count, link.down.length)}`);
		for (let index = 0; index < count && client.link === link; index++) {
			const item = link.down.shift();
			if (!item) return;
			if (item.kind === "close") this.closed(client, item.code);
			else this.handle(client, item.bytes);
		}
	}

	handle(client: Client, bytes: Uint8Array): void {
		const message = decodeMessage(bytes);
		const doc = client.doc!;
		if (!message) {
			this.ledger.fail("the room sent a message that doesn't decode");
			return;
		}
		switch (message.type) {
			case "welcome":
				if (client.lineage !== null && client.lineage !== message.lineage) {
					this.reset(client, "lineage");
					return;
				}
				client.lineage = message.lineage;
				this.noteCheckpoint(client, message.snapshot);
				return;
			case "sync-step-1":
				client.link?.up.push(encodeSyncStep2(doc, message.stateVector));
				return;
			case "sync-step-2":
				Y.applyUpdate(doc, message.update, REMOTE);
				if (!client.editor) client.createEditor();
				return;
			case "sync-update":
				Y.applyUpdate(doc, message.update, REMOTE);
				return;
			case "checkpoint":
				this.noteCheckpoint(client, message.snapshot);
				return;
			default:
				return;
		}
	}

	noteCheckpoint(client: Client, encoded: Uint8Array): void {
		const snapshot = Y.decodeSnapshot(encoded);
		if (client.checkpoint && !snapshotContains(snapshot, client.checkpoint)) {
			this.ledger.fail(`client ${client.index} got a checkpoint that doesn't contain its last`);
		}
		client.checkpoint = snapshot;
	}

	closed(client: Client, code: CloseCode): void {
		this.log(`closed:${client.index}:${code}`);
		const link = client.link!;
		link.closed = true;
		client.link = null;
		if (code === CLOSE_CODES.reset) this.reset(client, "reset");
		else if (code === CLOSE_CODES.deleted) this.ledger.fail("the room closed a client as deleted");
	}

	/** Discards the replica, first saving it as a recovery revision if it holds uncovered edits. */
	reset(client: Client, why: string): void {
		this.log(`reset:${client.index}:${why}`);
		if (client.uncovered()) void this.site.saveRecovery(ENTRY, client.recovery());
		client.discard();
		this.dropLink(client);
	}

	edit(client: Client): void {
		const editor = client.editor;
		const doc = client.doc;
		if (!editor || !doc) return;
		const r = Array.from({ length: 6 }, () => this.rng());
		if (r[5]! < 0.2) {
			const key = pick(VALUE_KEYS, r[0]!);
			this.log(`edit:${client.index}:${key}`);
			doc.getMap("fields").set(key, this.word());
			return;
		}
		const [name, , run] = drawOp(r[5]!);
		this.log(`edit:${client.index}:${name}`);
		try {
			run(editor, r, () => this.word());
		} catch (error) {
			this.log(`edit-error:${name}:${String(error).slice(0, 80)}`);
		}
	}

	/** A write the room didn't make: a word appended to the stored rich text, or a value set. */
	outsideWrite(): void {
		const entry = this.site.current;
		const word = this.word();
		const r = this.rng();
		if (r < 0.6) {
			const body = structuredClone((entry.data[BODY] ?? []) as PortableTextBlock[]);
			const last = body.at(-1) as { _type?: string; children?: Array<Record<string, unknown>> };
			const span = last?._type === "block" ? last.children?.at(-1) : undefined;
			if (r < 0.3 && span?._type === "span" && typeof span.text === "string") {
				span.text = `${span.text} ${word}`;
			} else {
				body.push(textBlock(this.key(), "normal", word));
			}
			this.log("outside:body");
			void this.site.write({ data: { [BODY]: body } });
		} else {
			const key = pick(VALUE_KEYS, this.rng());
			const old = key === "slug" ? entry.slug : entry.data[key];
			for (const removed of wordsInJson(old)) this.ledger.removedFromStore.add(removed);
			this.log(`outside:${key}`);
			void this.site.write(key === "slug" ? { slug: word } : { data: { [key]: word } });
		}
	}

	requestSave(client: Client): void {
		if (!client.link || !client.editor) return;
		this.log(`save:${client.index}`);
		client.link.up.push(encodeRoomMessage({ type: "save" }));
	}

	/** Publishes or restores through the room, as the runtime's operation methods will. */
	startOperation(client: Client): void {
		if (this.operation) return;
		const kind = this.rng() < 0.5 ? "publish" : "restore";
		this.operation = { kind, instance: this.instance, hold: null, heldAt: 0 };
		this.log(`operation:${kind}:${client.index}`);
		void this.#operate(this.operation, client.userId);
	}

	async #operate(operation: Operation, actorId: string): Promise<void> {
		let result: Awaited<ReturnType<Room["save"]>>;
		try {
			result = await operation.instance.room.save(actorId);
		} catch (error) {
			if (this.operation === operation) this.operation = null;
			if (!(error instanceof RoomSaveError)) {
				this.ledger.fail(`an operation's save threw: ${String(error)}`);
			}
			return;
		}
		if (this.operation !== operation || operation.instance.dead) return;
		if (result === null || result === "conflict") {
			this.operation = null;
			return;
		}
		operation.hold = result.hold;
		operation.heldAt = this.clock.now;
		if (operation.kind === "publish") this.site.change({ status: "published" });
		else this.restore();
	}

	restore(): void {
		const revision = pick(this.site.revisions, this.rng());
		if (!revision) return;
		const entry = this.site.current;
		const kept = new Set(wordsInJson([revision.data, revision.slug]));
		for (const word of wordsInJson([entry.data, entry.slug])) {
			if (!kept.has(word)) this.ledger.removedFromStore.add(word);
		}
		this.log("restored");
		this.site.change({ data: structuredClone(revision.data), slug: revision.slug });
	}

	releaseOperation(): boolean {
		const operation = this.operation;
		if (!operation || operation.hold === null) return false;
		this.operation = null;
		this.log("release");
		if (operation.instance.dead) return true;
		const overwrite = operation.kind === "restore";
		// A hold that expired already merged without overwriting, so this release merges plainly.
		const overwrites = overwrite && this.clock.now - operation.heldAt < OPERATION_HOLD_MS;
		if (overwrites) this.ledger.overwriting++;
		void operation.instance.room.release(operation.hold, { overwrite }).finally(() => {
			if (overwrites && !operation.instance.dead) this.ledger.overwriting--;
		});
		return true;
	}

	/** One event, chosen by the seed. */
	async step(): Promise<void> {
		const roll = this.rng() * 100;
		const client = pick(this.clients, this.rng());
		if (roll < 28) this.edit(client);
		else if (roll < 46) this.deliverUp(client, 1 + Math.floor(this.rng() * 3), true);
		else if (roll < 64) this.receiveDown(client, 1 + Math.floor(this.rng() * 4), true);
		else if (roll < 73) await this.releaseCall(0);
		else if (roll < 79) await this.tick(200 + Math.floor(this.rng() * 3800));
		else if (roll < 80.5) {
			if (client.link) this.log(`drop:${client.index}`);
			this.dropLink(client);
		} else if (roll < 88) this.startJoin(client);
		else if (roll < 88.6) this.restart("crash");
		else if (roll < 89.2) this.restartAfterSave = true;
		else if (roll < 92) this.outsideWrite();
		else if (roll < 94) this.requestSave(client);
		else if (roll < 95.5) this.startOperation(client);
		else if (roll < 97.5) this.releaseOperation();
		else await this.tick(SETTLE_TICK_MS);
		await drain();
	}

	async tick(ms: number): Promise<void> {
		this.log(`tick:${ms}`);
		await this.clock.advance(ms);
	}

	/**
	 * Reconnects every client, delivers everything and lets timers run, until a few rounds in a
	 * row move nothing. False when the run never got there.
	 */
	async settle(): Promise<boolean> {
		this.log("settle");
		this.restartAfterSave = false;
		let quiet = 0;
		for (let round = 0; round < SETTLE_ROUNDS && quiet < QUIET_ROUNDS; round++) {
			const writes = this.store.writes;
			let moved = this.releaseOperation();
			for (const client of this.clients) {
				if (!client.link && client.join === null) {
					this.startJoin(client);
					moved = true;
				}
			}
			await drain();
			for (let pass = 0; pass < 100; pass++) {
				let passMoved = false;
				while (this.calls.length > 0) {
					await this.releaseCall(0);
					passMoved = true;
				}
				for (const client of this.clients) {
					const link = client.link;
					if (!link || (link.up.length === 0 && link.down.length === 0)) continue;
					this.deliverUp(client, Number.POSITIVE_INFINITY);
					this.receiveDown(client, Number.POSITIVE_INFINITY);
					passMoved = true;
				}
				await drain();
				if (!passMoved) break;
				moved = true;
			}
			await this.clock.advance(SETTLE_TICK_MS);
			if (this.store.writes !== writes || this.calls.length > 0) moved = true;
			quiet = moved ? 0 : quiet + 1;
		}
		return quiet >= QUIET_ROUNDS;
	}

	check(settled: boolean): void {
		const { ledger } = this;
		if (!settled) ledger.fail("the run didn't settle");
		const unsynced = this.clients.filter((client) => !client.link || !client.editor);
		if (unsynced.length > 0) {
			ledger.fail(`clients ${unsynced.map((client) => client.index).join(", ")} didn't rejoin`);
		}
		const room = ledger.roomDoc;
		if (!room) {
			ledger.fail("the room never applied an update");
			return;
		}
		const checkpoint = this.store.checkpoint;
		if (!checkpoint || !snapshotContains(checkpoint, Y.snapshot(room))) {
			ledger.fail("the room's last checkpoint doesn't cover its document after settling");
		}

		const expected = documentHash(room);
		const vector = Y.encodeStateVector(room).join();
		for (const client of this.clients) {
			if (!client.doc) continue;
			const same =
				documentHash(client.doc) === expected && Y.encodeStateVector(client.doc).join() === vector;
			if (!same) ledger.fail(`client ${client.index}'s replica differs from the room's document`);
		}

		const entry = this.site.current;
		const final = countWords([entry.data, entry.slug]);
		const recovered = new Set(wordsInJson(this.site.recoveries.map((r) => [r.data, r.slug])));
		for (const word of ledger.covered) {
			if (final.has(word) || recovered.has(word)) continue;
			if (ledger.editDeleted.has(word) || ledger.removedFromStore.has(word)) continue;
			ledger.fail(`covered word ${describe(word)} is lost`);
		}

		for (const [word, count] of final) {
			if (count > 1 + (ledger.copies.get(word) ?? 0)) {
				ledger.fail(`word ${describe(word)} is stored ${count} times`);
			}
		}
	}

	discard(): void {
		for (const client of this.clients) client.discard();
	}
}

const describe = (word: string) => `U+${word.charCodeAt(0).toString(16).toUpperCase()}`;

/** Every update stored for the room, in order. */
async function storedUpdates(db: Kysely<Database>): Promise<Uint8Array[]> {
	const rows = await db
		.selectFrom("_emdash_room_updates")
		.select(["seq", "data"])
		.where("room_id", "=", ROOM_ID)
		.orderBy("seq")
		.orderBy("part")
		.execute();
	const updates = new Map<number, Uint8Array[]>();
	for (const row of rows) {
		const parts = updates.get(Number(row.seq)) ?? [];
		parts.push(Uint8Array.from(row.data));
		updates.set(Number(row.seq), parts);
	}
	return Array.from(updates.values(), (parts) => Uint8Array.from(Buffer.concat(parts)));
}

export interface RunOptions {
	/**
	 * Stores rooms in this database through `KyselyRoomStore`, one host per process, so a process
	 * that dies keeps its claim until it expires and the next one takes the room over.
	 */
	db?: Kysely<Database>;
}

/** Runs one seed: its events, then a settle, then the checks. */
export async function runSeed(seed: number, options: RunOptions = {}): Promise<RunResult> {
	const db = options.db ?? null;
	if (db) {
		await db.deleteFrom("_emdash_room_updates").execute();
		await db.deleteFrom("_emdash_rooms").execute();
	}
	const restore = installDeterminism(seed);
	const run = new Run(seed, db);
	// Swapped by hand, as vitest keeps every spy it creates until the file ends.
	const { now } = Date;
	const { error: consoleError, warn: consoleWarn } = console;
	// The store reads stored times on the process clock, which has to be the run's.
	if (db) Date.now = () => run.clock.now;
	// Nothing in a run makes the site or store fail, so anything the room logs is unexpected.
	const logged = (...args: unknown[]) => {
		const message = args.map(String).join(" ");
		if (message.startsWith("[co-editing]")) run.ledger.fail(`the room logged: ${message}`);
	};
	console.error = logged;
	console.warn = logged;
	activeLedger = run.ledger;
	try {
		await run.settle();
		for (let step = 0; step < STEPS; step++) await run.step();
		run.check(await run.settle());
		if (await run.deadCanRenew()) run.ledger.fail("a dead process can still renew its claim");
	} catch (error) {
		run.ledger.fail(`the run threw: ${error instanceof Error ? error.stack : String(error)}`);
	} finally {
		run.discard();
		activeLedger = null;
		console.error = consoleError;
		console.warn = consoleWarn;
		Date.now = now;
		restore();
		// ProseMirror caches wrappings on the shared empty content match, keyed by node types, so
		// every run's schema, editors and documents would stay reachable.
		const internal = ContentMatch as unknown as { empty: { wrapCache: unknown[] } };
		internal.empty.wrapCache.length = 0;
	}
	return { seed, failures: run.ledger.failures, events: run.events };
}
