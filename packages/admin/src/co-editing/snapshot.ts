import * as Y from "yjs";

export interface DeleteRange {
	clock: number;
	len: number;
}

/**
 * Whether snapshot `a` contains `b`: every client clock in `b`'s state vector is at most `a`'s,
 * and every range `b` deleted is inside the ranges `a` deleted for that client. A state vector
 * alone misses an edit that only deletes.
 */
export function snapshotContains(a: Y.Snapshot, b: Y.Snapshot): boolean {
	for (const [client, clock] of b.sv) {
		if (clock > (a.sv.get(client) ?? 0)) return false;
	}
	for (const [client, deleted] of b.ds.clients) {
		const covering = mergeRanges(a.ds.clients.get(client) ?? []);
		for (const range of deleted) {
			if (!covers(covering, range)) return false;
		}
	}
	return true;
}

/** New ranges, sorted, with overlapping and adjacent ranges joined. */
export function mergeRanges(ranges: readonly DeleteRange[]): DeleteRange[] {
	const sorted = ranges.toSorted((x, y) => x.clock - y.clock);
	const merged: DeleteRange[] = [];
	for (const range of sorted) {
		const last = merged.at(-1);
		if (last && range.clock <= last.clock + last.len) {
			last.len = Math.max(last.len, range.clock + range.len - last.clock);
		} else {
			merged.push({ clock: range.clock, len: range.len });
		}
	}
	return merged;
}

function covers(merged: readonly DeleteRange[], range: DeleteRange): boolean {
	if (range.len <= 0) return true;
	let low = 0;
	let high = merged.length - 1;
	let candidate: DeleteRange | undefined;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const item = merged[middle];
		if (!item) break;
		if (item.clock <= range.clock) {
			candidate = item;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return candidate !== undefined && candidate.clock + candidate.len >= range.clock + range.len;
}
