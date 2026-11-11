import type { AdminManifest } from "../../src/lib/api/client";
import type { JoinOutcome, JoinRequest, RecoveryInput } from "../../src/lib/api/rooms";
import * as replicaModule from "../../src/lib/co-editing/replica/index";
import type { Replica } from "../../src/lib/co-editing/replica/replica";
import {
	createCoEditingSession,
	type Clock,
	type ReplicaModule,
	type SessionDeps,
} from "../../src/lib/co-editing/session";
import { TRANSPORT_COOKIE, createTransportHealth } from "../../src/lib/co-editing/transport-health";
import type { CoEditing, RoomEvent } from "../../src/lib/co-editing/types";
import { LoopbackRoom, settle } from "./loopback-room";

export const ROOM_URL = "/_emdash/api/content/posts/01ENTRY/room";
export const FINGERPRINT = { version: "1.4.0", commit: "abc1234", hash: "manifest-1" };
export const MANIFEST: AdminManifest = {
	version: "1.4.0",
	hash: "manifest-1",
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
};

export class ManualClock implements Clock {
	time = 1_700_000_000_000;
	readonly #timers = new Map<number, { at: number; callback: () => void }>();
	#next = 1;

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, ms: number): number {
		const id = this.#next++;
		this.#timers.set(id, { at: this.time + ms, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle === "number") this.#timers.delete(handle);
	}

	/** Moves time forward, running each timer that falls due on the way. */
	advance(ms: number): void {
		const end = this.time + ms;
		for (;;) {
			let due: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of this.#timers) {
				if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry;
			}
			if (!due) break;
			this.#timers.delete(due[0]);
			this.time = Math.max(this.time, due[1].at);
			due[1].callback();
		}
		this.time = end;
	}
}

/** Clears the browser session's transport cookie and reload guard. */
export function resetTransportHealth(): void {
	document.cookie = `${TRANSPORT_COOKIE}=; Path=/_emdash; Max-Age=0`;
	document.cookie = `${TRANSPORT_COOKIE}=; Path=/; Max-Age=0`;
	sessionStorage.clear();
}

/** A session against a loopback room, with every dependency observable. */
export function startSession(
	room: LoopbackRoom,
	overrides: Partial<SessionDeps> = {},
	richTextFields: readonly string[] = ["body"],
	manifest: AdminManifest = MANIFEST,
) {
	const clock = new ManualClock();
	const joins: JoinRequest[] = [];
	const answers: JoinOutcome[] = [];
	const events: RoomEvent[] = [];
	const recoveries: RecoveryInput[] = [];
	const replicas: Replica[] = [];
	const network = new Set<(online: boolean) => void>();
	let online = true;
	let reloads = 0;
	let tokens = 0;
	let recoveryFails = false;
	const module: ReplicaModule = {
		createReplica(options) {
			const replica = replicaModule.createReplica(options);
			replicas.push(replica as Replica);
			return replica;
		},
	};
	const deps: SessionDeps = {
		async join(request) {
			joins.push(request);
			await Promise.resolve();
			const answer = answers.shift();
			if (answer) return answer;
			// The server answers single-editor mode whenever the client asks for it.
			if (request.singleEditor) return { kind: "single-editor" };
			return { kind: "room", url: ROOM_URL, token: `t${++tokens}`, access: "edit" };
		},
		async saveRecovery(input) {
			recoveries.push(input);
			if (recoveryFails) throw new Error("refused");
		},
		loadReplicaModule: async () => module,
		openSocket: room.open,
		health: createTransportHealth(),
		reload: () => reloads++,
		clock,
		online: () => online,
		listenNetwork(listener) {
			network.add(listener);
			return () => network.delete(listener);
		},
		onEvent: (event) => events.push(event),
		...overrides,
	};
	const session = createCoEditingSession(deps, {
		manifest,
		fingerprint: FINGERPRINT,
		richTextFields,
		pluginBlockTypes: [],
	});
	return {
		session,
		clock,
		joins,
		events,
		recoveries,
		replicas,
		get reloads() {
			return reloads;
		},
		/** The next unanswered join's answer. Without one, a join gets a room. */
		answer: (outcome: JoinOutcome) => answers.push(outcome),
		failRecovery: () => (recoveryFails = true),
		/** Changes the browser's connection, with its `online` or `offline` event unless `event` is false. */
		setOnline(next: boolean, { event = true } = {}) {
			online = next;
			if (event) network.forEach((listener) => listener(next));
		},
		view: (): CoEditing => session.getView(),
		/** The current replica, once one exists. */
		replica: (): Replica => {
			const replica = replicas.at(-1);
			if (!replica) throw new Error("No replica yet");
			return replica;
		},
		/** Advances the clock, then lets messages and promises run. */
		async after(ms: number) {
			clock.advance(ms);
			await settle();
		},
	};
}

export type TestSession = ReturnType<typeof startSession>;
