import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;

		constructor(ctx: unknown) {
			this.ctx = ctx;
		}
	},
}));

import { EmDashPreviewDB } from "../../src/db/do-class.js";

function cursor(rows: Record<string, unknown>[] = [], rowsWritten = 0) {
	return {
		rowsWritten,
		one: () => {
			if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
			return rows[0]!;
		},
		[Symbol.iterator]: () => rows[Symbol.iterator](),
	};
}

describe("EmDashPreviewDB affected rows", () => {
	it("reports SQLite changes(), not rowsWritten, for a write to an indexed table", () => {
		const exec = vi.fn((sql: string) =>
			sql === "SELECT changes() AS changes"
				? cursor([{ changes: 1 }])
				: // One updated row plus two index entries.
					cursor([], 3),
		);
		const db = new EmDashPreviewDB({ storage: { sql: { exec } } } as never, {});

		expect(db.query("UPDATE posts SET title = ? WHERE id = ?", ["t", "1"]).changes).toBe(1);
	});

	it("reports no change count for reads", () => {
		const exec = vi.fn(() => cursor([{ id: "1" }]));
		const db = new EmDashPreviewDB({ storage: { sql: { exec } } } as never, {});

		expect(db.query("SELECT id FROM posts").changes).toBeUndefined();
		expect(exec).toHaveBeenCalledTimes(1);
	});
});
