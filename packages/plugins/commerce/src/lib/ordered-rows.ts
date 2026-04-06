import { PluginRouteError } from "emdash";
import { sortedImmutable } from "./sort-immutable.js";
import type { StorageCollection } from "emdash";

type Collection<T> = StorageCollection<T>;

export type OrderedRow = {
	id: string;
	position: number;
};

export type OrderedChildMutation<T extends OrderedRow> =
	| { kind: "add"; row: T; requestedPosition: number }
	| { kind: "remove"; removedRowId: string }
	| {
			kind: "move";
			rowId: string;
			requestedPosition: number;
			notFoundMessage?: string;
		};

export function sortOrderedRowsByPosition<T extends { createdAt?: string; position: number }>(rows: T[]): T[] {
	const sorted = sortedImmutable(rows, (left, right) => {
		if (left.position === right.position) {
			return (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
		}
		return left.position - right.position;
	});
	return sorted;
}

export function normalizeOrderedPosition(input: number): number {
	return Math.max(0, Math.trunc(input));
}

export function normalizeOrderedChildren<T extends OrderedRow>(rows: T[]): T[] {
	return rows.map((row, idx) => ({
		...row,
		position: idx,
	}));
}

export function addOrderedRow<T extends OrderedRow>(rows: T[], row: T, requestedPosition: number): T[] {
	const normalizedPosition = Math.min(normalizeOrderedPosition(requestedPosition), rows.length);
	const nextOrder = [...rows];
	nextOrder.splice(normalizedPosition, 0, row);
	return normalizeOrderedChildren(nextOrder);
}

export function removeOrderedRow<T extends OrderedRow>(rows: T[], removedRowId: string): T[] {
	return normalizeOrderedChildren(rows.filter((row) => row.id !== removedRowId));
}

export function moveOrderedRow<T extends OrderedRow>(rows: T[], rowId: string, requestedPosition: number): T[] {
	const fromIndex = rows.findIndex((row) => row.id === rowId);
	if (fromIndex === -1) {
		throw PluginRouteError.badRequest("Ordered row not found in target list");
	}

	const nextOrder = [...rows];
	const [moving] = nextOrder.splice(fromIndex, 1);
	if (!moving) {
		throw PluginRouteError.badRequest("Ordered row not found in target list");
	}

	const insertionIndex = Math.min(normalizeOrderedPosition(requestedPosition), rows.length - 1);
	nextOrder.splice(insertionIndex, 0, moving);
	return normalizeOrderedChildren(nextOrder);
}

export async function persistOrderedRows<T extends OrderedRow>(
	collection: Collection<T>,
	rows: T[],
	nowIso: string,
): Promise<T[]> {
	const normalized = normalizeOrderedChildren(rows).map((row) => ({
		...row,
		updatedAt: nowIso,
	}));
	const items = normalized.map((row) => ({ id: row.id, data: row }));
	if (items.length > 0) {
		if ("putMany" in collection && typeof collection.putMany === "function") {
			await collection.putMany(items);
		} else {
			for (const item of items) {
				await collection.put(item.id, item.data);
			}
		}
	}
	return normalized;
}

export async function mutateOrderedChildren<T extends OrderedRow>(params: {
	collection: Collection<T>;
	rows: T[];
	mutation: OrderedChildMutation<T>;
	nowIso: string;
}): Promise<T[]> {
	const { collection, rows, mutation, nowIso } = params;
	let normalized: T[] = [];
	const removeIds: string[] = [];
	switch (mutation.kind) {
		case "add":
			normalized = addOrderedRow(rows, mutation.row, mutation.requestedPosition);
			break;
		case "remove":
			normalized = removeOrderedRow(rows, mutation.removedRowId);
			removeIds.push(mutation.removedRowId);
			break;
		case "move": {
			const { rowId, requestedPosition } = mutation;
			const fromIndex = rows.findIndex((candidate) => candidate.id === rowId);
			if (fromIndex === -1) {
				throw PluginRouteError.badRequest(mutation.notFoundMessage ?? "Ordered row not found in target list");
			}
			normalized = moveOrderedRow(rows, rowId, requestedPosition);
			break;
		}
	}
	const persisted = await persistOrderedRows(collection, normalized, nowIso);
	if (removeIds.length > 0) {
		if ("deleteMany" in collection && typeof collection.deleteMany === "function") {
			await collection.deleteMany(removeIds);
		} else {
			for (const removeId of removeIds) {
				await collection.delete(removeId);
			}
		}
	}
	return persisted;
}

