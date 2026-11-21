/**
 * A `RoomStore` over in-memory rows. It outlives the `Room` that uses it, so recreating the room
 * models a restart that loses only what wasn't stored.
 */

import { RoomClaimLostError, type RoomRecord, type RoomStore } from "../../../src/rooms/types.js";

export type StoreMethod =
	| "load"
	| "append"
	| "writeRecord"
	| "compact"
	| "drop"
	| "touch"
	| "claim"
	| "renew"
	| "release";

export class MemoryRoomStore implements RoomStore {
	record: RoomRecord | null = null;
	updates: Uint8Array[] = [];
	updatedAt: number | null = null;
	claimed = false;
	compactions = 0;
	/** Every call, in order. */
	calls: StoreMethod[] = [];

	/** `claim` resolves false. */
	refuseClaims = false;
	/** Another process took the claim: `renew` resolves false, and the others reject. */
	claimLost = false;
	#failNext: StoreMethod | "any" | null = null;
	#failSkip = 0;
	readonly #holds = new Map<StoreMethod, Promise<void>>();
	readonly #now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Makes the next call, or the `nth` next call to `method`, reject. */
	failNext(method: StoreMethod | "any" = "any", nth = 1): void {
		this.#failNext = method;
		this.#failSkip = nth - 1;
	}

	/** Makes the next call to `method` wait, before it does anything, until `open` runs. */
	holdNext(method: StoreMethod): { open: () => void } {
		let open!: () => void;
		this.#holds.set(
			method,
			new Promise<void>((resolve) => {
				open = resolve;
			}),
		);
		return { open };
	}

	async load(): Promise<{
		record: RoomRecord | null;
		updates: Uint8Array[];
		updatedAt: number | null;
	}> {
		await this.#enter("load");
		return {
			record: this.record && structuredClone(this.record),
			updates: this.updates.map((update) => update.slice()),
			updatedAt: this.updatedAt,
		};
	}

	async append(updates: Uint8Array[]): Promise<void> {
		await this.#enter("append");
		this.updates.push(...updates.map((update) => update.slice()));
		this.updatedAt = this.#now();
	}

	async writeRecord(record: RoomRecord, update?: Uint8Array): Promise<void> {
		await this.#enter("writeRecord");
		this.record = structuredClone(record);
		if (update) this.updates.push(update.slice());
		this.updatedAt = this.#now();
	}

	async compact(state: Uint8Array): Promise<void> {
		await this.#enter("compact");
		this.updates = [state.slice()];
		this.compactions++;
		this.updatedAt = this.#now();
	}

	async drop(): Promise<void> {
		await this.#enter("drop");
		this.record = null;
		this.updates = [];
		this.updatedAt = null;
	}

	async touch(): Promise<void> {
		await this.#enter("touch");
		if (!this.claimed) throw new RoomClaimLostError();
		if (this.record) this.updatedAt = this.#now();
	}

	async claim(): Promise<boolean> {
		this.calls.push("claim");
		this.#maybeFail("claim");
		if (this.refuseClaims || this.claimed) return false;
		this.claimed = true;
		this.claimLost = false;
		return true;
	}

	async renew(): Promise<boolean> {
		this.calls.push("renew");
		this.#maybeFail("renew");
		return !this.claimLost;
	}

	async release(): Promise<void> {
		this.calls.push("release");
		this.#maybeFail("release");
		if (!this.claimLost) this.claimed = false;
	}

	/** Stored update bytes. */
	storedBytes(): number {
		return this.updates.reduce((total, update) => total + update.byteLength, 0);
	}

	async #enter(method: StoreMethod): Promise<void> {
		const hold = this.#holds.get(method);
		if (hold) {
			this.#holds.delete(method);
			await hold;
		}
		this.calls.push(method);
		this.#maybeFail(method);
		if (this.claimLost) throw new RoomClaimLostError();
	}

	#maybeFail(method: StoreMethod): void {
		if (this.#failNext !== "any" && this.#failNext !== method) return;
		if (this.#failSkip > 0) {
			this.#failSkip--;
			return;
		}
		this.#failNext = null;
		throw new Error(`store ${method} failed`);
	}
}
