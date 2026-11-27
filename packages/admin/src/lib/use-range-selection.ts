import * as React from "react";

export interface RangeSelectionOptions {
	/** The ids of the rows on screen, in display order. */
	ids: readonly string[];
	selected: ReadonlySet<string>;
	/** Receives the next selection and the ids whose state changed. */
	onChange: (next: Set<string>, changed: string[]) => void;
}

/**
 * Checkbox selection where Shift extends from the last toggled row. Returns a handler for a row
 * checkbox's `onCheckedChange`: with Shift held, the row's new state applies to every row on
 * screen between the last toggled row and this one. The last toggled row stops counting once the
 * rows on screen change, as they do on a page, sort or filter change.
 */
export function useRangeSelection({ ids, selected, onChange }: RangeSelectionOptions) {
	const order = JSON.stringify(ids);
	const [anchor, setAnchor] = React.useState<{ id: string; order: string } | null>(null);
	if (anchor && anchor.order !== order) setAnchor(null);

	return (id: string, checked: boolean, event: Event | undefined) => {
		const to = ids.indexOf(id);
		const from = anchor && isShiftEvent(event) ? ids.indexOf(anchor.id) : -1;
		const range =
			from === -1 || to === -1 ? [id] : ids.slice(Math.min(from, to), Math.max(from, to) + 1);
		const next = new Set(selected);
		const changed: string[] = [];
		for (const rowId of range) {
			if (next.has(rowId) === checked) continue;
			if (checked) next.add(rowId);
			else next.delete(rowId);
			changed.push(rowId);
		}
		setAnchor({ id, order });
		onChange(next, changed);
	};
}

function isShiftEvent(event: Event | undefined): boolean {
	return !!event && "shiftKey" in event && event.shiftKey === true;
}

/**
 * Spread on the table cell that holds a row checkbox. In Chromium a Shift+click otherwise selects
 * the page text between the two clicks.
 */
export const rangeSelectionCellProps = {
	onMouseDown(event: React.MouseEvent<HTMLElement>) {
		if (!event.shiftKey || !(event.target instanceof Element)) return;
		const checkbox = event.target.closest<HTMLElement>('[role="checkbox"]');
		if (!checkbox) return;
		event.preventDefault();
		checkbox.focus();
	},
};
