import { describe, expect, it } from "vitest";

import type { JoinOutcome } from "../../src/lib/api/rooms";
import {
	start,
	transition,
	type Away,
	type ReplicaInfo,
	type SessionEffect,
	type SessionEvent,
	type SessionState,
} from "../../src/lib/co-editing/session";

const AT = 9000;
const EDIT: ReplicaInfo = { lineage: "one", access: "edit" };
const VIEW: ReplicaInfo = { lineage: "one", access: "view" };
const AWAY: Away = { since: 100, attempt: 0, rejoins: 0 };
const NEW_AWAY: Away = { since: AT, attempt: 0, rejoins: 0 };
const ROOM: JoinOutcome = { kind: "room", url: "/room", token: "t", access: "edit" };

const joining = (
	patch: Partial<Extract<SessionState, { kind: "joining" }>> = {},
): SessionState => ({
	kind: "joining",
	replica: null,
	away: null,
	takeover: false,
	singleEditor: false,
	...patch,
});
const connecting = (
	patch: Partial<Extract<SessionState, { kind: "connecting" }>> = {},
): SessionState => ({ kind: "connecting", replica: null, away: null, welcomed: null, ...patch });
const waiting = (
	replica: ReplicaInfo | null,
	away: Away,
	reason: "offline" | "busy",
): SessionState => ({ kind: "waiting", replica, away, reason });
const live: SessionState = { kind: "live", replica: EDIT };
const single = (reason: "server" | "locked" | "pinned" | "error"): SessionState => ({
	kind: "single-editor",
	reason,
});
const kept = (reason: "access" | "deleted" | "recovery-failed"): SessionState => ({
	kind: "kept",
	replica: EDIT,
	reason,
});
const RELOADING: SessionState = { kind: "reloading" };

const joined = (
	outcome: JoinOutcome,
	options: { uncovered?: boolean; reloadedRecently?: boolean } = {},
): SessionEvent => ({
	type: "joined",
	outcome,
	uncovered: options.uncovered ?? false,
	reloadedRecently: options.reloadedRecently ?? false,
	at: AT,
});
const closed = (
	code: number,
	options: { opened?: boolean; uncovered?: boolean; noWebSockets?: boolean } = {},
): SessionEvent => ({
	type: "closed",
	code,
	opened: options.opened ?? true,
	uncovered: options.uncovered ?? false,
	noWebSockets: options.noWebSockets ?? false,
	at: AT,
});
const welcome = (lineage: string, access: "edit" | "view", uncovered = false): SessionEvent => ({
	type: "welcome",
	lineage,
	access,
	uncovered,
});

const join = (takeover = false, singleEditor = false): SessionEffect => ({
	type: "join",
	takeover,
	singleEditor,
});
const connect = (fresh: boolean): SessionEffect => ({
	type: "connect",
	url: "/room",
	token: "t",
	fresh,
});
const retryIn = (ms: number): SessionEffect => ({ type: "retry-in", ms });
const CLOSE: SessionEffect = { type: "close-connection" };
const DISCARD: SessionEffect = { type: "discard-replica" };
const FREEZE: SessionEffect = { type: "freeze-replica" };
const RECOVER: SessionEffect = { type: "recover" };
const LEFT: SessionEffect = { type: "emit", event: { kind: "left-room" } };
const RECOVERED: SessionEffect = { type: "emit", event: { kind: "recovered" } };

type Row = [
	name: string,
	from: SessionState,
	event: SessionEvent,
	to: SessionState,
	effects: SessionEffect[],
];

const ROWS: Row[] = [
	// Join outcomes
	["room, first join", joining(), joined(ROOM), connecting(), [connect(true)]],
	[
		"room, rejoin keeps the replica",
		joining({ replica: EDIT, away: AWAY }),
		joined(ROOM),
		connecting({ replica: EDIT, away: AWAY }),
		[connect(false)],
	],
	["single-editor", joining(), joined({ kind: "single-editor" }), single("server"), [DISCARD]],
	[
		"single-editor after a room",
		joining({ replica: EDIT }),
		joined({ kind: "single-editor" }),
		single("server"),
		[DISCARD, LEFT],
	],
	[
		"single-editor, uncovered edits",
		joining({ replica: EDIT }),
		joined({ kind: "single-editor" }, { uncovered: true }),
		{ kind: "recovering", replica: EDIT, next: { kind: "single-editor", reason: "server" } },
		[RECOVER],
	],
	["locked", joining(), joined({ kind: "locked" }), single("locked"), [DISCARD]],
	[
		"single-editor, pinned",
		joining({ singleEditor: true }),
		joined({ kind: "single-editor" }),
		single("pinned"),
		[DISCARD],
	],
	[
		"single-editor after Take over",
		joining({ takeover: true }),
		joined({ kind: "single-editor" }),
		single("server"),
		[DISCARD, { type: "lock-take-over" }],
	],
	[
		"busy, first join",
		joining(),
		joined({ kind: "busy" }),
		waiting(null, NEW_AWAY, "busy"),
		[retryIn(5000)],
	],
	[
		"busy, with a replica",
		joining({ replica: EDIT, away: AWAY }),
		joined({ kind: "busy" }),
		waiting(EDIT, AWAY, "busy"),
		[retryIn(5000)],
	],
	[
		"full opens read-only and waits",
		joining(),
		joined({ kind: "full" }),
		waiting(null, NEW_AWAY, "busy"),
		[retryIn(5000)],
	],
	[
		"full, with a replica",
		joining({ replica: EDIT, away: AWAY }),
		joined({ kind: "full" }),
		waiting(EDIT, AWAY, "busy"),
		[retryIn(5000)],
	],
	[
		"outdated reloads",
		joining(),
		joined({ kind: "outdated" }),
		RELOADING,
		[{ type: "reload", outdated: true }],
	],
	[
		"outdated, uncovered edits",
		joining({ replica: EDIT }),
		joined({ kind: "outdated" }, { uncovered: true }),
		{ kind: "recovering", replica: EDIT, next: { kind: "reload" } },
		[RECOVER],
	],
	[
		"outdated again within a minute",
		joining({ replica: EDIT, away: AWAY }),
		joined({ kind: "outdated" }, { uncovered: true, reloadedRecently: true }),
		joining({ replica: EDIT, away: AWAY, singleEditor: true }),
		[join(false, true)],
	],
	[
		"forbidden, uncovered edits",
		joining({ replica: EDIT }),
		joined({ kind: "forbidden" }, { uncovered: true }),
		kept("access"),
		[FREEZE],
	],
	[
		"gone, uncovered edits",
		joining({ replica: EDIT }),
		joined({ kind: "gone" }, { uncovered: true }),
		kept("deleted"),
		[FREEZE],
	],
	[
		"forbidden after a room",
		joining({ replica: EDIT }),
		joined({ kind: "forbidden" }),
		single("error"),
		[DISCARD, LEFT],
	],
	["gone, first join", joining(), joined({ kind: "gone" }), single("error"), [DISCARD]],
	[
		"failed, with a replica",
		joining({ replica: EDIT, away: AWAY }),
		joined({ kind: "failed" }),
		waiting(EDIT, { ...AWAY, attempt: 1 }, "offline"),
		[retryIn(0)],
	],
	["failed, first join", joining(), joined({ kind: "failed" }), single("error"), [DISCARD]],
	// Welcome and sync
	["welcome", connecting(), welcome("one", "edit"), connecting({ welcomed: EDIT }), []],
	[
		"another lineage",
		connecting({ replica: EDIT, away: AWAY }),
		welcome("two", "edit"),
		joining({ away: AWAY }),
		[CLOSE, DISCARD, join()],
	],
	[
		"another lineage, uncovered edits",
		connecting({ replica: EDIT }),
		welcome("two", "edit", true),
		{ kind: "recovering", replica: EDIT, next: { kind: "rejoin" } },
		[CLOSE, RECOVER],
	],
	[
		"editor welcomed as a viewer, uncovered edits",
		connecting({ replica: EDIT }),
		welcome("one", "view", true),
		kept("access"),
		[CLOSE, FREEZE],
	],
	[
		"editor welcomed as a viewer",
		connecting({ replica: EDIT }),
		welcome("one", "view"),
		connecting({ replica: EDIT, welcomed: VIEW }),
		[],
	],
	[
		"a second welcome",
		connecting({ welcomed: EDIT }),
		welcome("two", "view"),
		connecting({ welcomed: EDIT }),
		[],
	],
	[
		"synced",
		connecting({ replica: EDIT, away: AWAY, welcomed: VIEW }),
		{ type: "synced" },
		{ kind: "live", replica: VIEW },
		[],
	],
	["synced before welcome", connecting(), { type: "synced" }, connecting(), []],
	[
		"the replica chunk fails to load",
		connecting({ away: AWAY }),
		{ type: "load-failed" },
		joining({ away: AWAY, singleEditor: true }),
		[join(false, true)],
	],
	// Closes
	["rejoin from live", live, closed(4400), joining({ replica: EDIT, away: NEW_AWAY }), [join()]],
	[
		"rejoin before live",
		connecting({ replica: EDIT, away: AWAY }),
		closed(4400),
		joining({ replica: EDIT, away: { ...AWAY, rejoins: 1 } }),
		[join()],
	],
	[
		"second rejoin before live waits",
		connecting({ replica: EDIT, away: { ...AWAY, rejoins: 1 } }),
		closed(4400),
		waiting(EDIT, { ...AWAY, rejoins: 2 }, "busy"),
		[retryIn(5000)],
	],
	["reset", live, closed(4401), joining({ away: NEW_AWAY }), [DISCARD, join()]],
	[
		"frame too large, uncovered edits",
		live,
		closed(1009, { uncovered: true }),
		{ kind: "recovering", replica: EDIT, next: { kind: "rejoin" } },
		[RECOVER],
	],
	["deleted, uncovered edits", live, closed(4402, { uncovered: true }), kept("deleted"), [FREEZE]],
	["deleted", live, closed(4402), single("error"), [DISCARD, LEFT]],
	["busy socket", live, closed(4403), waiting(EDIT, NEW_AWAY, "busy"), [retryIn(5000)]],
	[
		"dropped",
		live,
		closed(1006),
		waiting(EDIT, { ...NEW_AWAY, attempt: 1 }, "offline"),
		[retryIn(0)],
	],
	[
		"dropped again",
		connecting({ replica: EDIT, away: { ...AWAY, attempt: 3 } }),
		closed(1006),
		waiting(EDIT, { ...AWAY, attempt: 4 }, "offline"),
		[retryIn(4000)],
	],
	[
		"third socket that never opened",
		connecting(),
		closed(1006, { opened: false, noWebSockets: true }),
		joining({ away: NEW_AWAY, singleEditor: true }),
		[join(false, true)],
	],
	[
		"a socket that never opened",
		connecting(),
		closed(1006, { opened: false }),
		waiting(null, { ...NEW_AWAY, attempt: 1 }, "offline"),
		[retryIn(0)],
	],
	// Retries and the network
	[
		"retry",
		waiting(EDIT, AWAY, "offline"),
		{ type: "retry" },
		joining({ replica: EDIT, away: AWAY }),
		[join()],
	],
	[
		"retry after busy",
		waiting(null, AWAY, "busy"),
		{ type: "retry" },
		joining({ away: AWAY }),
		[join()],
	],
	[
		"online",
		waiting(EDIT, AWAY, "offline"),
		{ type: "online" },
		joining({ replica: EDIT, away: AWAY }),
		[join()],
	],
	[
		"online while busy",
		waiting(EDIT, AWAY, "busy"),
		{ type: "online" },
		waiting(EDIT, AWAY, "busy"),
		[],
	],
	[
		"the browser goes offline",
		live,
		{ type: "offline", at: AT },
		waiting(EDIT, { ...NEW_AWAY, attempt: 1 }, "offline"),
		[CLOSE, retryIn(0)],
	],
	["offline while joining", joining(), { type: "offline", at: AT }, joining(), []],
	// Recovery
	[
		"recovered, rejoin",
		{ kind: "recovering", replica: EDIT, next: { kind: "rejoin" } },
		{ type: "recovered", ok: true },
		joining(),
		[DISCARD, RECOVERED, join()],
	],
	[
		"recovered, reload",
		{ kind: "recovering", replica: EDIT, next: { kind: "reload" } },
		{ type: "recovered", ok: true },
		RELOADING,
		[{ type: "reload", outdated: true }],
	],
	[
		"recovered, single-editor",
		{ kind: "recovering", replica: EDIT, next: { kind: "single-editor", reason: "locked" } },
		{ type: "recovered", ok: true },
		single("locked"),
		[DISCARD, RECOVERED, LEFT],
	],
	[
		"recovery failed",
		{ kind: "recovering", replica: EDIT, next: { kind: "rejoin" } },
		{ type: "recovered", ok: false },
		kept("recovery-failed"),
		[FREEZE],
	],
	// User actions
	[
		"Take over or Join",
		single("locked"),
		{ type: "take-over" },
		joining({ takeover: true }),
		[join(true, false)],
	],
	[
		"Take over, pinned",
		single("pinned"),
		{ type: "take-over" },
		joining({ takeover: true, singleEditor: true }),
		[join(true, true)],
	],
	[
		"Reload from kept",
		kept("deleted"),
		{ type: "reload" },
		RELOADING,
		[{ type: "reload", outdated: false }],
	],
	["Take over in a room", live, { type: "take-over" }, live, []],
	["Reload in a room", live, { type: "reload" }, live, []],
];

describe("co-editing session reducer", () => {
	it.each(ROWS)("%s", (_name, from, event, to, effects) => {
		expect(transition(from, event)).toEqual({ state: to, effects });
	});

	it("starts with a join, as single-editor when the browser session is pinned", () => {
		expect(start(false)).toEqual({ state: joining(), effects: [join()] });
		expect(start(true)).toEqual({
			state: joining({ singleEditor: true }),
			effects: [join(false, true)],
		});
	});

	it("backs off 0, 1, 2 and 4 s, then every 5 s, while the network is down", () => {
		let state: SessionState = live;
		const delays: number[] = [];
		for (let drop = 0; drop < 7; drop++) {
			const result = transition(
				state.kind === "waiting" ? connecting({ replica: EDIT, away: state.away }) : state,
				closed(1006),
			);
			state = result.state;
			for (const effect of result.effects) if (effect.type === "retry-in") delays.push(effect.ms);
		}
		expect(delays).toEqual([0, 1000, 2000, 4000, 5000, 5000, 5000]);
	});

	it("returns the same state, with no effects, for an event that doesn't apply", () => {
		const from = single("server");
		const result = transition(from, welcome("one", "edit"));
		expect(result.state).toBe(from);
		expect(result.effects).toEqual([]);
	});

	it("leaves kept and reloading only through Reload", () => {
		const events: SessionEvent[] = [
			joined(ROOM, { uncovered: true }),
			{ type: "load-failed" },
			welcome("two", "view", true),
			{ type: "synced" },
			closed(4400),
			closed(4401, { uncovered: true }),
			closed(1006, { opened: false, noWebSockets: true }),
			{ type: "offline", at: AT },
			{ type: "online" },
			{ type: "retry" },
			{ type: "recovered", ok: true },
			{ type: "recovered", ok: false },
			{ type: "take-over" },
		];
		for (const state of [kept("access"), kept("deleted"), kept("recovery-failed"), RELOADING]) {
			for (const event of events) {
				expect(transition(state, event)).toEqual({ state, effects: [] });
			}
		}
		expect(transition(RELOADING, { type: "reload" })).toEqual({ state: RELOADING, effects: [] });
		expect(transition(kept("access"), { type: "reload" }).state).toEqual(RELOADING);
	});
});
