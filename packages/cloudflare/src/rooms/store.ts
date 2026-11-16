/**
 * Room storage in the Durable Object's own SQLite, with the same two tables rooms use on Node.js.
 * `room_id` is the object's room ID, the same in every row. Every write sets the drop alarm an
 * hour ahead.
 */

import {
	joinParts,
	ROOM_STATE_LIFETIME_MS,
	splitBytes,
	splitText,
	type RoomRecord,
	type RoomStore,
} from "emdash/internal/co-editing";

const RECORDS = "_emdash_rooms";

export class DurableObjectRoomStore implements RoomStore {
	readonly #storage: DurableObjectStorage;
	readonly #roomId: string;
	/**
	 * Tables are created by this instance's first write, never at construction, so objects that
	 * notifications and lock checks reach without a room leave no storage behind.
	 */
	#created = false;

	constructor(storage: DurableObjectStorage, roomId: string) {
		this.#storage = storage;
		this.#roomId = roomId;
	}

	async load(): Promise<{
		record: RoomRecord | null;
		updates: Uint8Array[];
		updatedAt: number | null;
	}> {
		if (!this.#hasTables()) return { record: null, updates: [], updatedAt: null };
		const sql = this.#storage.sql;
		const recordRows = sql
			.exec<{ record: string | null; updated_at: number }>(
				"SELECT record, updated_at FROM _emdash_rooms WHERE room_id = ? ORDER BY part",
				this.#roomId,
			)
			.toArray();
		const parts = new Map<number, unknown[]>();
		for (const row of sql.exec<{ seq: number; data: ArrayBuffer }>(
			"SELECT seq, data FROM _emdash_room_updates WHERE room_id = ? ORDER BY seq, part",
			this.#roomId,
		)) {
			const list = parts.get(row.seq) ?? [];
			list.push(row.data);
			parts.set(row.seq, list);
		}
		const updates = Array.from(parts.values(), joinParts);
		const head = recordRows[0];
		if (!head || head.record === null) return { record: null, updates, updatedAt: null };
		const record: RoomRecord = JSON.parse(recordRows.map((row) => row.record ?? "").join(""));
		return { record, updates, updatedAt: head.updated_at };
	}

	async append(updates: Uint8Array[]): Promise<void> {
		await this.#write(() => this.#insertUpdates(updates));
	}

	async writeRecord(record: RoomRecord, update?: Uint8Array): Promise<void> {
		const [head = "", ...rest] = splitText(JSON.stringify(record));
		await this.#write((now) => {
			const sql = this.#storage.sql;
			sql.exec(
				`INSERT INTO _emdash_rooms (room_id, part, record, updated_at) VALUES (?, 0, ?, ?)
				ON CONFLICT (room_id, part) DO UPDATE SET record = excluded.record`,
				this.#roomId,
				head,
				now,
			);
			sql.exec("DELETE FROM _emdash_rooms WHERE room_id = ? AND part > 0", this.#roomId);
			for (const [index, value] of rest.entries()) {
				sql.exec(
					"INSERT INTO _emdash_rooms (room_id, part, record, updated_at) VALUES (?, ?, ?, ?)",
					this.#roomId,
					index + 1,
					value,
					now,
				);
			}
			if (update) this.#insertUpdates([update]);
		});
	}

	async compact(state: Uint8Array): Promise<void> {
		await this.#write(() => {
			this.#storage.sql.exec("DELETE FROM _emdash_room_updates WHERE room_id = ?", this.#roomId);
			this.#insertUpdates([state]);
		});
	}

	/** Deletes the tables too, so a room that dropped its state leaves no storage behind. */
	async drop(): Promise<void> {
		await this.#storage.deleteAll();
		await this.#storage.deleteAlarm();
		this.#created = false;
	}

	async touch(): Promise<void> {
		await this.#write(() => {});
	}

	async claim(): Promise<boolean> {
		return true;
	}

	async renew(): Promise<boolean> {
		return true;
	}

	async release(): Promise<void> {}

	/** Whether storage holds a room record or updates, for the alarm. */
	holdsState(): boolean {
		if (!this.#hasTables()) return false;
		const row = this.#storage.sql
			.exec<{ held: number }>(
				`SELECT EXISTS (SELECT 1 FROM _emdash_rooms WHERE room_id = ? AND record IS NOT NULL)
				OR EXISTS (SELECT 1 FROM _emdash_room_updates WHERE room_id = ?) AS held`,
				this.#roomId,
				this.#roomId,
			)
			.one();
		return row.held === 1;
	}

	#hasTables(): boolean {
		return (
			this.#storage.sql
				.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", RECORDS)
				.toArray().length > 0
		);
	}

	/** Runs `run` and restarts the stored state's hour in one transaction, then sets the alarm. */
	async #write(run: (now: number) => void): Promise<void> {
		const now = Date.now();
		this.#storage.transactionSync(() => {
			if (!this.#created) createTables(this.#storage.sql);
			run(now);
			this.#storage.sql.exec(
				"UPDATE _emdash_rooms SET updated_at = ? WHERE room_id = ? AND part = 0",
				now,
				this.#roomId,
			);
		});
		this.#created = true;
		await this.#storage.setAlarm(now + ROOM_STATE_LIFETIME_MS);
	}

	/** Inserts updates, each split into parts, after the stored ones. */
	#insertUpdates(updates: Uint8Array[]): void {
		const sql = this.#storage.sql;
		const last = sql
			.exec<{ seq: number | null }>(
				"SELECT max(seq) AS seq FROM _emdash_room_updates WHERE room_id = ?",
				this.#roomId,
			)
			.one();
		let seq = last.seq === null ? 0 : last.seq + 1;
		for (const update of updates) {
			for (const [part, data] of splitBytes(update).entries()) {
				sql.exec(
					"INSERT INTO _emdash_room_updates (room_id, seq, part, data) VALUES (?, ?, ?, ?)",
					this.#roomId,
					seq,
					part,
					copy(data),
				);
			}
			seq++;
		}
	}
}

function createTables(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS _emdash_room_updates (
		room_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		part INTEGER NOT NULL,
		data BLOB NOT NULL,
		PRIMARY KEY (room_id, seq, part)
	)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS _emdash_rooms (
		room_id TEXT NOT NULL,
		part INTEGER NOT NULL,
		record TEXT,
		host TEXT,
		claimed_at INTEGER,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (room_id, part)
	)`);
}

/** SQLite binds an `ArrayBuffer` whole, so a view into a larger buffer is copied out first. */
function copy(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}
