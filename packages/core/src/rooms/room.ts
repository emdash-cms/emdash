/**
 * The room actor: one per entry row. It holds the shared document, relays updates and presence,
 * saves the document through the site, and merges outside writes into it. Saves, merges, drops
 * and operations run one at a time through a serial queue; client updates apply at once.
 */

import {
	decodeMessage,
	encodeAwareness,
	encodeRoomMessage,
	encodeSyncStep1,
	encodeSyncStep2,
	encodeUpdate,
	ENTRY_SLUG,
	readField,
	readFields,
	snapshotContains,
	touchedFields,
	writeField,
	type AwarenessEntry,
	type Notice,
} from "@emdash-cms/admin/internal/co-editing";
import { findUnsupportedPortableTextMarks } from "@emdash-cms/admin/internal/portable-text";
import { encodeBase64urlNoPadding } from "@oslojs/encoding";
import * as Y from "yjs";

import {
	buildDocument,
	documentFields,
	layoutFields,
	storedValues,
	type DocumentField,
} from "./document.js";
import { hashValue } from "./hash.js";
import {
	CLAIM_RENEWAL_MS,
	CONNECTION_LIFETIME_MS,
	COMPACTION_BYTES,
	MAX_COMPACTED_BYTES,
	MAX_ENTRY_BYTES,
	MAX_RECOVERY_BYTES,
	MAX_ROOM_CONNECTIONS,
	MAX_SAVE_INTERVAL_MS,
	MAX_UPDATE_BYTES,
	MAX_USER_CONNECTIONS,
	OPEN_AFTER_LAST_CONNECTION_MS,
	OPERATION_HOLD_MS,
	ROOM_STATE_LIFETIME_MS,
	SAVE_DELAY_MS,
	STORE_DELAY_MS,
	TOKEN_LIFETIME_MS,
} from "./limits.js";
import {
	decideField,
	hashValues,
	initialMergeBase,
	isDocumentChanged,
	mergeBaseAfterMerge,
	mergeBaseAfterSave,
	type FieldDecision,
} from "./merge.js";
import { decodeCheckpoint, encodeCheckpoint } from "./snapshot.js";
import {
	CLOSE_CODES,
	RoomClaimLostError,
	RoomSaveError,
	ROOM_TOKEN_BYTES,
	roomId,
	type Build,
	type CheckpointInput,
	type CloseCode,
	type ConnectionInfo,
	type EntryRef,
	type Fingerprint,
	type LoadedEntry,
	type MergeBase,
	type OutsideValue,
	type RoomConnection,
	type RoomRecord,
	type RoomSite,
	type RoomStore,
	type RoomTimers,
	type SaveResult,
	type TokenClaims,
} from "./types.js";

export interface RoomOptions {
	entry: EntryRef;
	site: RoomSite;
	store: RoomStore;
	build: Build;
	timers: RoomTimers;
}

const LOG = "[co-editing]";
const MERGE_ORIGIN = Symbol("room-merge");
const STORAGE_ORIGIN = Symbol("room-storage");
const INVALID_CONTENT = "INVALID_CONTENT";
const SITE_UNAVAILABLE = "SITE_UNAVAILABLE";
const UNLOADED_MESSAGE = "The room unloaded before the save finished";
const LINEAGE_BYTES = 16;

const encoder = new TextEncoder();

interface LoadedState {
	generation: number;
	doc: Y.Doc;
	record: RoomRecord;
	checkpoint: Y.Snapshot;
	fields: DocumentField[];
	pluginTypes: string[];
	/** Fields touched since the last checkpoint. */
	pending: Set<string>;
	/** Emitted updates not yet stored. */
	buffer: Uint8Array[];
	/** A merge's emitted updates, relayed only once its record is stored. */
	mergeUpdates: Uint8Array[];
	/** `editors` changed since the last record write. */
	editorsChanged: boolean;
	autosaveQueued: boolean;
	/** The latest save ended in a conflict, so the next notification's merge saves again. */
	saveConflicted: boolean;
	/** Each user's latest credit, in credit order, to tell who updated after a save's snapshot. */
	credits: Map<string, number>;
	creditCount: number;
	storedBytes: number;
	updatedAt: number;
	cancelStore: (() => void) | null;
	cancelSave: (() => void) | null;
	cancelMaxSave: (() => void) | null;
}

type Phase =
	| { kind: "unloaded" }
	| { kind: "loaded"; state: LoadedState }
	| { kind: "dropping"; done: Promise<void> }
	| { kind: "shutting-down"; state: LoadedState | null };

interface Grant {
	claims: TokenClaims;
	expiresAt: number;
	cancel: () => void;
}

interface Hold {
	id: string;
	end: (options: { overwrite: boolean }) => void;
	merged: Promise<void>;
}

type SaveRequest =
	| { kind: "auto" }
	| { kind: "kept"; actor: string }
	| { kind: "operation"; actor: string; guarded: boolean };

type SaveOutcome =
	| { ok: true; rev: string }
	| { ok: false; reason: SaveFailure; code: string; message: string };

type SaveFailure = Exclude<SaveResult, { ok: true }>["reason"] | "INVALID_CONTENT" | "UNLOADED";

const UNLOADED: SaveOutcome = {
	ok: false,
	reason: "UNLOADED",
	code: "UNLOADED",
	message: UNLOADED_MESSAGE,
};
const UNREADABLE = {
	reason: INVALID_CONTENT,
	code: INVALID_CONTENT,
	message: "A field holds content that can't be saved",
} satisfies { reason: SaveFailure; code: string; message: string };

type MergeStep =
	| {
			kind: "merged";
			update: Uint8Array | undefined;
			written: string[];
			checkpoint: boolean;
			accessChanged: boolean;
	  }
	| { kind: "start-over"; code: CloseCode; recovery: boolean }
	| { kind: "failed" };

interface PresenceState {
	clock: number;
	state: Record<string, unknown>;
	owner: RoomConnection;
}

export class Room {
	readonly #entry: EntryRef;
	readonly #site: RoomSite;
	readonly #store: RoomStore;
	readonly #build: Build;
	readonly #timers: RoomTimers;

	#phase: Phase = { kind: "unloaded" };
	#generation = 0;
	#queue: Promise<unknown> = Promise.resolve();
	#storeChain: Promise<unknown> = Promise.resolve();
	#tokens = new Map<string, Grant>();
	#connections = new Map<RoomConnection, ConnectionInfo>();
	#presence = new Map<number, PresenceState>();
	#hold: Hold | null = null;
	#mergeQueued: Promise<void> | null = null;
	#lastClosedAt: number | null = null;
	#cancelClose: (() => void) | null = null;
	#claimed = false;
	#shuttingDown = false;
	/** When a store call or claim last succeeded: each renews the claim. */
	#renewedAt = Number.NEGATIVE_INFINITY;

	constructor(options: RoomOptions) {
		this.#entry = options.entry;
		this.#site = options.site;
		this.#store = options.store;
		this.#build = options.build;
		this.#timers = options.timers;
	}

	/** Open while it has connections or unused tokens, and for 10 s after its last connection closes. */
	isOpen(): boolean {
		if (this.#connections.size > 0) return true;
		const now = this.#timers.now();
		for (const grant of this.#tokens.values()) if (grant.expiresAt > now) return true;
		return this.#lastClosedAt !== null && now - this.#lastClosedAt < OPEN_AFTER_LAST_CONNECTION_MS;
	}

	async issueToken(
		claims: TokenClaims,
	): Promise<{ token: string } | "full" | "stale" | "busy" | null> {
		// Before the stale check, or every token from another build would start the room over.
		if (!sameBuild(claims.fingerprint, this.#build)) return null;
		try {
			const ready = await this.#readyForToken(claims);
			if (ready !== "ready") return ready;
			// A load already in flight when shutdown began can still finish ready.
			return this.#shuttingDown ? "busy" : this.#grant(claims);
		} finally {
			void this.#releaseIfClosed();
		}
	}

	async save(
		actorId: string,
		rev?: string,
	): Promise<{ rev: string; hold: string } | "conflict" | null> {
		if (!this.isOpen()) return null;
		return new Promise((resolve, reject) => {
			this.#enqueue(() => this.#operation(actorId, rev, resolve, reject)).catch(
				(error: unknown) => {
					reject(error);
					this.#logError("an operation failed", error);
				},
			);
		});
	}

	/** Ends the named hold and resolves once its merge ran. */
	async release(hold: string, options?: { overwrite?: boolean }): Promise<void> {
		const current = this.#hold;
		if (current?.id === hold) {
			current.end({ overwrite: options?.overwrite === true });
			await current.merged;
			return;
		}
		if (this.isOpen()) await this.#queueMerge();
	}

	async notify(outside: OutsideValue[]): Promise<void> {
		if (!this.isOpen()) return;
		if (outside.length > 0) this.#broadcastNotice({ kind: "values", values: outside });
		void this.#queueMerge();
	}

	async forgetTokens(userId: string): Promise<void> {
		for (const [token, grant] of this.#tokens) {
			if (grant.claims.userId === userId) this.#forgetToken(token);
		}
		void this.#releaseIfClosed();
	}

	/**
	 * Registers a socket with an unused token, or closes it with `busy`. Returns the connection's
	 * info, which the room keeps and updates, so a host can keep it with the socket.
	 */
	connect(connection: RoomConnection, token: string): ConnectionInfo | null {
		const grant = this.#tokens.get(token);
		const state = this.#loaded();
		if (!grant || !state || grant.expiresAt <= this.#timers.now()) {
			connection.close(CLOSE_CODES.busy, "No valid token");
			return null;
		}
		this.#forgetToken(token);
		const { claims } = grant;
		this.#reopen();
		const info: ConnectionInfo = {
			userId: claims.userId,
			name: claims.name,
			access: claims.access,
			connectedAt: this.#timers.now(),
			clientId: null,
		};
		this.#connections.set(connection, info);
		connection.send(
			encodeRoomMessage({
				type: "welcome",
				lineage: state.record.lineage,
				access: claims.access,
				snapshot: Y.encodeSnapshot(state.checkpoint),
			}),
		);
		if (claims.access === "edit") connection.send(encodeSyncStep1(state.doc));
		const presence = this.#presenceEntries();
		if (presence.length > 0) connection.send(encodeAwareness(presence));
		return info;
	}

	/**
	 * Registers a socket that outlived the room's memory. The room loads from storage when it next
	 * needs its state.
	 */
	resume(connection: RoomConnection, info: ConnectionInfo): void {
		this.#connections.set(connection, info);
		this.#reopen();
	}

	#reopen(): void {
		this.#cancelClose?.();
		this.#cancelClose = null;
		this.#lastClosedAt = null;
	}

	receive(connection: RoomConnection, message: Uint8Array): void {
		if (!this.#connections.has(connection)) return;
		if (this.#phase.kind === "unloaded") {
			const decoded = decodeMessage(message);
			if (decoded?.type === "awareness") {
				this.#closeOldConnections();
				const info = this.#connections.get(connection);
				if (info) this.#receivePresence(connection, info, decoded.entries);
				return;
			}
			void this.#enqueue(() => this.#resume()).then(() => this.receive(connection, message));
			return;
		}
		const state = this.#loaded();
		if (!state) return;
		this.#closeOldConnections();
		const info = this.#connections.get(connection);
		if (info) this.#handleMessage(state, connection, info, message);
	}

	disconnect(connection: RoomConnection): void {
		const info = this.#connections.get(connection);
		if (!info) return;
		this.#connections.delete(connection);
		this.#removePresence(connection, info);
		this.#touch();
		if (info.access === "edit" && !this.#hasCoEditors()) this.#queueAutosave();
		if (this.#connections.size === 0) {
			this.#lastClosedAt = this.#timers.now();
			this.#cancelClose?.();
			this.#cancelClose = this.#timers.set(OPEN_AFTER_LAST_CONNECTION_MS, () => {
				this.#cancelClose = null;
				void this.#releaseIfClosed();
			});
		}
	}

	/** Whether the room holds its Node.js claim. */
	get holdsClaim(): boolean {
		return this.#claimed;
	}

	/**
	 * Renews a held claim that no store call or claim renewed in the last half-interval, for the
	 * host's renewal tick. A lost claim closes every connection with `rejoin` and forgets the
	 * document.
	 */
	async renew(): Promise<void> {
		if (!this.#claimed || this.#timers.now() - this.#renewedAt < CLAIM_RENEWAL_MS / 2) return;
		let renewed = true;
		await this.#stored(null, async () => {
			if (this.#claimed) renewed = await this.#store.renew();
		});
		if (!renewed && this.#claimed) this.#claimLost();
	}

	/**
	 * Closes connections past their lifetime, then applies the hourly drop, for the host's alarm or
	 * cleanup.
	 */
	async expire(): Promise<void> {
		this.#closeOldConnections();
		if (this.isOpen() || this.#shuttingDown) return;
		await this.#enqueue(() => this.#expire());
		await this.#releaseIfClosed();
	}

	/**
	 * Stops applying updates, ends any operation's hold, stores, saves, releases the claim and
	 * closes every connection.
	 */
	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		this.#stopUpdates();
		this.#forgetAllTokens();
		this.#hold?.end({ overwrite: false });
		await this.#enqueue(async () => {
			// A token request queued before shutdown can have loaded state since.
			const state = this.#stopUpdates();
			if (state) {
				await this.#flush(state);
				if (this.#live(state)) await this.#saveTask(state, { kind: "auto" });
				this.#cancelTimers(state);
			}
			await this.#releaseClaim();
			this.#closeAll(CLOSE_CODES.rejoin, "The server is shutting down");
			this.#phase = { kind: "shutting-down", state: null };
		});
	}

	/** Moves the phase to shutting-down, where updates no longer apply, and returns its state. */
	#stopUpdates(): LoadedState | null {
		const phase = this.#phase;
		const state = phase.kind === "loaded" || phase.kind === "shutting-down" ? phase.state : null;
		this.#phase = { kind: "shutting-down", state };
		return state;
	}

	async #readyForToken(claims: TokenClaims): Promise<"ready" | "busy" | null> {
		while (this.#phase.kind === "dropping") await this.#phase.done;
		if (this.#shuttingDown) return "busy";
		const state = this.#loaded();
		if (state && !this.#needsPreparing(state, claims)) return "ready";
		return this.#enqueue(() => this.#prepareForToken(claims));
	}

	#needsPreparing(state: LoadedState, claims: TokenClaims): boolean {
		return (
			!sameFingerprint(state.record.fingerprint, claims.fingerprint) ||
			claims.rev !== state.record.mergeBase.rev ||
			!this.isOpen()
		);
	}

	async #prepareForToken(claims: TokenClaims): Promise<"ready" | "busy" | null> {
		if (this.#shuttingDown) return "busy";
		let state = this.#loaded();
		let entry: LoadedEntry | null | undefined;
		if (!state) {
			const stored = await this.#loadStored(false);
			if (stored === "busy" || stored === "failed") return stored === "busy" ? "busy" : null;
			if (stored === "empty") return (await this.#initialize(claims)) ? "ready" : null;
			({ state, entry } = stored);
		}
		if (!sameFingerprint(state.record.fingerprint, claims.fingerprint)) {
			const dropped = await this.#dropState(state, { code: CLOSE_CODES.rejoin, recovery: true });
			return dropped && (await this.#initialize(claims)) ? "ready" : null;
		}
		if (!this.#needsPreparing(state, claims)) return "ready";
		const merged = await this.#runMerge(state, { entry, open: this.isOpen() });
		if (merged === "failed") return null;
		if (merged === "dropped") return (await this.#initialize(claims)) ? "ready" : null;
		return "ready";
	}

	#grant(claims: TokenClaims): { token: string } | "full" | "stale" | null {
		const state = this.#loaded();
		if (!state) return null;
		if (state.record.status !== claims.status || state.record.authorId !== claims.authorId) {
			return "stale";
		}
		const now = this.#timers.now();
		let total = 0;
		let user = 0;
		for (const info of this.#connections.values()) {
			total++;
			if (info.userId === claims.userId) user++;
		}
		for (const grant of this.#tokens.values()) {
			if (grant.expiresAt <= now) continue;
			total++;
			if (grant.claims.userId === claims.userId) user++;
		}
		if (total >= MAX_ROOM_CONNECTIONS || user >= MAX_USER_CONNECTIONS) return "full";
		const token = randomId(ROOM_TOKEN_BYTES);
		const cancel = this.#timers.set(TOKEN_LIFETIME_MS, () => {
			this.#tokens.delete(token);
			void this.#releaseIfClosed();
		});
		this.#tokens.set(token, { claims, expiresAt: now + TOKEN_LIFETIME_MS, cancel });
		return { token };
	}

	/**
	 * Claims the room and loads its stored state. State from another build or schema, or past its
	 * hour, drops first. With `expiring`, state within its hour isn't loaded at all.
	 */
	async #loadStored(
		expiring: boolean,
	): Promise<"busy" | "failed" | "empty" | { state: LoadedState; entry: LoadedEntry | null }> {
		let stored: Awaited<ReturnType<RoomStore["load"]>>;
		try {
			if (!(await this.#claim())) return "busy";
			stored = await this.#store.load();
			this.#renewedAt = this.#timers.now();
		} catch (error) {
			this.#logError("couldn't load room storage", error);
			return "failed";
		}
		const { record, updates, updatedAt } = stored;
		if (!record) return "empty";
		const expired = updatedAt !== null && this.#timers.now() - updatedAt >= ROOM_STATE_LIFETIME_MS;
		if (expiring && !expired) return "failed";
		const entry = await this.#loadEntry();
		if (entry === undefined) return "failed";
		const fields = documentFields(entry?.fields ?? []);
		// State that can't be read back drops like stale state, so recovery keeps what can be read.
		let readable = true;
		const doc = new Y.Doc({ gc: true });
		doc.transact(() => {
			for (const update of updates) {
				try {
					Y.applyUpdate(doc, update);
				} catch (error) {
					readable = false;
					this.#logError("couldn't read a stored update", error);
				}
			}
		}, STORAGE_ORIGIN);
		let checkpoint: Y.Snapshot;
		try {
			checkpoint = decodeCheckpoint(record.checkpoint);
		} catch (error) {
			readable = false;
			this.#logError("couldn't read the stored checkpoint", error);
			checkpoint = Y.emptySnapshot;
		}
		const state = this.#adopt(
			doc,
			record,
			checkpoint,
			entry,
			new Set(fields.map((field) => field.slug)),
		);
		state.updatedAt = updatedAt ?? this.#timers.now();
		// The first stored update is the initial or compacted state; compaction counts what follows.
		state.storedBytes = updates.slice(1).reduce((total, update) => total + update.byteLength, 0);
		const stale =
			!readable ||
			!sameBuild(record.fingerprint, this.#build) ||
			(entry !== null && entry.hash !== record.fingerprint.hash);
		if (stale || expired) {
			const dropped = await this.#dropState(state, {
				code: CLOSE_CODES.rejoin,
				recovery: entry !== null,
			});
			return dropped ? "empty" : "failed";
		}
		if (this.#isUncovered(state)) this.#queueAutosave();
		return { state, entry };
	}

	/** Loads the stored state of a room whose sockets outlived its memory, or closes them. */
	async #resume(): Promise<{ state: LoadedState; entry: LoadedEntry | null } | null> {
		if (this.#phase.kind !== "unloaded" || this.#connections.size === 0) return null;
		const stored = await this.#loadStored(false);
		if (typeof stored !== "string") return stored;
		this.#closeAll(
			stored === "busy" ? CLOSE_CODES.busy : CLOSE_CODES.rejoin,
			"The room has no state to resume",
		);
		return null;
	}

	async #initialize(claims: TokenClaims): Promise<boolean> {
		try {
			if (!(await this.#claim())) return false;
		} catch (error) {
			this.#logError("couldn't claim the room", error);
			return false;
		}
		const entry = await this.#loadEntry();
		if (!entry || entry.trashed || entry.hash !== claims.fingerprint.hash) return false;
		const built = buildInitial(entry);
		if (!built) return false;
		const checkpoint = Y.snapshot(built.doc);
		const record: RoomRecord = {
			lineage: randomId(LINEAGE_BYTES),
			fingerprint: claims.fingerprint,
			checkpoint: encodeCheckpoint(checkpoint),
			mergeBase: built.mergeBase,
			editors: [],
			status: entry.status,
			authorId: entry.authorId,
		};
		const state = this.#adopt(built.doc, record, checkpoint, entry, new Set());
		const update = Y.encodeStateAsUpdate(built.doc);
		return this.#stored(state, () => this.#store.writeRecord(this.#recordOf(state), update));
	}

	/** The entry, null when it's gone, or undefined when the site can't be reached. */
	async #loadEntry(): Promise<LoadedEntry | null | undefined> {
		try {
			return await this.#site.load(this.#entry);
		} catch (error) {
			this.#logError("couldn't load the entry", error);
			return undefined;
		}
	}

	/** Makes a document the room's state, and starts tracking its updates. */
	#adopt(
		doc: Y.Doc,
		record: RoomRecord,
		checkpoint: Y.Snapshot,
		entry: LoadedEntry | null,
		pending: Set<string>,
	): LoadedState {
		const state: LoadedState = {
			generation: ++this.#generation,
			doc,
			record,
			checkpoint,
			fields: documentFields(entry?.fields ?? []),
			pluginTypes: entry?.pluginTypes ?? [],
			pending,
			buffer: [],
			mergeUpdates: [],
			editorsChanged: false,
			autosaveQueued: false,
			saveConflicted: false,
			credits: new Map(),
			creditCount: 0,
			storedBytes: 0,
			updatedAt: this.#timers.now(),
			cancelStore: null,
			cancelSave: null,
			cancelMaxSave: null,
		};
		doc.on(
			"update",
			(update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) =>
				this.#onUpdate(state, update, origin, transaction),
		);
		this.#phase = { kind: "loaded", state };
		return state;
	}

	#handleMessage(
		state: LoadedState,
		connection: RoomConnection,
		info: ConnectionInfo,
		bytes: Uint8Array,
	): void {
		const message = decodeMessage(bytes);
		const editor = info.access === "edit";
		if (!message) {
			if (editor) this.#close(connection, CLOSE_CODES.reset, "The message doesn't decode");
			return;
		}
		switch (message.type) {
			case "sync-step-1":
				connection.send(encodeSyncStep2(state.doc, message.stateVector));
				return;
			case "sync-step-2":
			case "sync-update":
				if (editor) this.#applyClientUpdate(state, connection, message.update);
				return;
			case "awareness":
				this.#receivePresence(connection, info, message.entries);
				return;
			case "save":
				if (editor) this.#queueSave({ kind: "kept", actor: info.userId });
				return;
			default:
				return;
		}
	}

	#applyClientUpdate(state: LoadedState, connection: RoomConnection, update: Uint8Array): void {
		if (update.byteLength > MAX_UPDATE_BYTES) {
			this.#close(connection, CLOSE_CODES.reset, "The update is too large");
			return;
		}
		try {
			Y.applyUpdate(state.doc, update, connection);
		} catch {
			this.#close(connection, CLOSE_CODES.reset, "The update doesn't apply");
		}
	}

	/**
	 * Stores and relays what the document emits rather than a client's bytes, so a partly applied
	 * update is kept as applied. Every connection gets it, the sender included: an update that
	 * unblocks pending structs carries other clients' content the sender lacks too.
	 */
	#onUpdate(
		state: LoadedState,
		update: Uint8Array,
		origin: unknown,
		transaction: Y.Transaction,
	): void {
		if (origin === STORAGE_ORIGIN) return;
		if (origin === MERGE_ORIGIN) {
			state.mergeUpdates.push(update);
			return;
		}
		state.buffer.push(update);
		this.#scheduleStore(state);
		this.#broadcast(encodeUpdate(update));
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- any other origin misses the map
		const info = this.#connections.get(origin as RoomConnection);
		if (info) this.#credit(state, info.userId, transaction);
	}

	#credit(state: LoadedState, userId: string, transaction: Y.Transaction): void {
		for (const field of touchedFields(transaction)) state.pending.add(field);
		state.credits.set(userId, ++state.creditCount);
		const { editors } = state.record;
		if (editors[0] !== userId) {
			state.record.editors = [userId, ...editors.filter((editor) => editor !== userId)];
			state.editorsChanged = true;
		}
		state.cancelSave?.();
		state.cancelSave = this.#timers.set(SAVE_DELAY_MS, () => this.#saveTimerFired(state));
		state.cancelMaxSave ??= this.#timers.set(MAX_SAVE_INTERVAL_MS, () =>
			this.#saveTimerFired(state),
		);
	}

	#saveTimerFired(state: LoadedState): void {
		this.#cancelSaveTimers(state);
		if (this.#live(state)) this.#queueAutosave();
	}

	#receivePresence(
		connection: RoomConnection,
		info: ConnectionInfo,
		entries: readonly AwarenessEntry[],
	): void {
		for (const entry of entries) {
			info.clientId ??= entry.clientId;
			if (entry.clientId !== info.clientId) continue;
			const held = this.#presence.get(entry.clientId);
			if (held && held.owner !== connection && this.#connections.has(held.owner)) continue;
			if (entry.state === null) {
				this.#presence.delete(entry.clientId);
				this.#broadcast(encodeAwareness([entry]));
				continue;
			}
			const user = { id: info.userId, name: info.name };
			const state = info.access === "edit" ? { ...entry.state, user } : { user };
			this.#presence.set(entry.clientId, { clock: entry.clock, state, owner: connection });
			this.#broadcast(encodeAwareness([{ clientId: entry.clientId, clock: entry.clock, state }]));
		}
	}

	#removePresence(connection: RoomConnection, info: ConnectionInfo): void {
		if (info.clientId === null) return;
		const held = this.#presence.get(info.clientId);
		if (!held || held.owner !== connection) return;
		this.#presence.delete(info.clientId);
		this.#broadcast(
			encodeAwareness([{ clientId: info.clientId, clock: held.clock + 1, state: null }]),
		);
	}

	#presenceEntries(): AwarenessEntry[] {
		return Array.from(this.#presence, ([clientId, { clock, state }]) => ({
			clientId,
			clock,
			state,
		}));
	}

	#closeOldConnections(): void {
		const oldest = this.#timers.now() - CONNECTION_LIFETIME_MS;
		for (const [connection, info] of this.#connections) {
			if (info.connectedAt <= oldest) this.#close(connection, CLOSE_CODES.rejoin, "Join again");
		}
	}

	/** Closes a socket and handles it as closed, since the host may not report it again. */
	#close(connection: RoomConnection, code: CloseCode, reason: string): void {
		connection.close(code, reason);
		this.disconnect(connection);
	}

	#closeAll(code: CloseCode, reason: string): void {
		for (const connection of this.#connections.keys()) this.#close(connection, code, reason);
	}

	#closeUser(userId: string, code: CloseCode, reason: string): void {
		for (const [connection, info] of this.#connections) {
			if (info.userId === userId) this.#close(connection, code, reason);
		}
	}

	#hasCoEditors(): boolean {
		for (const info of this.#connections.values()) if (info.access === "edit") return true;
		return false;
	}

	#broadcast(message: Uint8Array): void {
		for (const connection of this.#connections.keys()) connection.send(message);
	}

	#broadcastNotice(notice: Notice): void {
		this.#broadcast(encodeRoomMessage({ type: "notice", notice }));
	}

	#broadcastCheckpoint(state: LoadedState, editedBy: string[]): void {
		this.#broadcast(
			encodeRoomMessage({
				type: "checkpoint",
				editedBy,
				rev: state.record.mergeBase.rev,
				snapshot: Y.encodeSnapshot(state.checkpoint),
			}),
		);
	}

	#queueSave(request: SaveRequest): void {
		const state = this.#loaded();
		if (!state) return;
		if (request.kind === "auto") {
			if (state.autosaveQueued) return;
			state.autosaveQueued = true;
		}
		void this.#background(async () => {
			if (request.kind === "auto") state.autosaveQueued = false;
			if (this.#live(state)) await this.#saveTask(state, request);
		});
	}

	#queueAutosave(): void {
		this.#queueSave({ kind: "auto" });
	}

	/** A save, with a merge and one retry after a conflict. Null when there was nothing to save. */
	async #saveTask(state: LoadedState, request: SaveRequest): Promise<SaveOutcome | null> {
		if (request.kind === "auto" && !this.#hasWork(state)) return null;
		let outcome = await this.#saveOnce(state, request);
		if (outcome && !outcome.ok && outcome.reason === "CONFLICT" && this.#live(state)) {
			const merged = await this.#runMerge(state, {});
			const retry = request.kind !== "operation" || !request.guarded;
			if (merged === "merged" && retry && this.#live(state)) {
				outcome = await this.#saveOnce(state, request);
			}
		}
		if (outcome && !outcome.ok && outcome.reason === "NOT_FOUND" && this.#live(state)) {
			await this.#runMerge(state, {});
		}
		state.saveConflicted = outcome?.ok === false && outcome.reason === "CONFLICT";
		return outcome;
	}

	async #saveOnce(state: LoadedState, request: SaveRequest): Promise<SaveOutcome | null> {
		const actor = request.kind === "auto" ? state.record.editors[0] : request.actor;
		if (actor === undefined) return null;
		// One synchronous step, so fields touched while the save awaits stay pending.
		this.#cancelSaveTimers(state);
		const snapshot = Y.snapshot(state.doc);
		const swapped = state.pending;
		state.pending = new Set();
		const creditMark = state.creditCount;
		const editedBy = [...state.record.editors];
		let recorded = false;
		try {
			const { unreadable, ...sent } = this.#changedFields(state, swapped);
			if (unreadable && request.kind === "operation") return this.#saveFailed(request, UNREADABLE);
			const kept = request.kind !== "auto" && !unreadable;
			if (!(await this.#flush(state)) || !this.#live(state)) return UNLOADED;
			let base = state.record.mergeBase;
			const empty = sent.slug === undefined && Object.keys(sent.data).length === 0;
			if (!empty || kept) {
				const result = await this.#sendSave(state, request, {
					actorId: actor,
					rev: base.rev,
					...sent,
					kept,
					editedBy,
				});
				if (!this.#live(state)) return UNLOADED;
				if (!result.ok) return this.#saveFailed(request, result);
				base = mergeBaseAfterSave(base, sent, result);
			}
			if (unreadable) {
				// No checkpoint, so the unreadable field's edits never show as saved.
				if (base !== state.record.mergeBase) {
					state.record.mergeBase = base;
					if (!(await this.#writeRecord(state))) return UNLOADED;
				}
				return this.#saveFailed(request, UNREADABLE);
			}
			recorded = true;
			const written = await this.#recordCheckpoint(state, snapshot, base, editedBy, creditMark);
			return written ? { ok: true, rev: base.rev } : UNLOADED;
		} finally {
			if (!recorded) for (const field of swapped) state.pending.add(field);
		}
	}

	/**
	 * The pending fields, and fields whose document hash was cleared, that differ from the merge
	 * base's document hash, without any that can't be read or hashed.
	 */
	#changedFields(
		state: LoadedState,
		pending: ReadonlySet<string>,
	): Pick<CheckpointInput, "data" | "slug"> & { unreadable: boolean } {
		const base = state.record.mergeBase.document;
		const data: Record<string, unknown> = {};
		let slug: string | null | undefined;
		let unreadable = false;
		for (const field of state.fields) {
			if (!pending.has(field.slug) && base[field.slug] !== null) continue;
			try {
				const value = readField(state.doc, field);
				if (hashValue(value) === base[field.slug]) continue;
				if (field === ENTRY_SLUG) slug = slugValue(value);
				else data[field.slug] = value;
			} catch {
				console.warn(`${LOG} room ${this.#roomId()} can't save field ${field.slug}`);
				unreadable = true;
			}
		}
		return slug === undefined ? { data, unreadable } : { data, slug, unreadable };
	}

	/** Sends a save, then as each next user in `editedBy` while the site refuses the actor. */
	async #sendSave(
		state: LoadedState,
		request: SaveRequest,
		input: CheckpointInput,
	): Promise<SaveResult> {
		let actorId = input.actorId;
		const next =
			request.kind === "operation" ? [] : input.editedBy.filter((user) => user !== actorId);
		for (;;) {
			const result = await this.#callSave({ ...input, actorId });
			if (!this.#live(state) || result.ok || result.reason !== "FORBIDDEN") return result;
			void this.forgetTokens(actorId);
			this.#closeUser(actorId, CLOSE_CODES.rejoin, "Edit access changed");
			const following = next.shift();
			if (following === undefined) return result;
			actorId = following;
		}
	}

	async #callSave(input: CheckpointInput): Promise<SaveResult> {
		try {
			return await this.#site.save(this.#entry, input);
		} catch (error) {
			this.#logError("couldn't reach the site to save", error);
			return {
				ok: false,
				reason: "REFUSED",
				code: SITE_UNAVAILABLE,
				message: "The site couldn't be reached",
			};
		}
	}

	#saveFailed(
		request: SaveRequest,
		failure: { reason: SaveFailure; code: string; message: string },
	): SaveOutcome {
		const refused = failure.reason === "REFUSED" || failure.reason === INVALID_CONTENT;
		if (refused && request.kind !== "operation") {
			this.#broadcastNotice({ kind: "refused", code: failure.code, message: failure.message });
		}
		return { ok: false, reason: failure.reason, code: failure.code, message: failure.message };
	}

	/** Records a checkpoint and the merge base, writes the record, and broadcasts the checkpoint. */
	async #recordCheckpoint(
		state: LoadedState,
		snapshot: Y.Snapshot,
		base: MergeBase,
		editedBy: readonly string[],
		creditMark: number,
	): Promise<boolean> {
		state.checkpoint = snapshot;
		state.record.checkpoint = encodeCheckpoint(snapshot);
		state.record.mergeBase = base;
		const editors = state.record.editors.filter(
			(user) => !editedBy.includes(user) || (state.credits.get(user) ?? 0) > creditMark,
		);
		if (editors.length !== state.record.editors.length) {
			state.record.editors = editors;
			state.editorsChanged = true;
		}
		if (!(await this.#writeRecord(state))) return false;
		this.#broadcastCheckpoint(state, [...editedBy]);
		return true;
	}

	#queueMerge(): Promise<void> {
		if (this.#mergeQueued) return this.#mergeQueued;
		const state = this.#loaded();
		if (!state && this.#phase.kind !== "unloaded") return Promise.resolve();
		const queued = this.#enqueue(async () => {
			this.#mergeQueued = null;
			const resumed = state ? null : await this.#resume();
			const current = resumed?.state ?? state ?? this.#loaded();
			if (current && this.#live(current)) {
				const merged = await this.#runMerge(current, { entry: resumed?.entry });
				if (merged === "merged" && this.#savesAfterMerge(current)) this.#queueAutosave();
			}
		});
		this.#mergeQueued = queued;
		return queued;
	}

	/**
	 * Loads the entry, unless given, and merges it. "dropped" when the room started over. Only a
	 * token request merges as a room that isn't open; any other merge runs for an open room, even
	 * if it closed while the merge waited in the queue.
	 */
	async #runMerge(
		state: LoadedState,
		options: { entry?: LoadedEntry | null; overwrite?: boolean; open?: boolean },
	): Promise<"merged" | "dropped" | "failed"> {
		let entry = options.entry;
		if (entry === undefined) {
			entry = await this.#loadEntry();
			if (entry === undefined || !this.#live(state)) return "failed";
		}
		const step = this.#mergeEntry(state, entry, options.overwrite === true, options.open ?? true);
		if (step.kind === "failed") return "failed";
		if (step.kind === "start-over") {
			const dropped = await this.#dropState(state, { code: step.code, recovery: step.recovery });
			return dropped ? "dropped" : "failed";
		}
		if (!(await this.#writeRecord(state)) || !this.#live(state)) return "failed";
		if (step.update) this.#broadcast(encodeUpdate(step.update));
		if (step.written.length > 0) this.#broadcastNotice({ kind: "outside", fields: step.written });
		if (step.checkpoint) this.#broadcastCheckpoint(state, []);
		if (step.accessChanged) {
			this.#forgetAllTokens();
			this.#closeAll(CLOSE_CODES.rejoin, "The entry's status or author changed");
		}
		return "merged";
	}

	/**
	 * The merge's synchronous step: no update lands between comparing, writing and serializing.
	 * Every field is decided before any is written, so a start-over writes nothing.
	 */
	#mergeEntry(
		state: LoadedState,
		entry: LoadedEntry | null,
		overwrite: boolean,
		open: boolean,
	): MergeStep {
		if (!entry) return { kind: "start-over", code: CLOSE_CODES.deleted, recovery: false };
		if (entry.trashed) return { kind: "start-over", code: CLOSE_CODES.deleted, recovery: true };
		if (entry.hash !== state.record.fingerprint.hash) {
			return { kind: "start-over", code: CLOSE_CODES.rejoin, recovery: true };
		}
		const fields = documentFields(entry.fields);
		const values = storedValues(entry);
		let stored: Record<string, string>;
		try {
			stored = hashValues(values);
		} catch (error) {
			this.#logError("couldn't hash the stored entry", error);
			return { kind: "failed" };
		}
		const base = state.record.mergeBase;
		const covered = !this.#isUncovered(state);
		const decisions: Array<[DocumentField, FieldDecision]> = [];
		for (const field of fields) {
			const storedChanged = stored[field.slug] !== base.stored[field.slug];
			const current = tryHashField(state.doc, field);
			const decision = overwrite
				? storedChanged
					? "write"
					: "none"
				: decideField({
						storedChanged,
						documentChanged:
							current === null ||
							isDocumentChanged(base.document[field.slug], state.pending.has(field.slug), current),
						valuesDiffer: current !== stored[field.slug],
						open,
					});
			if (decision === "start-over") {
				return { kind: "start-over", code: CLOSE_CODES.rejoin, recovery: true };
			}
			decisions.push([field, decision]);
		}
		state.fields = fields;
		state.pluginTypes = entry.pluginTypes;
		const written: Record<string, string> = {};
		const kept: string[] = [];
		for (const [field, decision] of decisions) {
			if (decision === "keep-document") kept.push(field.slug);
			if (decision !== "write") continue;
			if (!writeField(state.doc, field, values[field.slug], entry.pluginTypes, MERGE_ORIGIN))
				continue;
			const hash = tryHashField(state.doc, field);
			if (hash === null) kept.push(field.slug);
			else written[field.slug] = hash;
		}
		state.record.mergeBase = mergeBaseAfterMerge(base, { rev: entry.rev, stored, written, kept });
		if (covered) {
			state.checkpoint = Y.snapshot(state.doc);
			state.record.checkpoint = encodeCheckpoint(state.checkpoint);
			state.pending = new Set();
		}
		const accessChanged =
			entry.status !== state.record.status || entry.authorId !== state.record.authorId;
		state.record.status = entry.status;
		state.record.authorId = entry.authorId;
		const updates = state.mergeUpdates.splice(0);
		const update = updates.length > 0 ? Y.mergeUpdates(updates) : undefined;
		// Buffered in this step, so every record written from now on, with the new merge base,
		// stores the update too: a flush queued earlier can write the record before this merge does.
		if (update) state.buffer.push(update);
		return {
			kind: "merged",
			update,
			written: Object.keys(written),
			checkpoint: covered,
			accessChanged,
		};
	}

	/** One queue task from the kept save to the end of its hold's merge. */
	async #operation(
		actorId: string,
		rev: string | undefined,
		resolve: (result: { rev: string; hold: string } | "conflict" | null) => void,
		reject: (error: unknown) => void,
	): Promise<void> {
		let state: LoadedState | null;
		let outcome: SaveOutcome | null;
		try {
			state = this.#loaded() ?? (await this.#resume())?.state ?? null;
			if (!state) return resolve(null);
			// The caller's `_rev` is checked against the stored entry's, which an unmerged write moved.
			if (rev !== undefined && rev !== state.record.mergeBase.rev) {
				await this.#runMerge(state, {});
				if (!this.#live(state)) return resolve(null);
			}
			if (rev !== undefined && (rev !== state.record.mergeBase.rev || this.#isUncovered(state))) {
				return resolve("conflict");
			}
			const guarded = rev !== undefined;
			outcome = await this.#saveTask(state, { kind: "operation", actor: actorId, guarded });
		} catch (error) {
			return reject(error);
		}
		if (!outcome) return reject(new RoomSaveError("UNLOADED", "UNLOADED", UNLOADED_MESSAGE));
		if (!outcome.ok) {
			if (outcome.reason === "CONFLICT" && rev !== undefined) return resolve("conflict");
			return reject(new RoomSaveError(outcome.reason, outcome.code, outcome.message));
		}
		const ended = deferred<{ overwrite: boolean }>();
		const merged = deferred();
		const hold: Hold = {
			id: randomId(ROOM_TOKEN_BYTES),
			end: ended.resolve,
			merged: merged.promise,
		};
		this.#hold = hold;
		const cancel = this.#timers.set(OPERATION_HOLD_MS, () => ended.resolve({ overwrite: false }));
		this.#broadcastNotice({ kind: "operation", by: actorId });
		resolve({ rev: outcome.rev, hold: hold.id });
		const { overwrite } = await ended.promise;
		cancel();
		this.#hold = null;
		try {
			if (this.#live(state)) await this.#runMerge(state, { overwrite });
		} finally {
			merged.resolve();
		}
	}

	async #expire(): Promise<void> {
		if (this.isOpen()) return;
		const state = this.#loaded();
		if (!state) {
			await this.#loadStored(true);
			return;
		}
		if (this.#timers.now() - state.updatedAt >= ROOM_STATE_LIFETIME_MS) {
			await this.#dropState(state, { recovery: true });
		}
	}

	/**
	 * Forgets unused tokens, saves uncovered updates as a recovery revision, closes connections
	 * with `code`, and drops the stored state. If the recovery save fails, storage keeps the state
	 * to try again later. Unloads either way. Resolves to whether the state dropped.
	 */
	async #dropState(
		state: LoadedState,
		{ code, recovery }: { code?: CloseCode; recovery: boolean },
	): Promise<boolean> {
		const finished = deferred();
		this.#phase = { kind: "dropping", done: finished.promise };
		this.#cancelTimers(state);
		this.#forgetAllTokens();
		try {
			const saved = !recovery || !this.#isUncovered(state) || (await this.#saveRecovery(state));
			if (code !== undefined) this.#closeAll(code, "The room started over");
			if (saved) return await this.#stored(null, () => this.#store.drop());
			// The next try loads from storage, so it needs the updates not stored yet.
			await this.#stored(null, () => this.#storeBuffered(state));
			return false;
		} finally {
			this.#phase = { kind: "unloaded" };
			state.doc.destroy();
			finished.resolve();
		}
	}

	/**
	 * Every field the document holds, read without the schema and by the document's own layout,
	 * so fields from before a schema change still save.
	 */
	async #saveRecovery(state: LoadedState): Promise<boolean> {
		const data: Record<string, unknown> = {};
		const saved = new Set<string>();
		const base = state.record.mergeBase.document;
		let slug: string | null = null;
		for (const field of layoutFields(state.doc)) {
			try {
				const value = readField(state.doc, field);
				const hash = hashValue(value);
				if (field === ENTRY_SLUG) slug = slugValue(value);
				else data[field.slug] = value;
				if (hash === base[field.slug]) saved.add(field.slug);
			} catch {
				console.warn(
					`${LOG} room ${this.#roomId()} left field ${field.slug} out of a recovery revision`,
				);
			}
		}
		if (jsonBytes(data) > MAX_RECOVERY_BYTES) {
			for (const key of saved) delete data[key];
			const sizes = Object.entries(data).map(([key, value]) => ({ key, bytes: jsonBytes(value) }));
			for (const { key } of sizes.toSorted((a, b) => b.bytes - a.bytes)) {
				if (jsonBytes(data) <= MAX_RECOVERY_BYTES) break;
				delete data[key];
				console.warn(
					`${LOG} room ${this.#roomId()} left field ${key} out of a recovery revision over the size limit`,
				);
			}
		}
		try {
			await this.#site.saveRecovery(this.#entry, {
				data,
				slug,
				editedBy: [...state.record.editors],
			});
			return true;
		} catch (error) {
			this.#logError("couldn't save a recovery revision", error);
			return false;
		}
	}

	/** Once the room isn't open and has finished writing, it unloads and releases its claim. */
	#releaseIfClosed(): Promise<void> {
		if (this.isOpen() || this.#shuttingDown) return Promise.resolve();
		if (this.#phase.kind === "unloaded" && !this.#claimed) return Promise.resolve();
		return this.#background(async () => {
			if (this.isOpen() || this.#shuttingDown) return;
			const state = this.#loaded();
			if (state) {
				if (!(await this.#flush(state)) || !this.#live(state) || this.isOpen()) return;
				this.#unload(state);
			}
			await this.#releaseClaim();
		});
	}

	/**
	 * Pushes the hourly drop back. A room woken only by a resumed socket's close claims first, in
	 * the queue, so its claim can't race a load's.
	 */
	#touch(): void {
		const state = this.#loaded();
		if (state) {
			if (this.#claimed) void this.#stored(state, () => this.#store.touch());
		} else if (this.#phase.kind === "unloaded") {
			void this.#background(async () => {
				if (this.#phase.kind !== "unloaded" || !(await this.#claim())) return;
				await this.#stored(null, () => this.#store.touch());
			});
		}
	}

	async #claim(): Promise<boolean> {
		if (this.#claimed) return true;
		this.#claimed = await this.#store.claim();
		if (this.#claimed) this.#renewedAt = this.#timers.now();
		return this.#claimed;
	}

	#claimLost(): void {
		this.#claimed = false;
		this.#closeAll(CLOSE_CODES.rejoin, "The room moved");
		const state = this.#loaded();
		if (state) this.#unload(state);
	}

	async #releaseClaim(): Promise<void> {
		if (!this.#claimed) return;
		this.#claimed = false;
		await this.#stored(null, () => this.#store.release());
	}

	#unload(state: LoadedState): void {
		this.#cancelTimers(state);
		this.#forgetAllTokens();
		if (this.#live(state)) this.#phase = { kind: "unloaded" };
		state.doc.destroy();
	}

	/**
	 * Runs a store call on the room's one promise chain, so calls commit in order. Calls for a
	 * state that has since unloaded are skipped. A failure unloads the room.
	 */
	async #stored(state: LoadedState | null, call: () => Promise<unknown>): Promise<boolean> {
		const run = this.#storeChain.then(async () => {
			if (state && !this.#live(state)) return false;
			await call();
			return true;
		});
		this.#storeChain = run.catch(() => {});
		try {
			const ran = await run;
			if (ran) this.#renewedAt = this.#timers.now();
			if (ran && state) state.updatedAt = this.#timers.now();
			return ran;
		} catch (error) {
			this.#storeFailed(state, error);
			return false;
		}
	}

	#storeFailed(state: LoadedState | null, error: unknown): void {
		this.#logError("room storage failed", error);
		if (!state || !this.#live(state)) return;
		if (error instanceof RoomClaimLostError) {
			this.#claimed = false;
			this.#closeAll(CLOSE_CODES.rejoin, "The room moved");
		} else {
			this.#closeAll(CLOSE_CODES.reset, "The room can't store");
		}
		this.#unload(state);
		void this.#releaseIfClosed();
	}

	#scheduleStore(state: LoadedState): void {
		state.cancelStore ??= this.#timers.set(STORE_DELAY_MS, () => {
			state.cancelStore = null;
			if (this.#live(state)) void this.#flush(state);
		});
	}

	#flush(state: LoadedState): Promise<boolean> {
		state.cancelStore?.();
		state.cancelStore = null;
		return this.#stored(state, () => this.#storeBuffered(state));
	}

	/** Stores buffered updates, with the record when `editors` changed, so a restart keeps names. */
	async #storeBuffered(state: LoadedState): Promise<void> {
		if (state.buffer.length === 0) return;
		if (state.editorsChanged) {
			await this.#writeRecordNow(state);
			return;
		}
		const updates = state.buffer.splice(0);
		await this.#store.append(updates);
		await this.#counted(state, updates);
	}

	/** Writes the record, as of when the call runs, with every buffered update. */
	#writeRecord(state: LoadedState): Promise<boolean> {
		return this.#stored(state, () => this.#writeRecordNow(state));
	}

	async #writeRecordNow(state: LoadedState): Promise<void> {
		const updates = state.buffer.splice(0);
		const merged = updates.length > 0 ? Y.mergeUpdates(updates) : undefined;
		state.editorsChanged = false;
		await this.#store.writeRecord(this.#recordOf(state), merged);
		await this.#counted(state, merged ? [merged] : []);
	}

	/** Compacts past 1 MB stored since the last compaction. A compacted state over 2 MB drops. */
	async #counted(state: LoadedState, updates: readonly Uint8Array[]): Promise<void> {
		for (const update of updates) state.storedBytes += update.byteLength;
		if (state.storedBytes <= COMPACTION_BYTES) return;
		const compacted = Y.encodeStateAsUpdate(state.doc);
		await this.#store.compact(compacted);
		state.storedBytes = 0;
		if (compacted.byteLength > MAX_COMPACTED_BYTES)
			void this.#background(() => this.#outgrown(state));
	}

	async #outgrown(state: LoadedState): Promise<void> {
		if (!this.#live(state)) return;
		await this.#saveTask(state, { kind: "auto" });
		if (!this.#live(state)) return;
		this.#closeAll(CLOSE_CODES.rejoin, "The document is too large for co-editing");
		await this.#dropState(state, { recovery: true });
	}

	#recordOf(state: LoadedState): RoomRecord {
		return structuredClone(state.record);
	}

	#loaded(): LoadedState | null {
		return this.#phase.kind === "loaded" ? this.#phase.state : null;
	}

	/** Whether `state` is still the room's: a task checks this after every await. */
	#live(state: LoadedState): boolean {
		const phase = this.#phase;
		return (
			(phase.kind === "loaded" || phase.kind === "shutting-down") &&
			phase.state?.generation === state.generation
		);
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task);
		this.#queue = run.catch(() => {});
		return run;
	}

	async #background(task: () => Promise<unknown>): Promise<void> {
		try {
			await this.#enqueue(task);
		} catch (error) {
			this.#logError("a room task failed", error);
		}
	}

	#isUncovered(state: LoadedState): boolean {
		return !snapshotContains(state.checkpoint, Y.snapshot(state.doc));
	}

	/** After a save gave up on a conflict, a notification's merge saves what no timer will. */
	#savesAfterMerge(state: LoadedState): boolean {
		return (
			state.saveConflicted && state.cancelSave === null && this.isOpen() && this.#isUncovered(state)
		);
	}

	#hasWork(state: LoadedState): boolean {
		return (
			this.#isUncovered(state) || Object.values(state.record.mergeBase.document).includes(null)
		);
	}

	#cancelSaveTimers(state: LoadedState): void {
		state.cancelSave?.();
		state.cancelSave = null;
		state.cancelMaxSave?.();
		state.cancelMaxSave = null;
	}

	#cancelTimers(state: LoadedState): void {
		this.#cancelSaveTimers(state);
		state.cancelStore?.();
		state.cancelStore = null;
	}

	#forgetToken(token: string): void {
		this.#tokens.get(token)?.cancel();
		this.#tokens.delete(token);
	}

	#forgetAllTokens(): void {
		for (const token of this.#tokens.keys()) this.#forgetToken(token);
	}

	#roomId(): string {
		return roomId(this.#entry);
	}

	#logError(message: string, error: unknown): void {
		console.error(`${LOG} room ${this.#roomId()} ${message}:`, error);
	}
}

function sameBuild(a: Build, b: Build): boolean {
	return a.version === b.version && a.commit === b.commit;
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return sameBuild(a, b) && a.hash === b.hash;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function randomId(bytes: number): string {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return encodeBase64urlNoPadding(value);
}

function jsonBytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function slugValue(value: unknown): string | null {
	if (value === null || typeof value === "string") return value;
	throw new TypeError("The slug isn't a string");
}

/** The field's hash in the document, or null when a client wrote content that can't serialize. */
function tryHashField(doc: Y.Doc, field: DocumentField): string | null {
	try {
		return hashValue(readField(doc, field));
	} catch {
		return null;
	}
}

/** A new document and its merge base, or null for an entry a room refuses. */
function buildInitial(entry: LoadedEntry): { doc: Y.Doc; mergeBase: MergeBase } | null {
	const fields = documentFields(entry.fields);
	const values = storedValues(entry);
	for (const field of fields) {
		const value = values[field.slug];
		if (field.type !== "portableText" || !Array.isArray(value)) continue;
		if (findUnsupportedPortableTextMarks(value).length > 0) return null;
	}
	try {
		if (encoder.encode(JSON.stringify(entry.data)).byteLength > MAX_ENTRY_BYTES) return null;
		const doc = buildDocument(entry);
		return {
			doc,
			mergeBase: initialMergeBase(entry.rev, values, readFields(doc, fields)),
		};
	} catch {
		return null;
	}
}
