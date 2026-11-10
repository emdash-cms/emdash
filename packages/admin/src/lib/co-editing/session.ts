/**
 * A co-editing session for one entry: a pure reducer over the session's phases, and a runner that
 * executes its effects. Loads no Yjs: the replica, its socket and its protocol code live in the
 * chunk `loadReplicaModule` imports on the first room join.
 */

import { CLOSE_CODES, type Notice, type RoomAccess } from "../../co-editing/types.js";
import { ApiResponseError, type AdminManifest } from "../api/client.js";
import type { JoinOutcome, JoinRequest, RecoveryInput, RoomFingerprint } from "../api/rooms.js";
import type { TransportHealth } from "./transport-health.js";
import type { CoEditing, RoomEditing, RoomEvent } from "./types.js";

const RETRY_BUSY_MS = 5000;
const OFFLINE_NOTICE_MS = 5000;
const OFFLINE_RETRY_MS = [0, 1000, 2000, 4000, 5000];
/** How often a retry held while the browser is offline checks whether it's back. */
const OFFLINE_RECHECK_MS = 5000;
/** Rejoins after a `rejoin` or reset close that never stayed live before waiting as for `busy`. */
const REJOINS_BEFORE_WAIT = 2;
/** A connection that stayed live this long starts a new absence when it closes. */
const STEADY_LIVE_MS = 10_000;
/** The host closes a socket whose frame is too large with 1009, which resets like `reset`. */
const CLOSE_TOO_LARGE = 1009;
/** The waits before each new attempt at a recovery revision that failed for a network or server error. */
const RECOVERY_RETRY_MS = [1000, 4000];

export interface ReplicaInfo {
	readonly lineage: string;
	readonly access: RoomAccess;
}

/** Since when the tab has been disconnected, and how its retries went. */
export interface Away {
	readonly since: number;
	/** Retries scheduled since the network dropped, which pick the next delay. */
	readonly attempt: number;
	/** `rejoin` and reset closes in a row on connections that never stayed live. */
	readonly rejoins: number;
}

/** `deleted`: the entry went to Trash or is gone. `no-rooms`: the host runs no rooms. */
export type SingleEditorReason = "server" | "locked" | "pinned" | "deleted" | "error" | "no-rooms";
/**
 * Why a join asks for single-editor mode: the browser session is pinned to it, or the replica's
 * code didn't load. Either way the server forgets the tokens this user's tab didn't use.
 */
export type SingleEditorJoin = "pinned" | "load-failed";
/** What a join asked for, which its retry asks for again. */
export interface JoinIntent {
	readonly takeover: boolean;
	readonly singleEditor: SingleEditorJoin | null;
}
const PLAIN_JOIN: JoinIntent = { takeover: false, singleEditor: null };
export type KeptReason = "access" | "deleted" | "recovery-failed";
export type RecoveryTarget =
	| { readonly kind: "rejoin" }
	| { readonly kind: "reload" }
	| { readonly kind: "single-editor"; readonly reason: SingleEditorReason };

/** `replica` is the synced replica, if the tab has one. Each phase holds only what is valid in it. */
export type SessionState =
	| {
			readonly kind: "joining";
			readonly replica: ReplicaInfo | null;
			readonly away: Away | null;
			readonly takeover: boolean;
			readonly singleEditor: SingleEditorJoin | null;
	  }
	| {
			readonly kind: "connecting";
			readonly replica: ReplicaInfo | null;
			readonly away: Away | null;
			/** The join was a Take over, which a join after a failed chunk load asks for again. */
			readonly takeover: boolean;
			readonly welcomed: ReplicaInfo | null;
	  }
	| {
			readonly kind: "live";
			readonly replica: ReplicaInfo;
			/** When it reached live. */
			readonly at: number;
			/** The absence it ended, which a close before it stays live continues. */
			readonly ended: Away | null;
	  }
	| {
			readonly kind: "waiting";
			readonly replica: ReplicaInfo | null;
			readonly away: Away;
			readonly reason: "offline" | "busy";
			readonly join: JoinIntent;
	  }
	| { readonly kind: "recovering"; readonly replica: ReplicaInfo; readonly next: RecoveryTarget }
	| { readonly kind: "kept"; readonly replica: ReplicaInfo; readonly reason: KeptReason }
	| { readonly kind: "single-editor"; readonly reason: SingleEditorReason }
	| { readonly kind: "reloading" };

/**
 * `uncovered`: the tab's replica holds own edits no checkpoint contains. `unsavedForm`: a Take over
 * or Join found unsaved edits in the single-editor form. `at`: the clock's time.
 */
export type SessionEvent =
	| {
			readonly type: "joined";
			readonly outcome: JoinOutcome;
			readonly uncovered: boolean;
			readonly unsavedForm: boolean;
			readonly reloadedRecently: boolean;
			/** Whether the browser had a network connection when the answer came. */
			readonly online: boolean;
			readonly at: number;
	  }
	| { readonly type: "load-failed" }
	| {
			readonly type: "welcome";
			readonly lineage: string;
			readonly access: RoomAccess;
			readonly uncovered: boolean;
	  }
	| { readonly type: "synced"; readonly at: number }
	| {
			readonly type: "closed";
			readonly code: number;
			readonly opened: boolean;
			readonly uncovered: boolean;
			/** This socket pinned the browser session to single-editor mode. */
			readonly noWebSockets: boolean;
			readonly at: number;
	  }
	| { readonly type: "offline"; readonly at: number }
	| { readonly type: "online" }
	| { readonly type: "retry" }
	| { readonly type: "recovered"; readonly ok: boolean }
	| { readonly type: "take-over" }
	| { readonly type: "reload" };

export type SessionEffect =
	| { readonly type: "join"; readonly takeover: boolean; readonly singleEditor: boolean }
	| {
			readonly type: "connect";
			readonly url: string;
			readonly token: string;
			readonly fresh: boolean;
	  }
	| { readonly type: "close-connection" }
	| { readonly type: "discard-replica" }
	| { readonly type: "freeze-replica" }
	| { readonly type: "recover" }
	| { readonly type: "retry-in"; readonly ms: number }
	| { readonly type: "reload"; readonly outdated: boolean }
	| { readonly type: "lock-take-over" }
	| { readonly type: "emit"; readonly event: RoomEvent };

export interface Transition {
	readonly state: SessionState;
	readonly effects: readonly SessionEffect[];
}

const RELOADING: SessionState = { kind: "reloading" };
const DISCARD: SessionEffect = { type: "discard-replica" };
const CLOSE: SessionEffect = { type: "close-connection" };
const RECOVERED: SessionEffect = { type: "emit", event: { kind: "recovered" } };
const OUTDATED: SessionEffect = { type: "emit", event: { kind: "outdated" } };
const RECONNECTED: SessionEffect = { type: "emit", event: { kind: "reconnected" } };
const LOCK_TAKE_OVER: SessionEffect = { type: "lock-take-over" };

/**
 * The first join. A browser session pinned to single-editor mode asks for it. A host that runs no
 * rooms starts in single-editor mode without one.
 */
export function start(pinned: boolean, rooms = true): Transition {
	if (!rooms) return { state: { kind: "single-editor", reason: "no-rooms" }, effects: [] };
	return joining(null, null, false, pinned ? "pinned" : null);
}

/** Pure and total: an event that doesn't apply returns the same state and no effects. */
export function transition(state: SessionState, event: SessionEvent): Transition {
	switch (event.type) {
		case "joined":
			return state.kind === "joining" ? joined(state, event) : stay(state);
		case "load-failed":
			return state.kind === "connecting"
				? joining(null, state.away, state.takeover, "load-failed")
				: stay(state);
		case "welcome":
			return state.kind === "connecting" && !state.welcomed ? welcomed(state, event) : stay(state);
		case "synced":
			return state.kind === "connecting" && state.welcomed
				? {
						state: { kind: "live", replica: state.welcomed, at: event.at, ended: state.away },
						effects: state.away ? [RECONNECTED] : [],
					}
				: stay(state);
		case "closed":
			return state.kind === "connecting" || state.kind === "live"
				? closed(state, event)
				: stay(state);
		case "offline":
			return state.kind === "connecting" || state.kind === "live"
				? retryOffline(
						state.replica,
						continuedAway(state, event.at) ?? freshAway(event.at),
						[CLOSE],
						{ takeover: state.kind === "connecting" && state.takeover, singleEditor: null },
					)
				: stay(state);
		case "online":
			return state.kind === "waiting" && state.reason === "offline"
				? joining(state.replica, state.away, state.join.takeover, state.join.singleEditor)
				: stay(state);
		case "retry":
			return state.kind === "waiting"
				? joining(state.replica, state.away, state.join.takeover, state.join.singleEditor)
				: stay(state);
		case "recovered":
			return state.kind === "recovering" ? recovered(state, event.ok) : stay(state);
		case "take-over":
			if (state.kind !== "single-editor") return stay(state);
			if (state.reason === "no-rooms") return { state, effects: [LOCK_TAKE_OVER] };
			return joining(null, null, true, state.reason === "pinned" ? "pinned" : null);
		case "reload":
			return state.kind === "kept"
				? { state: RELOADING, effects: [{ type: "reload", outdated: false }] }
				: stay(state);
	}
}

/** The synced replica the tab holds, in any phase. */
export function syncedReplica(state: SessionState): ReplicaInfo | null {
	return "replica" in state ? state.replica : null;
}

function joined(
	state: Extract<SessionState, { kind: "joining" }>,
	event: Extract<SessionEvent, { type: "joined" }>,
): Transition {
	const { replica, away, takeover } = state;
	const { outcome } = event;
	const intent: JoinIntent = { takeover, singleEditor: state.singleEditor };
	switch (outcome.kind) {
		case "room":
			return {
				state: { kind: "connecting", replica, away, takeover, welcomed: null },
				effects: [
					{ type: "connect", url: outcome.url, token: outcome.token, fresh: replica === null },
				],
			};
		case "single-editor":
		case "locked": {
			const reason = singleEditorReason(outcome.kind, state.singleEditor);
			if (replica && event.uncovered) return recover(replica, { kind: "single-editor", reason });
			return leave(reason, takeover ? [LOCK_TAKE_OVER] : []);
		}
		case "busy":
		case "full":
			return retryBusy(replica, away ?? freshAway(event.at), intent);
		case "outdated":
			if (event.reloadedRecently) return joining(replica, away, takeover, "pinned");
			if (replica && event.uncovered) return recover(replica, { kind: "reload" });
			// A reload would throw away the form's edits, so the edit lock's own takeover keeps them.
			if (takeover && event.unsavedForm) {
				return leave("server", [LOCK_TAKE_OVER, OUTDATED]);
			}
			return { state: RELOADING, effects: [{ type: "reload", outdated: true }] };
		case "forbidden":
		case "gone":
			if (replica && event.uncovered) {
				return keep(replica, outcome.kind === "forbidden" ? "access" : "deleted");
			}
			if (outcome.kind === "gone") return leave("deleted");
			return leave("error", takeover ? [LOCK_TAKE_OVER] : []);
		case "failed":
			if (takeover && !replica) return leave("error", [LOCK_TAKE_OVER]);
			// Without a replica the editor is read-only while it waits, so only the network is waited for.
			if (replica || !event.online) {
				return retryOffline(replica, away ?? freshAway(event.at), [], intent);
			}
			return leave("error");
	}
}

function welcomed(
	state: Extract<SessionState, { kind: "connecting" }>,
	event: Extract<SessionEvent, { type: "welcome" }>,
): Transition {
	const { replica } = state;
	if (replica && event.lineage !== replica.lineage) {
		if (event.uncovered) return recover(replica, { kind: "rejoin" }, [CLOSE]);
		return joining(null, state.away, false, null, [CLOSE, DISCARD]);
	}
	if (replica?.access === "edit" && event.access === "view") {
		if (event.uncovered) return keep(replica, "access", [CLOSE]);
		// Edits made before the sync completes would never be sent, so editing stops now.
		return {
			state: {
				...state,
				replica: { ...replica, access: "view" },
				welcomed: { lineage: event.lineage, access: event.access },
			},
			effects: [],
		};
	}
	return {
		state: { ...state, welcomed: { lineage: event.lineage, access: event.access } },
		effects: [],
	};
}

function closed(
	state: Extract<SessionState, { kind: "connecting" | "live" }>,
	event: Extract<SessionEvent, { type: "closed" }>,
): Transition {
	const { replica } = state;
	const continued = continuedAway(state, event.at);
	const away = continued ?? freshAway(event.at);
	const rejoined = { ...away, rejoins: continued ? away.rejoins + 1 : 0 };
	const rejoinNow = rejoined.rejoins < REJOINS_BEFORE_WAIT;
	// A Take over that never reached live hasn't taken the lock yet, so the next join asks again.
	const takeover = state.kind === "connecting" && state.takeover;
	const intent: JoinIntent = { takeover, singleEditor: null };
	switch (event.code) {
		case CLOSE_CODES.rejoin:
			return rejoinNow
				? joining(replica, rejoined, takeover, null)
				: retryBusy(replica, rejoined, intent);
		case CLOSE_CODES.reset:
		case CLOSE_TOO_LARGE:
			if (replica && event.uncovered) return recover(replica, { kind: "rejoin" });
			return rejoinNow
				? joining(null, rejoined, takeover, null, [DISCARD])
				: retryBusy(null, rejoined, intent, [DISCARD]);
		case CLOSE_CODES.deleted:
			if (replica && event.uncovered) return keep(replica, "deleted");
			return leave("deleted");
		case CLOSE_CODES.busy:
			return retryBusy(replica, away, intent);
		default:
			if (!event.opened && event.noWebSockets) return joining(replica, away, takeover, "pinned");
			return retryOffline(replica, away, [], intent);
	}
}

function recovered(state: Extract<SessionState, { kind: "recovering" }>, ok: boolean): Transition {
	if (!ok) return keep(state.replica, "recovery-failed");
	switch (state.next.kind) {
		case "rejoin":
			return joining(null, null, false, null, [DISCARD, RECOVERED]);
		case "reload":
			return { state: RELOADING, effects: [{ type: "reload", outdated: true }] };
		case "single-editor":
			return {
				state: { kind: "single-editor", reason: state.next.reason },
				effects: [DISCARD, RECOVERED],
			};
	}
}

function stay(state: SessionState): Transition {
	return { state, effects: [] };
}

/** A tab whose replica code didn't load can still join once it loads, so it keeps **Join**. */
function singleEditorReason(
	outcome: "single-editor" | "locked",
	asked: SingleEditorJoin | null,
): SingleEditorReason {
	if (outcome === "locked") return "locked";
	if (asked === "pinned") return "pinned";
	return asked === "load-failed" ? "error" : "server";
}

function joining(
	replica: ReplicaInfo | null,
	away: Away | null,
	takeover: boolean,
	singleEditor: SingleEditorJoin | null,
	before: readonly SessionEffect[] = [],
): Transition {
	return {
		state: { kind: "joining", replica, away, takeover, singleEditor },
		effects: [...before, { type: "join", takeover, singleEditor: singleEditor !== null }],
	};
}

function retryBusy(
	replica: ReplicaInfo | null,
	away: Away,
	join: JoinIntent = PLAIN_JOIN,
	before: readonly SessionEffect[] = [],
): Transition {
	return {
		state: { kind: "waiting", replica, away, reason: "busy", join },
		effects: [...before, { type: "retry-in", ms: RETRY_BUSY_MS }],
	};
}

function retryOffline(
	replica: ReplicaInfo | null,
	away: Away,
	before: readonly SessionEffect[] = [],
	join: JoinIntent = PLAIN_JOIN,
): Transition {
	const ms = OFFLINE_RETRY_MS[Math.min(away.attempt, OFFLINE_RETRY_MS.length - 1)] ?? RETRY_BUSY_MS;
	return {
		state: {
			kind: "waiting",
			replica,
			away: { ...away, attempt: away.attempt + 1 },
			reason: "offline",
			join,
		},
		effects: [...before, { type: "retry-in", ms }],
	};
}

function recover(
	replica: ReplicaInfo,
	next: RecoveryTarget,
	before: readonly SessionEffect[] = [],
): Transition {
	return {
		state: { kind: "recovering", replica, next },
		effects: [...before, { type: "recover" }],
	};
}

function keep(
	replica: ReplicaInfo,
	reason: KeptReason,
	before: readonly SessionEffect[] = [],
): Transition {
	return {
		state: { kind: "kept", replica, reason },
		effects: [...before, { type: "freeze-replica" }],
	};
}

function leave(reason: SingleEditorReason, after: readonly SessionEffect[] = []): Transition {
	return { state: { kind: "single-editor", reason }, effects: [DISCARD, ...after] };
}

/**
 * The absence a close at `at` continues, or null for a new one: a connection that never reached
 * live continues the last, and one that stayed live starts anew.
 */
function continuedAway(
	state: Extract<SessionState, { kind: "connecting" | "live" }>,
	at: number,
): Away | null {
	if (state.kind === "connecting") return state.away ?? freshAway(at);
	if (!state.ended || at - state.at >= STEADY_LIVE_MS) return null;
	return { ...state.ended, since: at };
}

function freshAway(at: number): Away {
	return { since: at, attempt: 0, rejoins: 0 };
}

export type RoomSocket = Pick<
	WebSocket,
	"binaryType" | "onopen" | "onmessage" | "onclose" | "send" | "close"
>;

export interface Clock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ConnectionTarget {
	/** The join's path, without host or token. */
	readonly url: string;
	readonly token: string;
}

export interface ConnectionEvents {
	opened(): void;
	/** Also sent for another lineage's welcome, after the connection closed itself. */
	welcome(lineage: string, access: RoomAccess): void;
	/** The room answered this connection's sync step 1. */
	synced(): void;
	checkpoint(rev: string, editedBy: readonly string[]): void;
	notice(notice: Notice): void;
	/** Only for a close this connection didn't start. */
	closed(code: number, opened: boolean): void;
}

export interface ConnectionHandle {
	close(): void;
}

export interface ReplicaHandle {
	readonly editing: RoomEditing;
	connect(
		target: ConnectionTarget,
		events: ConnectionEvents,
		openSocket: (url: string) => RoomSocket,
	): ConnectionHandle;
	hasUncoveredEdits(): boolean;
	recoveryInput(): RecoveryInput;
	setOffline(offline: boolean): void;
	/** Disconnected for good: the edits stay for copying, and no save can be waited for. */
	freeze(): void;
	/** Frozen, with its edits saved as a recovery revision, so they count as saved. */
	recovered(): void;
	dispose(): void;
}

export interface ReplicaOptions {
	/** The session's pinned `portableText` fields, stored as fragments. */
	readonly richTextFields: readonly string[];
	readonly pluginBlockTypes: readonly string[];
	readonly clock: Clock;
}

export interface ReplicaModule {
	createReplica(options: ReplicaOptions): ReplicaHandle;
}

export interface SessionDeps {
	join(request: JoinRequest): Promise<JoinOutcome>;
	saveRecovery(input: RecoveryInput): Promise<void>;
	loadReplicaModule(): Promise<ReplicaModule>;
	openSocket(url: string): RoomSocket;
	health: TransportHealth;
	reload(): void;
	clock: Clock;
	/** Whether the browser has a network connection now. */
	online(): boolean;
	/** Calls `listener` on the browser's `online` and `offline` events. */
	listenNetwork(listener: (online: boolean) => void): () => void;
	onEvent(event: RoomEvent): void;
}

/** Pinned when the session starts. A later manifest never changes them. */
export interface SessionOptions {
	readonly manifest: AdminManifest;
	readonly fingerprint: RoomFingerprint;
	readonly richTextFields: readonly string[];
	readonly pluginBlockTypes: readonly string[];
}

export interface CoEditingSession {
	subscribe(listener: () => void): () => void;
	/** The same object until the view changes. */
	getView(): CoEditing;
	/** Closes the socket without counting it as a failed open, and drops the replica. */
	dispose(): void;
}

const PENDING: CoEditing = { mode: "pending", waiting: false };
const PENDING_WAITING: CoEditing = { mode: "pending", waiting: true };
const RELOADING_VIEW: CoEditing = { mode: "reloading" };

export function createCoEditingSession(
	deps: SessionDeps,
	options: SessionOptions,
): CoEditingSession {
	const listeners = new Set<() => void>();
	const queue: SessionEvent[] = [];
	const initial = start(deps.health.pinned(), options.manifest.coEditing !== false);
	let state = initial.state;
	let replica: ReplicaHandle | null = null;
	let connection: ConnectionHandle | null = null;
	let replicaModule: Promise<ReplicaModule> | null = null;
	// Bumped whenever the connection changes, so a superseded connection's events are dropped.
	let generation = 0;
	let retryTimer: unknown = null;
	let offlineTimer: unknown = null;
	// A retry that fell due while the browser was offline, which runs once it's back online.
	let heldRetry = false;
	let lockFallback: (() => void) | null = null;
	let unsavedForm = false;
	let dispatching = false;
	let disposed = false;
	let view = PENDING;
	let viewInputs: readonly unknown[] = [];

	const actions = {
		takeOver(fallback: () => void, takeOverOptions?: { unsaved?: boolean }) {
			lockFallback = fallback;
			unsavedForm = takeOverOptions?.unsaved ?? false;
			dispatch({ type: "take-over" });
		},
		reload: () => dispatch({ type: "reload" }),
	};

	function dispatch(event: SessionEvent): void {
		if (disposed) return;
		queue.push(event);
		if (dispatching) return;
		dispatching = true;
		try {
			for (let next = queue.shift(); next; next = queue.shift()) apply(transition(state, next));
		} finally {
			dispatching = false;
		}
		refresh();
	}

	function apply(result: Transition): void {
		state = result.state;
		if (state.kind !== "waiting") {
			clearTimer("retry");
			heldRetry = false;
		}
		for (const effect of result.effects) run(effect);
	}

	function run(effect: SessionEffect): void {
		switch (effect.type) {
			case "join":
				void join(effect.takeover, effect.singleEditor);
				return;
			case "connect":
				void connect(effect.url, effect.token, effect.fresh);
				return;
			case "close-connection":
				closeConnection();
				return;
			case "discard-replica":
				closeConnection();
				replica?.dispose();
				replica = null;
				return;
			case "freeze-replica":
				replica?.freeze();
				return;
			case "recover":
				void saveRecovery();
				return;
			case "retry-in":
				clearTimer("retry");
				retryTimer = deps.clock.setTimeout(retryWhenOnline, effect.ms);
				return;
			case "reload":
				if (effect.outdated) deps.health.recordOutdatedReload(deps.clock.now());
				deps.reload();
				return;
			case "lock-take-over": {
				const fallback = lockFallback;
				lockFallback = null;
				fallback?.();
				return;
			}
			case "emit":
				deps.onEvent(effect.event);
				return;
		}
	}

	async function join(takeover: boolean, singleEditor: boolean): Promise<void> {
		const request: JoinRequest = { fingerprint: options.fingerprint, takeover, singleEditor };
		let outcome: JoinOutcome;
		try {
			outcome = await deps.join(request);
		} catch {
			outcome = { kind: "failed" };
		}
		const at = deps.clock.now();
		dispatch({
			type: "joined",
			outcome,
			uncovered: uncovered(),
			unsavedForm: takeover && unsavedForm,
			reloadedRecently: deps.health.reloadedRecently(at),
			online: deps.online(),
			at,
		});
	}

	async function connect(url: string, token: string, fresh: boolean): Promise<void> {
		closeConnection();
		if (fresh) {
			replica?.dispose();
			replica = null;
		}
		const current = generation;
		let module: ReplicaModule;
		try {
			replicaModule ??= deps.loadReplicaModule();
			module = await replicaModule;
		} catch {
			replicaModule = null;
			if (!disposed && current === generation) dispatch({ type: "load-failed" });
			return;
		}
		if (disposed || current !== generation) return;
		replica ??= module.createReplica({
			richTextFields: options.richTextFields,
			pluginBlockTypes: options.pluginBlockTypes,
			clock: deps.clock,
		});
		connection = replica.connect({ url, token }, connectionEvents(current), deps.openSocket);
	}

	function connectionEvents(current: number): ConnectionEvents {
		const isCurrent = () => !disposed && current === generation;
		return {
			opened: () => deps.health.recordOpened(),
			welcome(lineage, access) {
				if (isCurrent()) dispatch({ type: "welcome", lineage, access, uncovered: uncovered() });
			},
			synced() {
				if (isCurrent()) dispatch({ type: "synced", at: deps.clock.now() });
			},
			checkpoint(rev, editedBy) {
				if (isCurrent()) deps.onEvent({ kind: "checkpoint", rev, editedBy });
			},
			notice(notice) {
				if (isCurrent()) deps.onEvent(notice);
			},
			closed(code, opened) {
				if (!isCurrent()) return;
				connection = null;
				generation++;
				const noWebSockets = !opened && deps.health.recordFailedOpen();
				const at = deps.clock.now();
				dispatch({ type: "closed", code, opened, uncovered: uncovered(), noWebSockets, at });
			},
		};
	}

	function closeConnection(): void {
		generation++;
		connection?.close();
		connection = null;
	}

	async function saveRecovery(): Promise<void> {
		const target = replica;
		let ok = false;
		if (target) {
			for (const delay of [0, ...RECOVERY_RETRY_MS]) {
				if (delay > 0) {
					await new Promise<void>((resolve) => deps.clock.setTimeout(resolve, delay));
					if (disposed || replica !== target) return;
				}
				try {
					await deps.saveRecovery(target.recoveryInput());
					ok = true;
					break;
				} catch (error) {
					if (!isTransient(error)) break;
				}
			}
		}
		if (replica !== target) return;
		// Before a reload, so the unsaved-changes prompt doesn't stop it.
		if (ok && target) target.recovered();
		dispatch({ type: "recovered", ok });
	}

	function uncovered(): boolean {
		return replica?.hasUncoveredEdits() ?? false;
	}

	function clearTimer(timer: "retry" | "offline"): void {
		const handle = timer === "retry" ? retryTimer : offlineTimer;
		if (handle !== null) deps.clock.clearTimeout(handle);
		if (timer === "retry") retryTimer = null;
		else offlineTimer = null;
	}

	/** Recomputes the view, and tells the replica whether the tab counts as offline. */
	function refresh(): void {
		if (disposed) return;
		const away = "away" in state ? state.away : null;
		const now = deps.clock.now();
		const offline = away !== null && now - away.since >= OFFLINE_NOTICE_MS;
		const unreachable = offline && deps.online();
		replica?.setOffline(offline);
		clearTimer("offline");
		if (away && !offline) {
			offlineTimer = deps.clock.setTimeout(
				() => {
					offlineTimer = null;
					refresh();
				},
				away.since + OFFLINE_NOTICE_MS - now,
			);
		}
		const inputs = [state, offline, unreachable, replica];
		if (inputs.every((input, index) => input === viewInputs[index])) return;
		viewInputs = inputs;
		view = sessionView(
			state,
			{ offline, unreachable },
			replica?.editing ?? null,
			options.manifest,
			actions,
		);
		for (const listener of listeners) listener();
	}

	/**
	 * Retries now, or holds the retry while the browser is offline. The `online` event ends the
	 * hold, and so does a later check, since a network switch can leave that event out.
	 */
	function retryWhenOnline(): void {
		retryTimer = null;
		if (deps.online()) {
			heldRetry = false;
			dispatch({ type: "retry" });
			return;
		}
		heldRetry = true;
		retryTimer = deps.clock.setTimeout(retryWhenOnline, OFFLINE_RECHECK_MS);
	}

	const stopNetwork = deps.listenNetwork((isOnline) => {
		if (!isOnline) {
			dispatch({ type: "offline", at: deps.clock.now() });
			return;
		}
		dispatch({ type: "online" });
		if (heldRetry) {
			clearTimer("retry");
			heldRetry = false;
			dispatch({ type: "retry" });
		}
	});
	for (const effect of initial.effects) run(effect);
	refresh();

	return {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getView: () => view,
		dispose() {
			if (disposed) return;
			disposed = true;
			stopNetwork();
			clearTimer("retry");
			clearTimer("offline");
			connection?.close();
			connection = null;
			replica?.dispose();
			replica = null;
			listeners.clear();
		},
	};
}

function sessionView(
	state: SessionState,
	{ offline, unreachable }: { offline: boolean; unreachable: boolean },
	editing: RoomEditing | null,
	manifest: AdminManifest,
	actions: {
		takeOver(fallback: () => void, options?: { unsaved?: boolean }): void;
		reload(): void;
	},
): CoEditing {
	if (state.kind === "single-editor") {
		return {
			mode: "single-editor",
			canJoin: state.reason !== "pinned",
			deleted: state.reason === "deleted",
			takeOver: actions.takeOver,
		};
	}
	if (state.kind === "reloading") return RELOADING_VIEW;
	const synced = syncedReplica(state);
	if (!synced || !editing) return state.kind === "waiting" ? PENDING_WAITING : PENDING;
	const edit = synced.access === "edit";
	return {
		mode: "room",
		room: editing,
		access: synced.access,
		editable: edit && state.kind !== "recovering",
		offline,
		unreachable,
		kept: state.kind === "kept" ? state.reason : null,
		reload: actions.reload,
		manifest,
	};
}

/** A failed request, or a server error, which the same request may get past a moment later. */
function isTransient(error: unknown): boolean {
	if (error instanceof ApiResponseError) return error.status >= 500;
	return error instanceof TypeError;
}
