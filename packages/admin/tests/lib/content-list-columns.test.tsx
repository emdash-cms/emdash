import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
	resolveContentListColumns,
	type ContentListColumnCellContext,
	type ContentListColumnExtension,
	type ContentListColumnHeaderContext,
} from "../../src/lib/content-list-columns.js";

function Cell(): React.ReactNode {
	return null;
}

function column(
	id: string,
	overrides: Partial<ContentListColumnExtension> = {},
): ContentListColumnExtension {
	return { id, label: id, cell: Cell, ...overrides };
}

describe("resolveContentListColumns", () => {
	it("preserves memo and forwardRef components", () => {
		const ForwardRefCell = React.forwardRef<HTMLSpanElement, ContentListColumnCellContext>(
			function ForwardRefCell(_props, ref) {
				return <span ref={ref} />;
			},
		);
		const ForwardRefHeader = React.forwardRef<HTMLSpanElement, ContentListColumnHeaderContext>(
			function ForwardRefHeader(_props, ref) {
				return <span ref={ref} />;
			},
		);
		const MemoCell = React.memo(function MemoCell(_props: ContentListColumnCellContext) {
			return null;
		});
		const MemoHeader = React.memo(function MemoHeader(_props: ContentListColumnHeaderContext) {
			return null;
		});
		const plugins = {
			alpha: {
				contentListColumns: [
					column("forward-ref", { cell: ForwardRefCell, header: ForwardRefHeader }),
					column("memo", { cell: MemoCell, header: MemoHeader }),
				],
			},
		};

		const result = resolveContentListColumns(plugins, "posts", 0);

		expect(result).toHaveLength(2);
		expect(result[0]?.extension.cell).toBe(ForwardRefCell);
		expect(result[0]?.extension.header).toBe(ForwardRefHeader);
		expect(result[1]?.extension.cell).toBe(MemoCell);
		expect(result[1]?.extension.header).toBe(MemoHeader);
	});

	it("filters by manifest, collection, and role and orders deterministically", () => {
		const plugins = {
			zeta: { contentListColumns: [column("same", { order: 1 })] },
			alpha: {
				contentListColumns: [
					column("second", { order: 2 }),
					column("same", { order: 1 }),
					column("pages", { collections: ["pages"] }),
					column("admin", { minRole: 100 }),
				],
			},
			disabled: { contentListColumns: [column("disabled")] },
			stale: { contentListColumns: [column("stale")] },
		};

		const result = resolveContentListColumns(plugins, "posts", 10, {
			alpha: { enabled: true },
			zeta: { enabled: true },
			disabled: { enabled: false },
		});

		expect(result.map(({ pluginId, extension }) => `${pluginId}:${extension.id}`)).toEqual([
			"alpha:same",
			"zeta:same",
			"alpha:second",
		]);
	});

	it("ignores malformed exports and duplicate ids within one plugin", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const plugins = {
			alpha: {
				contentListColumns: [
					column("review-status"),
					column("review-status"),
					["array-is-not-a-column"],
					{ id: "broken", label: "Broken" },
				],
			},
			beta: { contentListColumns: "not-an-array" },
		};

		const result = resolveContentListColumns(
			plugins as unknown as Parameters<typeof resolveContentListColumns>[0],
			"posts",
			0,
		);

		expect(result).toHaveLength(1);
		expect(result[0]?.extension.id).toBe("review-status");
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("contains collection predicate failures", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const plugins = {
			alpha: {
				contentListColumns: [
					column("broken", {
						collections: () => {
							throw new Error("predicate failed");
						},
					}),
					column("healthy"),
				],
			},
		};

		const result = resolveContentListColumns(plugins, "posts", 0);

		expect(result.map(({ extension }) => extension.id)).toEqual(["healthy"]);
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
