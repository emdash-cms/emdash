/**
 * Tells rooms about outside writes. Repositories call `notifyRoom` after each write to an existing
 * entry. Inside the outermost `withTransaction` the notifications wait until it returns, so a room
 * never loads its entry before the write commits.
 *
 * Shared code may import this module, so it must stay free of the room engine.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { sql, type Kysely } from "kysely";

import { after } from "../after.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { chunks, SQL_BATCH_SIZE } from "../utils/chunks.js";
import { roomId, type EntryRef, type OutsideValue, type RoomHost } from "./types.js";

type RoomNotifier = Pick<RoomHost, "notify">;

interface NotificationQueue {
	/** Each room's merged outside values. */
	held: Map<string, Set<OutsideValue>>;
	/** The room whose own writes this queue drops. */
	skip: string | undefined;
	closed: boolean;
	parent: NotificationQueue | undefined;
}

interface NotificationState {
	notifier: RoomNotifier | null;
	queues: AsyncLocalStorage<NotificationQueue>;
}

const STATE_KEY = Symbol.for("emdash:rooms:notifications");
const store = globalThis as Record<symbol, unknown>;

function state(): NotificationState {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- private globalThis symbol slot
	let current = store[STATE_KEY] as NotificationState | undefined;
	if (!current) {
		current = { notifier: null, queues: new AsyncLocalStorage() };
		store[STATE_KEY] = current;
	}
	return current;
}

/** Sets the host notifications reach. With none, every function here does nothing. */
export function setRoomNotifier(notifier: RoomNotifier | null): void {
	state().notifier = notifier;
}

/** Clears the slot only while it holds this notifier, so an older host never clears a newer one. */
export function clearRoomNotifier(notifier: RoomNotifier): void {
	const current = state();
	if (current.notifier === notifier) current.notifier = null;
}

/** Writers that need a query to find the entries they changed skip it when this is false. */
export function hasRoomNotifier(): boolean {
	return state().notifier !== null;
}

/**
 * Tells the entry's room that a write changed it, and which values outside the shared document
 * changed. Waits in the innermost open queue, or goes out at once without one.
 */
export function notifyRoom(entry: EntryRef, outside: readonly OutsideValue[] = []): void {
	const { notifier, queues } = state();
	if (!notifier) return;
	const id = roomId(entry);
	const queue = openQueue(queues.getStore());
	if (queue) hold(queue, id, outside);
	else send(id, [...outside]);
}

/**
 * Tells the room of every locale in the translation groups, for writes keyed by group, such as
 * term assignments and published references. Runs no query while no notifier is set.
 */
export async function notifyEntryGroups(
	db: Kysely<Database>,
	collection: string,
	entryGroups: readonly string[],
	outside: readonly OutsideValue[],
): Promise<void> {
	if (!hasRoomNotifier()) return;
	validateIdentifier(collection, "collection type");
	const tableName = `ec_${collection}`;
	for (const batch of chunks([...new Set(entryGroups)], SQL_BATCH_SIZE)) {
		// oxlint-disable-next-line no-await-in-loop -- one statement per D1-safe batch
		const rows = await sql<{ id: string }>`
			SELECT id FROM ${sql.ref(tableName)}
			WHERE translation_group IN (${sql.join(batch)})
		`.execute(db);
		for (const row of rows.rows) notifyRoom({ collection, id: row.id }, outside);
	}
}

/**
 * Runs `run` with its notifications held until it settles, then sends one per room. Without
 * `skip`, joins a queue that is already open. With `skip`, always opens its own, which drops
 * that room's notifications while it is open and then hands the rest to the queue around it.
 * Opens nothing while no notifier is set.
 */
export async function withRoomNotificationQueue<T>(
	run: () => Promise<T>,
	options: { skip?: string } = {},
): Promise<T> {
	const { notifier, queues } = state();
	if (!notifier) return run();
	const parent = openQueue(queues.getStore());
	if (parent && options.skip === undefined) return run();
	const queue: NotificationQueue = {
		held: new Map(),
		skip: options.skip,
		closed: false,
		parent,
	};
	try {
		return await queues.run(queue, run);
	} finally {
		flush(queue);
	}
}

/** Work deferred past its queue's end still runs in that queue's context. */
function openQueue(queue: NotificationQueue | undefined): NotificationQueue | undefined {
	let current = queue;
	while (current?.closed) current = current.parent;
	return current;
}

function hold(queue: NotificationQueue, id: string, outside: Iterable<OutsideValue>): void {
	if (queue.skip === id) return;
	let values = queue.held.get(id);
	if (!values) {
		values = new Set();
		queue.held.set(id, values);
	}
	for (const value of outside) values.add(value);
}

function flush(queue: NotificationQueue): void {
	queue.closed = true;
	const parent = openQueue(queue.parent);
	for (const [id, values] of queue.held) {
		if (parent) hold(parent, id, values);
		else send(id, [...values]);
	}
	queue.held.clear();
}

/** Never awaited: the writer doesn't wait for the room. */
function send(id: string, outside: OutsideValue[]): void {
	after(() => state().notifier?.notify(id, outside));
}
