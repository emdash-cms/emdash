/**
 * The in-process room host: the process's rooms, each over room storage in the site database
 * under this process's claim.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { isClaimedElsewhere, KyselyRoomStore, listExpiredRooms } from "../kysely-store.js";
import { CLAIM_RENEWAL_MS, SERVER_WAIT_MS } from "../limits.js";
import { clearRoomNotifier, setRoomNotifier } from "../notifications.js";
import { Room } from "../room.js";
import {
	CLOSE_CODES,
	parseRoomId,
	type Build,
	type OutsideValue,
	type RoomConnection,
	type RoomSite,
	type RoomTimers,
	type RuntimeRoomHost,
	type TokenClaims,
} from "../types.js";
import { trackRegistry, untrackRegistry, updateSignalListeners } from "./signals.js";
import { clearUpgradeRegistry, serverAttached, setUpgradeRegistry } from "./upgrades.js";

const LOG = "[co-editing]";

/** Timers that never keep the process running. */
export const nodeTimers: RoomTimers = {
	now: () => Date.now(),
	set(ms, run) {
		const timer = setTimeout(run, ms);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		return () => clearTimeout(timer);
	},
};

export interface RoomRegistryOptions {
	db: Kysely<Database>;
	site: RoomSite;
	build: Build;
	timers?: RoomTimers;
}

/** A connection a room took: the host hands it the socket's messages and its close. */
export interface AcceptedConnection {
	receive(message: Uint8Array): void;
	disconnect(): void;
}

export class RoomRegistry implements RuntimeRoomHost {
	/** This process's ID in room claims. */
	readonly host = crypto.randomUUID();
	readonly #db: Kysely<Database>;
	readonly #site: RoomSite;
	readonly #build: Build;
	readonly #timers: RoomTimers;
	readonly #rooms = new Map<string, Room>();
	readonly #inFlight = new Map<string, number>();
	#cancelTick: (() => void) | null = null;
	#shuttingDown = false;
	#firstTokenAt: number | null = null;

	constructor(options: RoomRegistryOptions) {
		this.#db = options.db;
		this.#site = options.site;
		this.#build = options.build;
		this.#timers = options.timers ?? nodeTimers;
		trackRegistry(this);
	}

	/** Rooms this process keeps in memory. */
	get size(): number {
		return this.#rooms.size;
	}

	/** Whether any of this process's rooms holds its claim. */
	get holdsClaims(): boolean {
		for (const room of this.#rooms.values()) if (room.holdsClaim) return true;
		return false;
	}

	/** Makes this the registry outside writes notify and the site's server hands room sockets to. */
	activate(): void {
		setRoomNotifier(this);
		setUpgradeRegistry(this);
	}

	async issueToken(
		roomId: string,
		claims: TokenClaims,
	): Promise<{ token: string } | "full" | "stale" | "busy" | null> {
		if (this.#shuttingDown) return "busy";
		if (this.#noServer()) return null;
		const room = this.#room(roomId);
		if (!room) return null;
		const issued = await this.#counted(roomId, () => room.issueToken(claims));
		if (typeof issued === "object" && issued !== null) this.#firstTokenAt ??= this.#timers.now();
		return issued;
	}

	/**
	 * Upgrades never reach this process: no server had the listener attached a minute after its
	 * first token.
	 */
	#noServer(): boolean {
		return (
			this.#firstTokenAt !== null &&
			!serverAttached() &&
			this.#timers.now() - this.#firstTokenAt >= SERVER_WAIT_MS
		);
	}

	async isOpen(roomId: string): Promise<boolean> {
		if (this.#rooms.get(roomId)?.isOpen()) return true;
		return isClaimedElsewhere(this.#db, roomId, this.host);
	}

	async save(
		roomId: string,
		actorId: string,
		rev?: string,
	): Promise<{ rev: string; hold: string } | "conflict" | null> {
		const room = this.#rooms.get(roomId);
		return room ? this.#counted(roomId, () => room.save(actorId, rev)) : null;
	}

	async release(roomId: string, hold: string, options?: { overwrite?: boolean }): Promise<void> {
		const room = this.#rooms.get(roomId);
		if (room) await this.#counted(roomId, () => room.release(hold, options));
	}

	/** Reaches the room before returning, so a later call in the same request finds the merge queued. */
	notify(roomId: string, outside: OutsideValue[]): Promise<void> {
		return this.#rooms.get(roomId)?.notify(outside) ?? Promise.resolve();
	}

	async forgetTokens(roomId: string, userId: string): Promise<void> {
		await this.#rooms.get(roomId)?.forgetTokens(userId);
	}

	/**
	 * Hands a socket with a token to its room. Closes it with `busy`, and returns null, while
	 * shutting down, when this process has no room for it, or when the token isn't valid.
	 */
	accept(roomId: string, token: string, connection: RoomConnection): AcceptedConnection | null {
		const room = this.#shuttingDown ? undefined : this.#rooms.get(roomId);
		if (!room) {
			connection.close(CLOSE_CODES.busy, "The room isn't in this process");
			return null;
		}
		if (!room.connect(connection, token)) return null;
		return {
			receive: (message) => room.receive(connection, message),
			disconnect: () => room.disconnect(connection),
		};
	}

	/** Includes rooms a crashed process left, once their claims expire. */
	async expireIdle(): Promise<void> {
		if (this.#shuttingDown) return;
		for (const roomId of await listExpiredRooms(this.#db, this.host)) {
			if (this.#shuttingDown) return;
			const room = this.#room(roomId);
			if (!room) continue;
			try {
				await this.#counted(roomId, () => room.expire());
			} catch (error) {
				console.error(`${LOG} room ${roomId} couldn't drop its state:`, error);
			}
		}
	}

	async shutdown(): Promise<void> {
		this.#shuttingDown = true;
		untrackRegistry(this);
		clearRoomNotifier(this);
		clearUpgradeRegistry(this);
		this.#cancelTick?.();
		this.#cancelTick = null;
		await Promise.allSettled(Array.from(this.#rooms.values(), (room) => room.shutdown()));
	}

	#room(roomId: string): Room | null {
		const existing = this.#rooms.get(roomId);
		if (existing) return existing;
		const entry = parseRoomId(roomId);
		if (!entry) return null;
		const room = new Room({
			entry,
			site: this.#site,
			store: new KyselyRoomStore(this.#db, roomId, this.host),
			build: this.#build,
			timers: this.#timers,
		});
		this.#rooms.set(roomId, room);
		this.#scheduleTick();
		return room;
	}

	/** Counted so the tick never drops a room mid-call, such as one still taking its claim. */
	async #counted<T>(roomId: string, call: () => Promise<T>): Promise<T> {
		this.#inFlight.set(roomId, (this.#inFlight.get(roomId) ?? 0) + 1);
		try {
			return await call();
		} finally {
			const left = (this.#inFlight.get(roomId) ?? 1) - 1;
			if (left > 0) this.#inFlight.set(roomId, left);
			else this.#inFlight.delete(roomId);
			updateSignalListeners();
		}
	}

	#scheduleTick(): void {
		if (this.#cancelTick || this.#shuttingDown) return;
		this.#cancelTick = this.#timers.set(CLAIM_RENEWAL_MS / 2, () => void this.#tick());
	}

	/** Renews held claims, then drops rooms that are idle and hold none. Runs while any room is kept. */
	async #tick(): Promise<void> {
		await Promise.allSettled(Array.from(this.#rooms.values(), (room) => room.renew()));
		for (const [roomId, room] of this.#rooms) {
			if (!this.#inFlight.has(roomId) && !room.isOpen() && !room.holdsClaim) {
				this.#rooms.delete(roomId);
			}
		}
		this.#cancelTick = null;
		updateSignalListeners();
		if (this.#rooms.size > 0) this.#scheduleTick();
	}
}
