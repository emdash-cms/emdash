/**
 * Lists a room saves outside its document, such as bylines and reference selections, save whole.
 * So that one tab's save keeps what other people saved since it last read the entry, each change
 * goes out re-based on the list as the server has it, one save at a time.
 */

export interface ListOptions<T> {
	key: (item: T) => string;
	/** Whether two items with the same key read the same. */
	same?: (a: T, b: T) => boolean;
}

/**
 * Applies the change from `base` to `mine` to `latest`. The result keeps `mine`'s order and
 * edits, drops what others removed and takes their edits to items this tab left alone, and adds
 * what others added after the item before it in `latest`. With `complete` false, `latest` is only
 * the start of the list, so an item missing from it doesn't count as removed.
 */
export function rebaseList<T>(
	base: readonly T[],
	mine: readonly T[],
	latest: readonly T[],
	{ key, same = () => true }: ListOptions<T>,
	complete = true,
): T[] {
	const before = new Map(base.map((item) => [key(item), item]));
	const theirs = new Map(latest.map((item) => [key(item), item]));
	const result: T[] = [];
	for (const item of mine) {
		const original = before.get(key(item));
		const current = theirs.get(key(item));
		if (original === undefined || !same(item, original)) result.push(item);
		else if (current !== undefined) result.push(current);
		else if (!complete) result.push(item);
	}
	const positions = new Map(result.map((item, index) => [key(item), index]));
	let insertAt = 0;
	for (const item of latest) {
		const itemKey = key(item);
		const placed = positions.get(itemKey);
		if (placed !== undefined) {
			insertAt = placed + 1;
			continue;
		}
		if (before.has(itemKey)) continue;
		result.splice(insertAt, 0, item);
		for (const [other, index] of positions) if (index >= insertAt) positions.set(other, index + 1);
		positions.set(itemKey, insertAt);
		insertAt++;
	}
	return result;
}

export interface ListSaverOptions<T> extends ListOptions<T> {
	/** The list as this tab shows it now. */
	shown: () => T[];
	/**
	 * Saves the list `build` makes from the server's latest list, which `complete` says is all of
	 * it. Rejects, with the failure already shown, if the save fails.
	 */
	save: (build: (latest: readonly T[], complete: boolean) => T[]) => Promise<unknown>;
	/** Once nothing is left to send: the list the server now has, or null after a failed save. */
	settled: (saved: T[] | null) => void;
}

/**
 * Sends one list's changes one at a time. A change made while a save is on its way goes out after
 * it, and a failed change stays unsent until the next change sends it along.
 */
export class ListSaver<T> {
	readonly #options: ListSaverOptions<T>;
	/** The server's list this tab's unsent change started from, or null with nothing unsent. */
	#base: T[] | null = null;
	#sending = false;

	constructor(options: ListSaverOptions<T>) {
		this.#options = options;
	}

	/** Whether this tab holds a change the server hasn't saved yet. */
	get unsent(): boolean {
		return this.#sending || this.#base !== null;
	}

	/** Records a change from `before` to the list shown now, and sends it. */
	change(before: readonly T[]): void {
		this.#base ??= [...before];
		void this.#send();
	}

	/**
	 * The list to show once the server's list is `latest`: it, with this tab's unsent change on
	 * top. While a save is on its way, its own result decides.
	 */
	adopt(latest: readonly T[], shown: readonly T[], complete = true): readonly T[] {
		if (this.#sending) return shown;
		if (this.#base === null) return latest;
		const merged = rebaseList(this.#base, shown, latest, this.#options, complete);
		// Past the start of the list, the server's rows are still the ones the old base holds.
		const seen = new Set(latest.map(this.#options.key));
		this.#base = complete
			? [...latest]
			: [...latest, ...this.#base.filter((item) => !seen.has(this.#options.key(item)))];
		return merged;
	}

	async #send(): Promise<void> {
		const base = this.#base;
		if (this.#sending || base === null) return;
		this.#sending = true;
		this.#base = null;
		const mine = this.#options.shown();
		let saved: T[] = mine;
		try {
			await this.#options.save((latest, complete) => {
				saved = rebaseList(base, mine, latest, this.#options, complete);
				return saved;
			});
		} catch {
			const later = this.#base !== null;
			this.#base = base;
			this.#sending = false;
			if (later) void this.#send();
			else this.#options.settled(null);
			return;
		}
		this.#sending = false;
		if (this.#base !== null) void this.#send();
		else this.#options.settled(saved);
	}
}
