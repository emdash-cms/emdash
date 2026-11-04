import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	EmDashTable,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
} from "../../src/components/editor/TableExtensions";
import { createTableResize, ResponsiveTableView } from "../../src/components/editor/TableResize";
import { TABLE_CELL_MIN_WIDTH } from "../../src/portable-text-table";

import "../../src/styles.css";

const editors: Editor[] = [];
const hosts: HTMLElement[] = [];

function tableContent(widths: number[] | null = [128, 160]): JSONContent {
	const columns = widths ?? [0, 0];
	return {
		type: "doc",
		content: [
			{
				type: "table",
				content: Array.from({ length: 2 }, (_, row) => ({
					type: "tableRow",
					content: columns.map((width, column) => ({
						type: "tableCell",
						attrs: { colspan: 1, rowspan: 1, colwidth: widths ? [width] : null },
						content: [
							{
								type: "paragraph",
								content: [{ type: "text", text: `${row}:${column}` }],
							},
						],
					})),
				})),
			},
		],
	};
}

function spanningTableContent(): JSONContent {
	return {
		type: "doc",
		content: [
			{
				type: "table",
				content: [
					{
						type: "tableRow",
						content: [
							{
								type: "tableCell",
								attrs: { colspan: 2, rowspan: 1, colwidth: [128, 160] },
								content: [{ type: "paragraph", content: [{ type: "text", text: "span" }] }],
							},
						],
					},
					{
						type: "tableRow",
						content: [
							{
								type: "tableCell",
								attrs: { colspan: 1, rowspan: 1, colwidth: [128] },
								content: [{ type: "paragraph", content: [{ type: "text", text: "left" }] }],
							},
							{
								type: "tableCell",
								attrs: { colspan: 1, rowspan: 1, colwidth: [160] },
								content: [{ type: "paragraph", content: [{ type: "text", text: "right" }] }],
							},
						],
					},
				],
			},
		],
	};
}

function mixedWidthSpanContent(): JSONContent {
	return {
		type: "doc",
		content: [
			{
				type: "table",
				content: [
					{
						type: "tableRow",
						content: [
							{
								type: "tableCell",
								attrs: { colspan: 2, rowspan: 1, colwidth: [1, 0] },
								content: [{ type: "paragraph", content: [{ type: "text", text: "span" }] }],
							},
						],
					},
				],
			},
		],
	};
}

function createEditor(
	direction: "ltr" | "rtl",
	options: { content?: JSONContent; editable?: boolean; onResized?: () => void } = {},
) {
	const host = document.createElement("div");
	host.dir = direction;
	host.style.width = "480px";
	document.body.append(host);
	hosts.push(host);

	const editor = new Editor({
		element: host,
		editable: options.editable,
		extensions: [
			StarterKit,
			EmDashTable.configure({ resizable: false }),
			EmDashTableRow,
			EmDashTableHeader,
			EmDashTableCell,
			createTableResize(options.onResized),
		],
		content: options.content ?? tableContent(),
	});
	editors.push(editor);
	for (const cell of host.querySelectorAll<HTMLElement>("td, th")) cell.style.position = "relative";
	return { editor, host };
}

function tableColumnWidths(editor: Editor, column: number): number[] {
	const table = editor.getJSON().content?.[0];
	return (table?.content ?? []).map((row) => {
		const width = row.content?.[column]?.attrs?.colwidth;
		return Array.isArray(width) && typeof width[0] === "number" ? width[0] : 0;
	});
}

function mouse(target: EventTarget, type: string, clientX: number, clientY = 10) {
	const event = new MouseEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		buttons: type === "mouseup" ? 0 : 1,
		clientX,
		clientY,
	});
	target.dispatchEvent(event);
	return event;
}

function activateHandle(cell: HTMLTableCellElement, direction: "ltr" | "rtl", distance = 1) {
	const rect = cell.getBoundingClientRect();
	const inlineEnd = direction === "rtl" ? rect.left : rect.right;
	mouse(
		cell,
		"mousemove",
		direction === "rtl" ? inlineEnd + distance : inlineEnd - distance,
		rect.top + 4,
	);
	const handle = cell
		.closest(".ProseMirror")
		?.querySelector<HTMLElement>("[data-emdash-resize-cell]");
	expect(handle).toBeTruthy();
	const handleRect = handle!.getBoundingClientRect();
	expect(
		Math.abs((direction === "rtl" ? handleRect.left : handleRect.right) - inlineEnd),
	).toBeLessThanOrEqual(1);
	return { handle: handle!, inlineEnd };
}

function resizeColumn(cell: HTMLTableCellElement, direction: "ltr" | "rtl", delta: number) {
	const { handle, inlineEnd } = activateHandle(cell, direction);
	mouse(handle, "mousedown", inlineEnd);
	const finishX = direction === "rtl" ? inlineEnd - delta : inlineEnd + delta;
	mouse(window, "mousemove", finishX);
	mouse(window, "mousemove", finishX);
	mouse(window, "mouseup", finishX);
}

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
	for (const host of hosts.splice(0)) host.remove();
});

describe("direction-aware table resizing", () => {
	it("renders a fluid table with a numeric preferred minimum width", () => {
		const { host } = createEditor("ltr");
		const table = host.querySelector("table");

		expect(table).toBeTruthy();
		expect(table?.style.width).toBe("100%");
		expect(table?.style.minWidth).toBe("288px");
		expect(host.querySelector(".tableWrapper")).toBeTruthy();
		expect(ResponsiveTableView).toBeTypeOf("function");
	});

	it("enforces the visual minimum for valid sub-minimum stored widths", () => {
		const { editor, host } = createEditor("ltr", { content: tableContent(Array(10).fill(1)) });
		const table = host.querySelector<HTMLTableElement>("table")!;
		const wrapper = table.parentElement!;
		const style = getComputedStyle(wrapper);
		expect(table.style.width).toBe("100%");
		expect(table.style.minWidth).toBe("960px");
		expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).toEqual(
			Array(10).fill("96px"),
		);
		expect(tableColumnWidths(editor, 0)).toEqual([1, 1]);
		expect(wrapper.scrollWidth >= 960 && style.overflowY === "hidden").toBe(true);
	});

	it("measures automatic span segments after clamping neighboring rendered widths", () => {
		const { editor, host } = createEditor("ltr", { content: mixedWidthSpanContent() });
		const cell = host.querySelector<HTMLTableCellElement>("td")!;
		const expected = Math.max(TABLE_CELL_MIN_WIDTH, cell.offsetWidth - TABLE_CELL_MIN_WIDTH) + 1;

		resizeColumn(cell, "ltr", 1);

		expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([
			1,
			Math.round(expected),
		]);
	});

	it("commits an LTR resize and handle cleanup together with undo and redo", () => {
		const { editor, host } = createEditor("ltr");
		const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
		const { handle, inlineEnd } = activateHandle(firstCell, "ltr");
		const transactions: Array<{ changed: boolean; handles: number; scrolled: boolean }> = [];
		editor.on("transaction", ({ transaction }) => {
			transactions.push({
				changed: transaction.docChanged,
				handles: host.querySelectorAll("[data-emdash-resize-cell]").length,
				scrolled: transaction.scrolledIntoView,
			});
		});

		mouse(handle, "mousedown", inlineEnd);
		mouse(window, "mousemove", inlineEnd + 32);
		mouse(window, "mousemove", inlineEnd + 32);
		mouse(window, "mouseup", inlineEnd + 32);

		expect(transactions).toEqual([{ changed: true, handles: 0, scrolled: false }]);
		expect(tableColumnWidths(editor, 0)).toEqual([160, 160]);
		expect(editor.commands.undo()).toBe(true);
		expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
		expect(editor.commands.redo()).toBe(true);
		expect(tableColumnWidths(editor, 0)).toEqual([160, 160]);
	});

	it("announces only a committed non-zero resize", () => {
		const onResized = vi.fn();
		const { host } = createEditor("ltr", { onResized });
		const cell = host.querySelector<HTMLTableCellElement>("td")!;
		resizeColumn(cell, "ltr", 0);
		expect(onResized).not.toHaveBeenCalled();
		resizeColumn(cell, "ltr", 16);
		expect(onResized).toHaveBeenCalledOnce();
	});

	it("keeps persisted widths within the portable table contract", () => {
		const { editor, host } = createEditor("ltr");

		resizeColumn(host.querySelector<HTMLTableCellElement>("td")!, "ltr", 10_000);

		expect(tableColumnWidths(editor, 0)).toEqual([4096, 4096]);
	});

	it.each([
		[0, 128],
		[1, 160],
	] as const)("resizes RTL logical column %s from its inline-end edge", (column, initialWidth) => {
		const { editor, host } = createEditor("rtl");
		const cell = host.querySelectorAll<HTMLTableCellElement>("tr:first-child td")[column]!;

		resizeColumn(cell, "rtl", 32);

		expect(tableColumnWidths(editor, column)).toEqual([
			Math.max(TABLE_CELL_MIN_WIDTH, initialWidth + 32),
			Math.max(TABLE_CELL_MIN_WIDTH, initialWidth + 32),
		]);
	});

	it.each(["ltr", "rtl"] as const)(
		"uses a 24px non-overlapping pointer target in %s",
		(direction) => {
			const { host } = createEditor(direction);
			const cell = host.querySelector<HTMLTableCellElement>("tr:first-child td:last-child")!;
			for (const edge of ["start", "end"] as const) {
				const { handle, inlineEnd } = activateHandle(cell, direction, 23);
				const rect = handle.getBoundingClientRect();
				const clientX = edge === "start" ? rect.left + 1 : rect.right - 1;
				const clientY = rect.top + rect.height / 2;

				expect(rect.width).toBeGreaterThanOrEqual(24);
				expect(
					Math.abs((direction === "rtl" ? rect.left : rect.right) - inlineEnd),
				).toBeLessThanOrEqual(1);
				expect(document.elementFromPoint(clientX, clientY)).toBe(handle);
				mouse(handle, "mousemove", clientX);
				expect(host.querySelector("[data-emdash-resize-cell]")).toBe(handle);
				expect(mouse(handle, "mousedown", clientX).defaultPrevented).toBe(true);
				mouse(window, "mouseup", clientX);
			}
		},
	);

	it("does not expose or dispatch resizing in a read-only editor", () => {
		const { editor, host } = createEditor("ltr", { editable: false });
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction }) => {
			if (transaction.docChanged) documentTransactions++;
		});
		const cell = host.querySelector<HTMLTableCellElement>("td")!;
		const rect = cell.getBoundingClientRect();

		mouse(cell, "mousemove", rect.right - 1, rect.top + 4);

		expect(host.querySelector("[data-emdash-resize-cell]")).toBeNull();
		expect(documentTransactions).toBe(0);
		expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
	});

	it("cancels an active drag when the editor becomes read-only", () => {
		const { editor, host } = createEditor("ltr");
		const cell = host.querySelector<HTMLTableCellElement>("td")!;
		const table = host.querySelector<HTMLTableElement>("table")!;
		const persistedColumns = Array.from(table.querySelectorAll("col"), (col) => col.style.width);
		const persistedMinimum = table.style.minWidth;
		const { handle, inlineEnd } = activateHandle(cell, "ltr");
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction }) => {
			if (transaction.docChanged) documentTransactions++;
		});
		mouse(handle, "mousedown", inlineEnd);
		mouse(window, "mousemove", inlineEnd + 32);
		expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).not.toEqual(
			persistedColumns,
		);

		editor.setEditable(false);

		expect(host.querySelector("[data-emdash-resize-cell]")).toBeNull();
		expect(host.querySelector(".ProseMirror")?.classList.contains("resize-cursor")).toBe(false);
		expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).toEqual(
			persistedColumns,
		);
		expect(table.style.minWidth).toBe(persistedMinimum);
		mouse(window, "mouseup", inlineEnd + 32);
		expect(documentTransactions).toBe(0);
		expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
	});

	it("clears a mapped handle when its table is deleted", () => {
		const { editor, host } = createEditor("ltr");
		activateHandle(host.querySelector<HTMLTableCellElement>("td")!, "ltr");

		expect(() => editor.commands.deleteTable()).not.toThrow();
		expect(host.querySelector("[data-emdash-resize-cell]")).toBeNull();
		expect(host.querySelector(".ProseMirror")?.classList.contains("resize-cursor")).toBe(false);

		expect(editor.commands.insertTable({ rows: 1, cols: 1, withHeaderRow: false })).toBe(true);
		const newCell = host.querySelector<HTMLTableCellElement>("td")!;
		resizeColumn(newCell, "ltr", 16);
		expect(tableColumnWidths(editor, 0)[0]).toBeGreaterThan(TABLE_CELL_MIN_WIDTH);
	});

	it("renders a handle only on cells ending at the active column boundary", () => {
		const { host } = createEditor("ltr", { content: spanningTableContent() });
		const lowerLeft = host.querySelectorAll<HTMLTableCellElement>("tr:nth-child(2) td")[0]!;

		activateHandle(lowerLeft, "ltr");

		const handles = host.querySelectorAll<HTMLElement>("[data-emdash-resize-cell]");
		expect(handles).toHaveLength(1);
		expect(handles[0]?.closest("td")?.textContent).toBe("left");
	});

	it.each(["blur", "pointercancel"] as const)(
		"cancels on %s and permits a later drag",
		(eventType) => {
			const { editor, host } = createEditor("ltr");
			const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
			const table = host.querySelector<HTMLTableElement>("table")!;
			const persistedColumns = Array.from(table.querySelectorAll("col"), (col) => col.style.width);
			const persistedMinimum = table.style.minWidth;
			const { handle, inlineEnd } = activateHandle(firstCell, "ltr");
			mouse(handle, "mousedown", inlineEnd);
			mouse(window, "mousemove", inlineEnd + 32);
			expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).not.toEqual(
				persistedColumns,
			);

			window.dispatchEvent(
				eventType === "blur" ? new Event("blur") : new PointerEvent("pointercancel"),
			);

			expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
			expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).toEqual(
				persistedColumns,
			);
			expect(table.style.minWidth).toBe(persistedMinimum);
			resizeColumn(firstCell, "ltr", 16);
			expect(tableColumnWidths(editor, 0)).toEqual([144, 144]);
		},
	);

	it("recovers when mouse movement reports a missed mouseup", () => {
		const { editor, host } = createEditor("ltr");
		const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
		const table = host.querySelector<HTMLTableElement>("table")!;
		const persistedColumns = Array.from(table.querySelectorAll("col"), (col) => col.style.width);
		const { handle, inlineEnd } = activateHandle(firstCell, "ltr");
		mouse(handle, "mousedown", inlineEnd);
		mouse(window, "mousemove", inlineEnd + 32);

		window.dispatchEvent(
			new MouseEvent("mousemove", {
				bubbles: true,
				buttons: 0,
				clientX: inlineEnd + 32,
				clientY: 10,
			}),
		);

		expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
		expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).toEqual(
			persistedColumns,
		);
		resizeColumn(firstCell, "ltr", 16);
		expect(tableColumnWidths(editor, 0)).toEqual([144, 144]);
	});

	it("cancels when the primary button bit is no longer pressed", () => {
		const { editor, host } = createEditor("ltr");
		const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
		const { handle, inlineEnd } = activateHandle(firstCell, "ltr");
		mouse(handle, "mousedown", inlineEnd);
		window.dispatchEvent(
			new MouseEvent("mousemove", {
				bubbles: true,
				buttons: 2,
				clientX: inlineEnd + 32,
				clientY: 10,
			}),
		);

		expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
		resizeColumn(firstCell, "ltr", 16);
		expect(tableColumnWidths(editor, 0)).toEqual([144, 144]);
	});

	it("ignores non-primary mouseup while the primary drag continues", () => {
		const { editor, host } = createEditor("ltr");
		const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
		const { handle, inlineEnd } = activateHandle(firstCell, "ltr");
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction }) => {
			if (transaction.docChanged) documentTransactions++;
		});
		mouse(handle, "mousedown", inlineEnd);
		window.dispatchEvent(
			new MouseEvent("mouseup", {
				bubbles: true,
				button: 2,
				buttons: 1,
				clientX: inlineEnd + 16,
				clientY: 10,
			}),
		);
		expect(documentTransactions).toBe(0);
		mouse(window, "mousemove", inlineEnd + 32);
		mouse(window, "mouseup", inlineEnd + 32);

		expect(documentTransactions).toBe(1);
		expect(tableColumnWidths(editor, 0)).toEqual([160, 160]);
	});

	it.each(["ltr", "rtl"] as const)(
		"does not expand wrapper overflow for the outer %s resize target",
		(direction) => {
			const { host } = createEditor(direction, { content: tableContent([256, 256]) });
			const wrapper = host.querySelector<HTMLElement>(".tableWrapper")!;
			const before = wrapper.scrollWidth;
			const outerCell = host.querySelector<HTMLTableCellElement>("tr:first-child td:last-child")!;

			activateHandle(outerCell, direction);

			expect(wrapper.scrollWidth).toBe(before);
		},
	);

	it("distinguishes the active drag indicator from hover", () => {
		const { host } = createEditor("ltr");
		const { handle, inlineEnd } = activateHandle(
			host.querySelector<HTMLTableCellElement>("td")!,
			"ltr",
		);
		const hoverColor = getComputedStyle(handle, "::after").backgroundColor;

		mouse(handle, "mousedown", inlineEnd);

		const dragColor = getComputedStyle(handle, "::after").backgroundColor;
		expect(dragColor).not.toBe(hoverColor);
		mouse(window, "mouseup", inlineEnd);
	});

	it("removes every drag listener when the editor is destroyed", () => {
		const removeEventListener = vi.spyOn(window, "removeEventListener");
		const { editor, host } = createEditor("ltr");
		const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
		const { handle, inlineEnd } = activateHandle(firstCell, "ltr");
		mouse(handle, "mousedown", inlineEnd);

		editor.destroy();

		const removedTypes = removeEventListener.mock.calls.map(([type]) => type);
		expect(removedTypes).toEqual(
			expect.arrayContaining(["mousemove", "mouseup", "blur", "pointercancel"]),
		);
		removeEventListener.mockRestore();
	});

	it("does not create a document transaction for a zero-distance drag", () => {
		const { editor, host } = createEditor("ltr");
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction }) => {
			if (transaction.docChanged) documentTransactions++;
		});

		resizeColumn(host.querySelector<HTMLTableCellElement>("td")!, "ltr", 0);

		expect(documentTransactions).toBe(0);
		expect(tableColumnWidths(editor, 0)).toEqual([128, 128]);
	});

	it("restores automatic column styles after a zero-distance drag", () => {
		const { editor, host } = createEditor("ltr", { content: tableContent(null) });
		const table = host.querySelector<HTMLTableElement>("table")!;
		const columns = Array.from(table.querySelectorAll("col"), (col) => col.style.width);
		const minimum = table.style.minWidth;

		resizeColumn(host.querySelector<HTMLTableCellElement>("td")!, "ltr", 0);

		expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).toEqual(columns);
		expect(table.style.minWidth).toBe(minimum);
		expect(tableColumnWidths(editor, 0)).toEqual([0, 0]);
	});

	it("restores automatic column styles when a drag is cancelled", () => {
		const { editor, host } = createEditor("ltr", { content: tableContent(null) });
		const table = host.querySelector<HTMLTableElement>("table")!;
		const columns = Array.from(table.querySelectorAll("col"), (col) => col.style.width);
		const minimum = table.style.minWidth;
		const { handle, inlineEnd } = activateHandle(
			host.querySelector<HTMLTableCellElement>("td")!,
			"ltr",
		);
		mouse(handle, "mousedown", inlineEnd);
		mouse(window, "mousemove", inlineEnd + 32);

		window.dispatchEvent(new Event("blur"));

		expect(Array.from(table.querySelectorAll("col"), (col) => col.style.width)).toEqual(columns);
		expect(table.style.minWidth).toBe(minimum);
		expect(tableColumnWidths(editor, 0)).toEqual([0, 0]);
	});

	it.each([
		[96, -32],
		[4096, 32],
	] as const)("does not persist a width already clamped at %s", (width, delta) => {
		const { editor, host } = createEditor("ltr", { content: tableContent([width, 160]) });
		let documentTransactions = 0;
		editor.on("transaction", ({ transaction }) => {
			if (transaction.docChanged) documentTransactions++;
		});

		resizeColumn(host.querySelector<HTMLTableCellElement>("td")!, "ltr", delta);

		expect(documentTransactions).toBe(0);
		expect(tableColumnWidths(editor, 0)).toEqual([width, width]);
	});

	it.each(["ltr", "rtl"] as const)(
		"starts a first %s resize from the rendered automatic width",
		(direction) => {
			const { editor, host } = createEditor(direction, { content: tableContent(null) });
			const firstCell = host.querySelector<HTMLTableCellElement>("td")!;
			const renderedWidth = firstCell.offsetWidth;
			expect(renderedWidth).toBeGreaterThan(TABLE_CELL_MIN_WIDTH);

			resizeColumn(firstCell, direction, 1);

			expect(tableColumnWidths(editor, 0)).toEqual([
				Math.round(renderedWidth + 1),
				Math.round(renderedWidth + 1),
			]);
		},
	);

	it("reveals only focused active-cell changes after mount", () => {
		const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
		const { editor, host } = createEditor("ltr");
		let firstText = 0;
		let secondText = 0;
		editor.state.doc.descendants((node, position) => {
			if (node.isText && node.text === "0:0") firstText = position;
			if (node.isText && node.text === "0:1") secondText = position;
		});
		expect(scrollIntoView).not.toHaveBeenCalled();
		editor.commands.setTextSelection(secondText);
		expect(scrollIntoView).not.toHaveBeenCalled();
		editor.commands.setTextSelection(firstText);
		expect(scrollIntoView).not.toHaveBeenCalled();
		editor.view.focus();
		scrollIntoView.mockClear();

		expect(editor.commands.goToNextCell()).toBe(true);

		const secondCell = host.querySelectorAll("tr:first-child td")[1];
		expect(scrollIntoView).toHaveBeenCalledOnce();
		expect(scrollIntoView.mock.instances[0]).toBe(secondCell);
		scrollIntoView.mockRestore();
	});
});
