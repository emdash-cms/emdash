import { snapshotContains } from "@emdash-cms/admin/internal/co-editing";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { decodeCheckpoint, encodeCheckpoint } from "../../../src/rooms/snapshot.js";

/** A snapshot as a room record stores and loads it. */
function recorded(doc: Y.Doc): Y.Snapshot {
	return decodeCheckpoint(encodeCheckpoint(Y.snapshot(doc)));
}

function sync(from: Y.Doc, to: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function manual(sv: Array<[number, number]>, deleted: Array<[number, Array<[number, number]>]>) {
	const ds = Y.createDeleteSet();
	for (const [client, ranges] of deleted) {
		ds.clients.set(
			client,
			ranges.map(([clock, len]) => ({ clock, len })),
		);
	}
	return Y.createSnapshot(ds, new Map(sv));
}

describe("snapshotContains", () => {
	it("contains an earlier snapshot of the same document, and not a later one", () => {
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "hello");
		const before = recorded(doc);
		doc.getText("t").insert(5, " world");
		const after = recorded(doc);

		expect(snapshotContains(after, before)).toBe(true);
		expect(snapshotContains(before, after)).toBe(false);
		expect(snapshotContains(after, after)).toBe(true);
	});

	it("notices an edit that only deletes", () => {
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "hello");
		const before = recorded(doc);
		doc.getText("t").delete(1, 2);
		const after = recorded(doc);

		expect(after.sv).toEqual(before.sv);
		expect(snapshotContains(before, after)).toBe(false);
		expect(snapshotContains(after, before)).toBe(true);
	});

	it("notices a delete-only edit inside a range the earlier snapshot already deleted part of", () => {
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "abcdef");
		doc.getText("t").delete(1, 1);
		const before = recorded(doc);
		doc.getText("t").delete(1, 2);
		const after = recorded(doc);

		expect(snapshotContains(before, after)).toBe(false);
		expect(snapshotContains(after, before)).toBe(true);
	});

	it("keeps concurrent clients apart until their updates meet", () => {
		const base = new Y.Doc();
		base.getText("t").insert(0, "shared text");
		const ana = new Y.Doc();
		const ben = new Y.Doc();
		sync(base, ana);
		sync(base, ben);

		ana.getText("t").insert(0, "Ana ");
		ben.getText("t").delete(0, 7);
		const anaSnapshot = recorded(ana);
		const benSnapshot = recorded(ben);

		expect(snapshotContains(anaSnapshot, benSnapshot)).toBe(false);
		expect(snapshotContains(benSnapshot, anaSnapshot)).toBe(false);

		sync(ana, ben);
		sync(ben, ana);
		const merged = recorded(ana);

		expect(snapshotContains(merged, anaSnapshot)).toBe(true);
		expect(snapshotContains(merged, benSnapshot)).toBe(true);
		expect(snapshotContains(recorded(ben), merged)).toBe(true);
	});

	it("treats a deleted range as covered when several ranges cover it together", () => {
		const covering = manual(
			[[1, 10]],
			[
				[
					1,
					[
						[4, 2],
						[0, 2],
						[2, 2],
					],
				],
			],
		);

		expect(snapshotContains(covering, manual([[1, 10]], [[1, [[1, 5]]]]))).toBe(true);
		expect(snapshotContains(covering, manual([[1, 10]], [[1, [[1, 6]]]]))).toBe(false);
		expect(snapshotContains(covering, manual([[1, 10]], [[2, [[0, 1]]]]))).toBe(false);
	});

	it("compares state vectors client by client", () => {
		expect(snapshotContains(manual([[1, 5]], []), manual([[2, 1]], []))).toBe(false);
		expect(
			snapshotContains(
				manual(
					[
						[1, 5],
						[2, 3],
					],
					[],
				),
				manual([[2, 3]], []),
			),
		).toBe(true);
	});
});

describe("checkpoint encoding", () => {
	it("round trips a snapshot through the record's base64 form", () => {
		const doc = new Y.Doc();
		doc.getText("t").insert(0, "hello");
		doc.getText("t").delete(0, 1);
		const snapshot = Y.snapshot(doc);

		expect(Y.equalSnapshots(decodeCheckpoint(encodeCheckpoint(snapshot)), snapshot)).toBe(true);
	});
});
