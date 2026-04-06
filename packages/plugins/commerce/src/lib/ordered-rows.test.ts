import { describe, expect, it } from "vitest";

import {
	addOrderedRow,
	moveOrderedRow,
	mutateOrderedChildren,
	normalizeOrderedChildren,
	normalizeOrderedPosition,
	removeOrderedRow,
	sortOrderedRowsByPosition,
} from "./ordered-rows.js";

type Row = { id: string; position: number; createdAt?: string; updatedAt?: string };

describe("ordered rows helpers", () => {
	it("sortOrderedRowsByPosition uses createdAt as tiebreaker for equal positions", () => {
		const rows: Row[] = [
			{ id: "late", position: 0, createdAt: "2026-01-01T00:00:00.000Z" },
			{ id: "early", position: 0, createdAt: "2025-01-01T00:00:00.000Z" },
			{ id: "next", position: 1, createdAt: "2026-01-01T00:00:00.000Z" },
		];
		const sorted = sortOrderedRowsByPosition(rows);
		expect(sorted.map((row) => row.id)).toEqual(["early", "late", "next"]);
	});

	it("normalizes ordered rows to dense zero-based positions", () => {
		const normalized = normalizeOrderedChildren<Row>([
			{ id: "a", position: 4 },
			{ id: "b", position: 9, createdAt: "2026-01-01T00:00:00.000Z" },
		]);
		expect(normalized.map((row) => row.position)).toEqual([0, 1]);
	});

	it("normalizes requested position input", () => {
		expect(normalizeOrderedPosition(-4)).toBe(0);
		expect(normalizeOrderedPosition(1.9)).toBe(1);
		expect(normalizeOrderedPosition(99)).toBe(99);
	});

	it("normalizes positions when adding a row (clamps oversized and negative input)", () => {
		const rows: Row[] = [
			{ id: "first", position: 0 },
			{ id: "second", position: 2 },
		];

		const withHead = addOrderedRow([...rows], { id: "head", position: 99 }, -9);
		expect(withHead.map((row) => row.position)).toEqual([0, 1, 2]);
		expect(withHead.map((row) => row.id)).toEqual(["head", "first", "second"]);

		const withTail = addOrderedRow([...rows], { id: "tail", position: 99 }, 10);
		expect(withTail.map((row) => row.position)).toEqual([0, 1, 2]);
		expect(withTail.map((row) => row.id)).toEqual(["first", "second", "tail"]);
	});

	it("removes by id and re-normalizes", () => {
		const rows: Row[] = [
			{ id: "keep", position: 0 },
			{ id: "drop", position: 1 },
			{ id: "keep2", position: 2 },
		];
		const kept = removeOrderedRow(rows, "drop");
		expect(kept.map((row) => row.id)).toEqual(["keep", "keep2"]);
		expect(kept.map((row) => row.position)).toEqual([0, 1]);
	});

	it("moves a row and keeps index behavior stable", () => {
		const rows: Row[] = [
			{ id: "left", position: 0 },
			{ id: "mid", position: 1 },
			{ id: "right", position: 2 },
		];
		const reordered = moveOrderedRow([...rows], "right", 0);
		expect(reordered.map((row) => row.id)).toEqual(["right", "left", "mid"]);
		expect(reordered.map((row) => row.position)).toEqual([0, 1, 2]);
	});

	it("moveOrderedRow throws for missing row ids", () => {
		const rows: Row[] = [
			{ id: "left", position: 0 },
			{ id: "mid", position: 1 },
		];
		expect(() => moveOrderedRow([...rows], "missing", 0)).toThrowError(
			"Ordered row not found in target list",
		);
	});

	it("mutateOrderedChildren preserves move not found message overrides", async () => {
		const rows: Row[] = [{ id: "left", position: 0 }];
		const collection = {
			put: async (_id: string, _row: Row) => {},
		} as any;

		await expect(() =>
			mutateOrderedChildren({
				collection,
				rows,
				mutation: {
					kind: "move",
					rowId: "missing",
					requestedPosition: 0,
					notFoundMessage: "row not found",
				},
				nowIso: "2026-01-01T00:00:00.000Z",
			}),
		).rejects.toThrowError("row not found");
	});

	it("mutateOrderedChildren persists normalized rows after mutation", async () => {
		const rows: Row[] = [
			{ id: "left", position: 0 },
			{ id: "mid", position: 1 },
			{ id: "right", position: 2 },
		];
		const persisted: Row[] = [];
		const collection = {
			put: async (_id: string, row: Row) => {
				persisted.push({ ...row });
			},
		} as any;

		const out = await mutateOrderedChildren({
			collection,
			rows,
			mutation: {
				kind: "move",
				rowId: "left",
				requestedPosition: 2,
			},
			nowIso: "2026-01-01T00:00:00.000Z",
		});

		expect(out.map((row) => row.id)).toEqual(["mid", "right", "left"]);
		expect(out.every((row) => row.updatedAt === "2026-01-01T00:00:00.000Z")).toBe(true);
		expect(persisted.map((row) => row.id)).toEqual(["mid", "right", "left"]);
	});

	it("mutateOrderedChildren uses batch writes and batch deletion for supported collections", async () => {
		const rows: Row[] = [
			{ id: "left", position: 0 },
			{ id: "mid", position: 1 },
			{ id: "right", position: 2 },
		];
		const persisted: Row[] = [];
		const deleted: string[] = [];
		const collection = {
			putMany: async (items: Array<{ id: string; data: Row }>) => {
				for (const item of items) {
					persisted.push({ ...item.data });
				}
			},
			deleteMany: async (ids: string[]) => {
				deleted.push(...ids);
			},
		} as any;

		await mutateOrderedChildren({
			collection,
			rows,
			mutation: {
				kind: "remove",
				removedRowId: "mid",
			},
			nowIso: "2026-01-01T00:00:00.000Z",
		});

		expect(persisted.map((row) => row.id)).toEqual(["left", "right"]);
		expect(persisted.every((row) => row.updatedAt === "2026-01-01T00:00:00.000Z")).toBe(true);
		expect(deleted).toEqual(["mid"]);
	});
});
