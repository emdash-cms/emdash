import type { Kysely, Transaction } from "kysely";

import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import type { OutsideValue } from "../../src/rooms/types.js";

export interface RecordedNotification {
	roomId: string;
	outside: OutsideValue[];
	/** Transactions committed on the observed database when the room was notified. */
	commits: number;
}

/** A room host that records the notifications it gets. */
export class RecordingNotifier {
	readonly calls: RecordedNotification[] = [];
	commits = 0;

	notify(roomId: string, outside: OutsideValue[]): Promise<void> {
		this.calls.push({ roomId, outside: outside.toSorted(), commits: this.commits });
		return Promise.resolve();
	}

	/** The notifications since the last call, once every deferred send has run. */
	async take(): Promise<RecordedNotification[]> {
		await waitForDeferredTasks();
		return this.calls.splice(0);
	}

	/** Each notified room with its outside values, in order. */
	async rooms(): Promise<[string, OutsideValue[]][]> {
		return (await this.take()).map((call) => [call.roomId, call.outside]);
	}

	/** `db`, counting on this notifier each transaction it commits. */
	observeCommits<DB>(db: Kysely<DB>): Kysely<DB> {
		return new Proxy(db, {
			get: (target, prop) => {
				if (prop === "transaction") {
					return () => {
						const builder = target.transaction();
						return {
							execute: async <T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> => {
								const result = await builder.execute(fn);
								this.commits++;
								return result;
							},
						};
					};
				}
				// Kysely reads private fields off `this`, which a proxy doesn't carry.
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
}

/** `db`, counting the queries it runs. */
export function countQueries<DB>(db: Kysely<DB>): { db: Kysely<DB>; count: () => number } {
	let count = 0;
	return {
		db: db.withPlugin({
			transformQuery: (args) => args.node,
			transformResult: async (args) => {
				count++;
				return args.result;
			},
		}),
		count: () => count,
	};
}
