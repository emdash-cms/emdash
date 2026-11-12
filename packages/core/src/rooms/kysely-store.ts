/**
 * Room storage in the site database, for rooms on Node.js. Part 0 of a room's `_emdash_rooms`
 * rows holds the room's claim and the time of its last write, and every value over 1 MB is
 * stored in parts. Every timestamp comes from the database clock.
 */

import type { Kysely } from "kysely";

import {
	leaseHasExpired,
	leaseIsLive,
	timestampOffset,
} from "../database/repositories/entry-locks.js";
import { withTransaction } from "../database/transaction.js";
import type { Database } from "../database/types.js";
import { chunks } from "../utils/chunks.js";
import { CLAIM_EXPIRY_MS, ROOM_STATE_LIFETIME_MS } from "./limits.js";
import { joinParts, splitBytes, splitText } from "./parts.js";
import { RoomClaimLostError, type RoomRecord, type RoomStore } from "./types.js";

const CLAIM_EXPIRY_SECONDS = CLAIM_EXPIRY_MS / 1000;
const ROOM_STATE_LIFETIME_SECONDS = ROOM_STATE_LIFETIME_MS / 1000;
/** Update parts per insert, well within every dialect's bind-parameter limit. */
const INSERT_ROWS = 100;

/** One room's storage, written under this process's claim. */
export class KyselyRoomStore implements RoomStore {
	readonly #db: Kysely<Database>;
	readonly #roomId: string;
	readonly #host: string;

	constructor(db: Kysely<Database>, roomId: string, host: string) {
		this.#db = db;
		this.#roomId = roomId;
		this.#host = host;
	}

	async load(): Promise<{
		record: RoomRecord | null;
		updates: Uint8Array[];
		updatedAt: number | null;
	}> {
		const { recordRows, updateRows } = await this.#renewing(false, async (trx) => ({
			recordRows: await trx
				.selectFrom("_emdash_rooms")
				.select(["record", "updated_at", timestampOffset(trx, 0).as("now")])
				.where("room_id", "=", this.#roomId)
				.orderBy("part")
				.execute(),
			updateRows: await trx
				.selectFrom("_emdash_room_updates")
				.select(["seq", "data"])
				.where("room_id", "=", this.#roomId)
				.orderBy("seq")
				.orderBy("part")
				.execute(),
		}));
		const parts = new Map<number, unknown[]>();
		for (const row of updateRows) {
			const seq = Number(row.seq);
			const list = parts.get(seq) ?? [];
			list.push(row.data);
			parts.set(seq, list);
		}
		const updates = Array.from(parts.values(), joinParts);
		const head = recordRows[0];
		if (!head || head.record === null) return { record: null, updates, updatedAt: null };
		const record: RoomRecord = JSON.parse(recordRows.map((row) => row.record ?? "").join(""));
		// On the process clock, which the room compares it with.
		const updatedAt = Date.now() - (Date.parse(head.now) - Date.parse(head.updated_at));
		return { record, updates, updatedAt };
	}

	async append(updates: Uint8Array[]): Promise<void> {
		const split = updates.map(splitBytes);
		await this.#renewing(true, (trx) => this.#insertUpdates(trx, split));
	}

	async writeRecord(record: RoomRecord, update?: Uint8Array): Promise<void> {
		const [head = "", ...rest] = splitText(JSON.stringify(record));
		const split = update ? [splitBytes(update)] : [];
		await this.#renewing(true, async (trx) => {
			await trx
				.updateTable("_emdash_rooms")
				.set({ record: head })
				.where("room_id", "=", this.#roomId)
				.where("part", "=", 0)
				.execute();
			await this.#deleteRecordParts(trx);
			if (rest.length > 0) {
				const now = timestampOffset(trx, 0);
				await trx
					.insertInto("_emdash_rooms")
					.values(
						rest.map((value, index) => ({
							room_id: this.#roomId,
							part: index + 1,
							record: value,
							host: null,
							claimed_at: null,
							updated_at: now,
						})),
					)
					.execute();
			}
			await this.#insertUpdates(trx, split);
		});
	}

	async compact(state: Uint8Array): Promise<void> {
		const split = [splitBytes(state)];
		await this.#renewing(true, async (trx) => {
			await trx.deleteFrom("_emdash_room_updates").where("room_id", "=", this.#roomId).execute();
			await this.#insertUpdates(trx, split);
		});
	}

	async drop(): Promise<void> {
		await this.#renewing(true, async (trx) => {
			await trx.deleteFrom("_emdash_room_updates").where("room_id", "=", this.#roomId).execute();
			await this.#deleteRecordParts(trx);
			await trx
				.updateTable("_emdash_rooms")
				.set({ record: null })
				.where("room_id", "=", this.#roomId)
				.where("part", "=", 0)
				.execute();
		});
	}

	async touch(): Promise<void> {
		if (!(await this.#renew(this.#db, true))) throw new RoomClaimLostError();
	}

	/**
	 * Refuses a live claim even when it is this process's: the host keeps one `Room` per room, so
	 * a claim left behind by a failed release costs a retry, not two writers.
	 */
	async claim(): Promise<boolean> {
		const now = timestampOffset(this.#db, 0);
		const claimed = await this.#db
			.insertInto("_emdash_rooms")
			.values({
				room_id: this.#roomId,
				part: 0,
				record: null,
				host: this.#host,
				claimed_at: now,
				updated_at: now,
			})
			// Table-qualified: Postgres rejects a bare name here as ambiguous with `excluded`.
			.onConflict((oc) =>
				oc
					.columns(["room_id", "part"])
					.doUpdateSet({ host: this.#host, claimed_at: now })
					.where((eb) =>
						eb.or([
							eb("_emdash_rooms.host", "is", null),
							leaseHasExpired(this.#db, "_emdash_rooms.claimed_at", -CLAIM_EXPIRY_SECONDS),
						]),
					),
			)
			.returning("room_id")
			.executeTakeFirst();
		return claimed !== undefined;
	}

	renew(): Promise<boolean> {
		return this.#renew(this.#db, false);
	}

	/** Deletes the room's row when it has no record, so rooms that never stored leave nothing. */
	async release(): Promise<void> {
		const deleted = await this.#db
			.deleteFrom("_emdash_rooms")
			.where("room_id", "=", this.#roomId)
			.where("part", "=", 0)
			.where("host", "=", this.#host)
			.where("record", "is", null)
			.executeTakeFirst();
		if (Number(deleted.numDeletedRows ?? 0) > 0) return;
		await this.#db
			.updateTable("_emdash_rooms")
			.set({ host: null, claimed_at: null })
			.where("room_id", "=", this.#roomId)
			.where("part", "=", 0)
			.where("host", "=", this.#host)
			.execute();
	}

	/** Renews this process's claim, and with `touch` restarts the stored state's hour. */
	async #renew(db: Kysely<Database>, touch: boolean): Promise<boolean> {
		const now = timestampOffset(db, 0);
		const result = await db
			.updateTable("_emdash_rooms")
			.set(touch ? { claimed_at: now, updated_at: now } : { claimed_at: now })
			.where("room_id", "=", this.#roomId)
			.where("part", "=", 0)
			.where("host", "=", this.#host)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0) > 0;
	}

	/**
	 * Runs `run` in one transaction whose first statement renews the claim. That orders it
	 * against a concurrent claim, and takes SQLite's write lock before any read.
	 */
	#renewing<T>(touch: boolean, run: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
		return withTransaction(this.#db, async (trx) => {
			if (!(await this.#renew(trx, touch))) throw new RoomClaimLostError();
			return run(trx);
		});
	}

	async #deleteRecordParts(trx: Kysely<Database>): Promise<void> {
		await trx
			.deleteFrom("_emdash_rooms")
			.where("room_id", "=", this.#roomId)
			.where("part", ">", 0)
			.execute();
	}

	/** Inserts updates, each split into parts, after the stored ones. */
	async #insertUpdates(trx: Kysely<Database>, updates: Uint8Array[][]): Promise<void> {
		if (updates.length === 0) return;
		const last = await trx
			.selectFrom("_emdash_room_updates")
			.select((eb) => eb.fn.max("seq").as("seq"))
			.where("room_id", "=", this.#roomId)
			.executeTakeFirst();
		const first = last?.seq == null ? 0 : Number(last.seq) + 1;
		const rows = updates.flatMap((parts, index) =>
			parts.map((data, part) => ({ room_id: this.#roomId, seq: first + index, part, data })),
		);
		for (const batch of chunks(rows, INSERT_ROWS)) {
			await trx.insertInto("_emdash_room_updates").values(batch).execute();
		}
	}
}

/** Whether another process holds the room's claim, renewed in the last minute. */
export async function isClaimedElsewhere(
	db: Kysely<Database>,
	roomId: string,
	host: string,
): Promise<boolean> {
	const row = await db
		.selectFrom("_emdash_rooms")
		.select("room_id")
		.where("room_id", "=", roomId)
		.where("part", "=", 0)
		.where("host", "is not", null)
		.where("host", "!=", host)
		.where(leaseIsLive(db, "claimed_at", -CLAIM_EXPIRY_SECONDS))
		.executeTakeFirst();
	return row !== undefined;
}

/**
 * Rooms whose stored state is past its hour, and whose claim is free, expired or this
 * process's: the candidates for the hourly drop.
 */
export async function listExpiredRooms(db: Kysely<Database>, host: string): Promise<string[]> {
	const rows = await db
		.selectFrom("_emdash_rooms")
		.select("room_id")
		.where("part", "=", 0)
		.where("record", "is not", null)
		.where(leaseHasExpired(db, "updated_at", -ROOM_STATE_LIFETIME_SECONDS))
		.where((eb) =>
			eb.or([
				eb("host", "is", null),
				eb("host", "=", host),
				leaseHasExpired(db, "claimed_at", -CLAIM_EXPIRY_SECONDS),
			]),
		)
		.execute();
	return rows.map((row) => row.room_id);
}
