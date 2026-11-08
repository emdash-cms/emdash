import type { Editor } from "@tiptap/core";
import { yCursorPluginKey, yUndoPluginKey, ySyncPluginKey } from "@tiptap/y-tiptap";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
	ENTRY_SLUG,
	FIELDS_MAP,
	fieldWrite,
	readField,
	touchedFields,
	type LayoutField,
} from "../../../co-editing/layout.js";
import type { RoomAccess } from "../../../co-editing/types.js";
import { equalJsonValues } from "../../../portable-text/convert.js";
import type { RecoveryInput } from "../../api/rooms.js";
import type {
	ConnectionEvents,
	ConnectionTarget,
	ReplicaHandle,
	ReplicaOptions,
	RoomSocket,
} from "../session.js";
import {
	RoomSaveError,
	type DraftCapture,
	type RichTextBinding,
	type RoomEditing,
	type RoomFields,
	type RoomSaveState,
} from "../types.js";
import { Connection } from "./connection.js";
import { Coverage, type CoverageMark } from "./coverage.js";
import { RemoteCursors } from "./cursors.js";
import { FORM, REMOTE } from "./origins.js";
import { Presence, trackFocusedField } from "./presence.js";
import { createRichTextBinding } from "./rich-text.js";

/** As long as the room holds saves for an operation, so a save it never checkpoints can't hang one. */
const WHEN_COVERED_TIMEOUT_MS = 30_000;

/** The synced connection a replica sends `save` through. */
export interface SaveLink {
	save(): void;
}

interface Waiter {
	readonly target: CoverageMark;
	readonly save: boolean;
	readonly resolve: () => void;
	readonly reject: (error: RoomSaveError) => void;
	timer: unknown;
}

/**
 * The tab's replica of the entry's shared document. It outlives connections: a rejoin keeps it,
 * with its edits and coverage, and only a reset replaces it.
 */
export class Replica implements ReplicaHandle {
	readonly doc = new Y.Doc();
	readonly awareness = new Awareness(this.doc);
	readonly presence = new Presence(this.awareness);
	readonly cursors: RemoteCursors;
	readonly editing: RoomEditing;
	readonly #options: ReplicaOptions;
	readonly #richText: ReadonlySet<string>;
	readonly #coverage = new Coverage(this.doc.clientID);
	readonly #waiters = new Set<Waiter>();
	readonly #saveListeners = new Set<() => void>();
	readonly #fieldListeners = new Map<string, Set<() => void>>();
	readonly #values = new Map<string, unknown>();
	readonly #fieldSequences = new Map<string, number>();
	readonly #remoteVersions = new Map<string, number>();
	readonly #editors = new Map<string, Editor>();
	readonly #bindings = new Map<string, RichTextBinding>();
	#lineage: string | null = null;
	#access: RoomAccess | null = null;
	#rev: string | null = null;
	#sequence = 0;
	#link: SaveLink | null = null;
	#offline = false;
	#frozen = false;
	#disposed = false;
	#saveState: RoomSaveState = { covered: true, saving: false, rev: null };
	readonly #stopPresence: () => void;

	constructor(options: ReplicaOptions) {
		this.#options = options;
		this.#richText = new Set(options.richTextFields);
		this.awareness.setLocalState({ field: null });
		this.cursors = new RemoteCursors(this.awareness, options.clock, (userId) =>
			this.presence.colorOf(userId),
		);
		this.#stopPresence = this.#followPresence();
		this.doc.on("afterTransaction", (transaction: Y.Transaction) =>
			this.#afterTransaction(transaction),
		);
		const fields: RoomFields = {
			subscribe: (field, listener) => this.#subscribeField(field, listener),
			get: (field) => this.#get(field),
			set: (values) => this.#set(values),
			read: (names) =>
				Object.fromEntries(
					names.map((name) => [name, tryReadField(this.doc, this.#layoutField(name)) ?? null]),
				),
			remoteVersion: (field) => this.#remoteVersions.get(field) ?? 0,
		};
		this.editing = {
			id: this.doc.guid,
			fields,
			subscribe: (listener) => {
				this.#saveListeners.add(listener);
				return () => this.#saveListeners.delete(listener);
			},
			getSaveState: () => this.#saveState,
			whenCovered: (request) => this.#whenCovered(request.save),
			richText: (field) => this.#richTextBinding(field),
			captureDraft: (names): DraftCapture => ({
				values: fields.read(names),
				rev: this.#rev,
				sequence: this.#sequence,
				replica: this.doc.guid,
			}),
			changedSince: (capture, names) =>
				capture.replica !== this.doc.guid ||
				names.some((name) => (this.#fieldSequences.get(name) ?? 0) > capture.sequence),
			applyPatch: (values) => this.#applyPatch(values),
			presence: this.presence,
		};
	}

	/** The lineage of the first room that welcomed this replica. */
	get lineage(): string | null {
		return this.#lineage;
	}

	/** The rich-text editors bound to this replica, by field. */
	get editors(): ReadonlyMap<string, Editor> {
		return this.#editors;
	}

	registerEditor(field: string, editor: Editor): () => void {
		this.#editors.set(field, editor);
		return () => {
			if (this.#editors.get(field) === editor) this.#editors.delete(field);
		};
	}

	connect(
		target: ConnectionTarget,
		events: ConnectionEvents,
		openSocket: (url: string) => RoomSocket,
	): Connection {
		return new Connection(this, target, events, openSocket);
	}

	hasUncoveredEdits(): boolean {
		return this.#coverage.mark !== null;
	}

	/**
	 * The whole document: every value in the fields map, and every pinned rich-text field. A value
	 * the layout can't read is left out, so the rest still saves.
	 */
	recoveryInput(): RecoveryInput {
		const data: Record<string, unknown> = {};
		const fields: LayoutField[] = [];
		for (const key of this.doc.getMap(FIELDS_MAP).keys()) {
			if (key !== ENTRY_SLUG.slug) fields.push({ slug: key, type: "json" });
		}
		for (const slug of this.#richText) fields.push({ slug, type: "portableText" });
		for (const field of fields) {
			const value = tryReadField(this.doc, field);
			if (value !== undefined) data[field.slug] = value;
		}
		const slug = tryReadField(this.doc, ENTRY_SLUG);
		return { data, slug: typeof slug === "string" ? slug : null };
	}

	setOffline(offline: boolean): void {
		this.#offline = offline;
		if (offline) this.#rejectWaiters(new RoomSaveError("offline"));
	}

	freeze(): void {
		this.#frozen = true;
		this.#rejectWaiters(new RoomSaveError("gone"));
	}

	recovered(): void {
		this.#coverage.forget();
		this.freeze();
		this.#updateSaveState();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#rejectWaiters(new RoomSaveError("gone"));
		this.#stopPresence();
		this.cursors.dispose();
		this.presence.dispose();
		this.awareness.destroy();
		this.doc.destroy();
		this.#saveListeners.clear();
		this.#fieldListeners.clear();
	}

	/** A welcome from this replica's lineage, or its first. */
	welcome(lineage: string, access: RoomAccess, snapshot: Uint8Array): void {
		this.#lineage ??= lineage;
		this.#access = access;
		if (access !== "edit") this.#rejectWaiters(new RoomSaveError("access"));
		this.#checkpoint(snapshot);
	}

	/** The room answered a connection's sync step 1. */
	synced(link: SaveLink): void {
		this.#coverage.start(this.doc);
		this.#link = link;
		if ([...this.#waiters].some((waiter) => waiter.save)) link.save();
	}

	detach(link: SaveLink): void {
		if (this.#link === link) this.#link = null;
	}

	checkpoint(snapshot: Uint8Array, rev: string): void {
		this.#rev = rev;
		this.#checkpoint(snapshot);
	}

	refused(code: string, message: string): void {
		this.#rejectWaiters(new RoomSaveError("refused", code, message));
	}

	#afterTransaction(transaction: Y.Transaction): void {
		const remote = transaction.origin === REMOTE;
		const touched = touchedFields(transaction);
		if (touched.size > 0) this.#sequence++;
		for (const field of touched) {
			this.#fieldSequences.set(field, this.#sequence);
			if (remote) this.#remoteVersions.set(field, (this.#remoteVersions.get(field) ?? 0) + 1);
			this.#values.delete(field);
		}
		// A checkpoint reaches this replica after every update it holds, so none can contain an
		// own edit made since it arrived: coverage changes only at the next checkpoint.
		if (this.#coverage.record(transaction, !remote)) this.#updateSaveState();
		for (const field of touched) {
			for (const listener of this.#fieldListeners.get(field) ?? []) listener();
		}
	}

	#checkpoint(snapshot: Uint8Array): void {
		this.#coverage.checkpoint(Y.decodeSnapshot(snapshot));
		this.#settle();
	}

	#settle(): void {
		if (this.#coverage.settle()) {
			for (const waiter of this.#waiters) this.#finish(waiter).resolve();
		} else {
			for (const waiter of this.#waiters) {
				if (this.#coverage.contains(waiter.target)) this.#finish(waiter).resolve();
			}
		}
		this.#updateSaveState();
	}

	#whenCovered(save: boolean): Promise<void> {
		if (this.#disposed || this.#frozen) return Promise.reject(new RoomSaveError("gone"));
		const target = this.#coverage.mark;
		if (!target) return Promise.resolve();
		if (this.#offline) return Promise.reject(new RoomSaveError("offline"));
		if (this.#access !== "edit") return Promise.reject(new RoomSaveError("access"));
		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { target, save, resolve, reject, timer: null };
			waiter.timer = this.#options.clock.setTimeout(
				() => this.#finish(waiter).reject(new RoomSaveError("timeout")),
				WHEN_COVERED_TIMEOUT_MS,
			);
			this.#waiters.add(waiter);
			if (save) this.#link?.save();
			this.#updateSaveState();
		});
	}

	/** Removes a waiter, so it settles once, and returns it. */
	#finish(waiter: Waiter): Waiter {
		this.#options.clock.clearTimeout(waiter.timer);
		this.#waiters.delete(waiter);
		this.#updateSaveState();
		return waiter;
	}

	#rejectWaiters(error: RoomSaveError): void {
		for (const waiter of this.#waiters) this.#finish(waiter).reject(error);
	}

	#updateSaveState(): void {
		const covered = this.#coverage.mark === null;
		const saving = this.#waiters.size > 0;
		const current = this.#saveState;
		if (current.covered === covered && current.saving === saving && current.rev === this.#rev) {
			return;
		}
		this.#saveState = { covered, saving, rev: this.#rev };
		for (const listener of this.#saveListeners) listener();
	}

	/**
	 * Sends the focused field, and gives the carets and selections new colors when someone's
	 * changes, as when this tab learns its own user after the editors drew them.
	 */
	#followPresence(): () => void {
		const stopFocus = trackFocusedField(this.awareness, this.doc.guid);
		let colors = this.presence.colors;
		const unsubscribe = this.presence.subscribe(() => {
			if (colors === this.presence.colors) return;
			colors = this.presence.colors;
			this.cursors.recolor();
			for (const editor of this.#editors.values()) {
				editor.view.dispatch(editor.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }));
			}
		});
		return () => {
			stopFocus();
			unsubscribe();
		};
	}

	#richTextBinding(field: string): RichTextBinding {
		let binding = this.#bindings.get(field);
		if (!binding) this.#bindings.set(field, (binding = createRichTextBinding(this, field)));
		return binding;
	}

	#subscribeField(field: string, listener: () => void): () => void {
		let listeners = this.#fieldListeners.get(field);
		if (!listeners) this.#fieldListeners.set(field, (listeners = new Set()));
		listeners.add(listener);
		return () => listeners.delete(listener);
	}

	#get(field: string): unknown {
		if (this.#values.has(field)) return this.#values.get(field);
		const value = tryReadField(this.doc, this.#layoutField(field)) ?? null;
		this.#values.set(field, value);
		return value;
	}

	#set(values: Readonly<Record<string, unknown>>): boolean {
		const map = this.doc.getMap(FIELDS_MAP);
		const writes = this.#fieldWrites(values, (name, value) =>
			value === undefined ? !map.has(name) : equalJsonValues(map.get(name), value),
		);
		if (!writes) return false;
		this.doc.transact(() => {
			for (const write of writes) write(this.doc);
		}, FORM);
		return true;
	}

	/**
	 * One transaction under y-sync's origin, which every bound editor's undo tracks, so each
	 * rich-text field it changes undoes in one step. Capturing stops on both sides, so the patch
	 * never joins the typing around it.
	 */
	#applyPatch(values: Readonly<Record<string, unknown>>): boolean {
		const map = this.doc.getMap(FIELDS_MAP);
		const writes = this.#fieldWrites(values, (name, value) =>
			equalJsonValues(map.get(name), value),
		);
		if (!writes) return false;
		const undoManagers = [...this.#editors.values()].flatMap((editor) => {
			const undoManager: Y.UndoManager | undefined = yUndoPluginKey.getState(
				editor.state,
			)?.undoManager;
			return undoManager ? [undoManager] : [];
		});
		for (const undoManager of undoManagers) undoManager.stopCapturing();
		this.doc.transact(() => {
			for (const write of writes) write(this.doc);
		}, ySyncPluginKey);
		for (const undoManager of undoManagers) undoManager.stopCapturing();
		return true;
	}

	/**
	 * The writes that change `values`, each rich-text value converted once, leaving out the other
	 * values `unchanged` says the document already holds. Null when the editor can't represent
	 * one of the rich-text values.
	 */
	#fieldWrites(
		values: Readonly<Record<string, unknown>>,
		unchanged: (name: string, value: unknown) => boolean,
	): Array<(doc: Y.Doc) => void> | null {
		const writes: Array<(doc: Y.Doc) => void> = [];
		for (const [name, value] of Object.entries(values)) {
			const field = this.#layoutField(name);
			const write = fieldWrite(field, value, this.#options.pluginBlockTypes);
			if (!write) return null;
			if (field.type === "portableText" || !unchanged(name, value)) writes.push(write);
		}
		return writes;
	}

	#layoutField(name: string): LayoutField {
		return { slug: name, type: this.#richText.has(name) ? "portableText" : "json" };
	}
}

/**
 * A field's value, or undefined when another client wrote it in a shape the layout can't read,
 * which then shows as empty instead of breaking every editor of the entry.
 */
function tryReadField(doc: Y.Doc, field: LayoutField): unknown {
	try {
		return readField(doc, field);
	} catch (error) {
		console.error(`[co-editing] couldn't read the field ${field.slug}:`, error);
		return undefined;
	}
}
