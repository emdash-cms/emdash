import * as Y from "yjs";

import { mergeRanges, snapshotContains, type DeleteRange } from "../../../co-editing/snapshot.js";

type DeleteSet = Y.Transaction["deleteSet"];

/** The replica at an own edit: its state vector, and how many logged delete sets it had. */
export interface CoverageMark {
	readonly sv: Map<number, number>;
	readonly length: number;
}

/**
 * Whether the last checkpoint contains the replica's snapshot from its own last edit. Taking that
 * snapshot with `Y.snapshot` would walk the whole store after every own keystroke, so the replica
 * keeps the delete set from its first sync, `base`, and logs every later transaction's deletions,
 * its own and others'. The snapshot at a mark is then the base merged with the log up to the mark,
 * with the mark's state vector: exact, and O(1) per transaction.
 */
export class Coverage {
	#base: DeleteSet | null = null;
	#log: DeleteSet[] = [];
	#mark: CoverageMark | null = null;
	#checkpoint: Y.Snapshot | null = null;
	readonly #clientId: number;

	constructor(clientId: number) {
		this.#clientId = clientId;
	}

	/** The own last edit no checkpoint is known to contain yet. */
	get mark(): CoverageMark | null {
		return this.#mark;
	}

	/** Called once, at the replica's first sync. Transactions before it are in the base. */
	start(doc: Y.Doc): void {
		this.#base ??= Y.createDeleteSetFromStructStore(doc.store);
	}

	/** Returns true when the transaction was an own edit, which moves the mark. */
	record(transaction: Y.Transaction, own: boolean): boolean {
		if (!this.#base) return false;
		const deleted = transaction.deleteSet.clients.size > 0;
		if (deleted) this.#log.push(transaction.deleteSet);
		if (!own) return false;
		const id = this.#clientId;
		if (!deleted && transaction.afterState.get(id) === transaction.beforeState.get(id))
			return false;
		this.#mark = { sv: transaction.afterState, length: this.#log.length };
		return true;
	}

	checkpoint(snapshot: Y.Snapshot): void {
		this.#checkpoint = snapshot;
	}

	/** Whether the last checkpoint contains the replica's snapshot at `mark`. */
	contains(mark: CoverageMark): boolean {
		return this.#deleteSetIfContained(mark) !== null;
	}

	/**
	 * Clears the mark once the last checkpoint contains it, and folds the log into the base when
	 * no mark needs it. Returns whether the own edits are covered.
	 */
	settle(): boolean {
		const mark = this.#mark;
		if (mark) {
			const deleteSet = this.#deleteSetIfContained(mark);
			if (!deleteSet) return false;
			this.#base = deleteSet;
			this.#log = this.#log.slice(mark.length);
			this.#mark = null;
		}
		if (this.#base && this.#log.length > 0) {
			this.#base = mergeDeleteSets([this.#base, ...this.#log]);
			this.#log = [];
		}
		return true;
	}

	/** The own edits are saved some other way, as a recovery revision. */
	forget(): void {
		this.#mark = null;
	}

	#deleteSetIfContained(mark: CoverageMark): DeleteSet | null {
		const checkpoint = this.#checkpoint;
		if (!checkpoint || !this.#base) return null;
		// An own edit that inserted has a clock no checkpoint has seen yet: fail before merging.
		for (const [client, clock] of mark.sv) {
			if (clock > (checkpoint.sv.get(client) ?? 0)) return null;
		}
		const deleteSet = mergeDeleteSets([this.#base, ...this.#log.slice(0, mark.length)]);
		return snapshotContains(checkpoint, Y.createSnapshot(deleteSet, mark.sv)) ? deleteSet : null;
	}
}

/**
 * A new delete set holding every range of `sets`. `Y.mergeDeleteSets` joins ranges by changing the
 * ones it read, which would change the base, the log, and a transaction's own delete set before
 * Yjs encodes its update.
 */
function mergeDeleteSets(sets: readonly DeleteSet[]): DeleteSet {
	const ranges = new Map<number, DeleteRange[]>();
	for (const set of sets) {
		for (const [client, deleted] of set.clients) {
			let list = ranges.get(client);
			if (!list) ranges.set(client, (list = []));
			for (const range of deleted) list.push(range);
		}
	}
	const merged = Y.createDeleteSet();
	for (const [client, list] of ranges) merged.clients.set(client, mergeRanges(list));
	return merged;
}
