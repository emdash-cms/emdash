import { Button, DropdownMenu } from "@cloudflare/kumo";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { DotsSixVertical, DotsThree, Plus } from "@phosphor-icons/react";
import * as React from "react";

import {
	itemTitleField,
	type ListSubField,
	listItemText,
	listPresentation,
} from "../lib/block-field-layout.js";
import { cloneValue, createBlockKey, isBlankLine, pastedLines } from "../lib/block-field-state.js";
import { useStableCallback } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import {
	focusableIn,
	MOVE_KEYS,
	SELECTABLE_INPUT_TYPES,
	TEXT_INPUT_TYPES,
	textOffsetAt,
	useMoveKeys,
	whenFocusLeaves,
} from "./block-field-keyboard.js";
import {
	collapseRow,
	DisclosureCaret,
	DisclosurePanel,
	growRow,
	prefersReducedMotion,
	type RowCollapse,
	useDropSettle,
	useReorderMotion,
} from "./block-field-motion.js";
import {
	DRAGGING,
	GLYPH_NUDGE,
	HEAD_FOCUS,
	HEAD_PRESSED,
	IMAGE_EDGE,
	ITEM_TITLE,
	LABEL,
	LIFT_SHADOW,
	LIFTED,
	MENU_TOUCH,
	NOTE,
	POPUP_MOTION,
	ROW_BUTTON,
	ROW_HOVER,
	ROW_SUMMARY,
	ROW_TOUCH_TARGET,
	SORT_TRANSITION,
	SUMMARY_SLOT,
	SUMMARY_TEXT,
} from "./block-field-styles.js";
import { type ImageFieldValue, mediaDisplayUrl } from "./ImageFieldRenderer.js";
import { RowMenuItems } from "./RowMenuItems.js";
import { useDragAnnouncements } from "./useDragAnnouncements.js";
import { useQuietReturnFocus } from "./useQuietReturnFocus.js";

type ListItem = Record<string, unknown>;

interface Row {
	/** Editor-only identity for drag, focus and open state. Never saved. */
	key: string;
	item: ListItem;
}

/** A deletion whose row is still shrinking away, which Undo can call off until it has happened. */
export interface DeletionHold {
	/** Ends the hold, once the deletion has happened or been called off. */
	release: () => void;
}

export interface DeletedListItem {
	item: ListItem;
	/** Where the item sat in the saved list. */
	index: number;
	name: string;
	/** The hold `onItemDeleteStart` gave the deletion while its row shrank away. */
	hold?: DeletionHold;
}

export interface ListControlInput {
	subField: ListSubField;
	/** The item's segment in control names: its index in the saved list, or a key for a blank line. */
	at: string;
	value: unknown;
	onChange: (value: unknown) => void;
	labelledBy: string;
	placeholder?: string;
	/**
	 * A table cell, where a photo draws as a thumbnail and there is no room under the control
	 * for an error.
	 */
	cell?: boolean;
}

export interface ListItemFieldsInput {
	at: string;
	item: ListItem;
	subFields: readonly ListSubField[];
	onChange: (slug: string, value: unknown) => void;
}

export interface BlockListFieldProps {
	/** Id for the element that names the list. */
	labelId: string;
	label: string;
	value: unknown;
	onChange: (items: ListItem[]) => void;
	subFields: readonly ListSubField[];
	minItems?: number;
	maxItems?: number;
	readOnly: boolean;
	/** A problem with the list's size, shown after its label. */
	error?: string;
	/** Indexes, in the saved list, of the items that hold a problem to show. */
	invalidItems: ReadonlySet<number>;
	/** A new token opens the items in `invalidItems`. */
	revealToken: number;
	onItemDeleted: (deleted: DeletedListItem) => void;
	/**
	 * Called as an item's row starts shrinking away before it's deleted, with the function that
	 * calls the deletion off.
	 */
	onItemDeleteStart?: (cancel: () => void) => DeletionHold | undefined;
	/**
	 * Called when saved items change position, with each item's new position by its old one,
	 * or -1 for an item removed.
	 */
	onItemsShift: (moves: readonly number[]) => void;
	renderControl: (input: ListControlInput) => React.ReactNode;
	renderItemFields: (input: ListItemFieldsInput) => React.ReactNode;
}

/** Where focus goes next. With `scroll: false`, the row's own motion brings it into view. */
type ListFocus =
	| { key: string; target: "control"; caret?: number; scroll?: false }
	| { key: string; target: "item"; scroll?: false }
	| { key: string; target: "cell"; column: number }
	| { target: "add" };

const LINE_BREAK = /[\r\n]/;
const IMAGE_COLUMN = "4.5rem";
const MENU_COLUMN = "2rem";
// Touch and narrow screens have no hover, so their menus always show. Focus from a click doesn't
// show them; the state being entered sets the duration, so they fade in and vanish at once.
const SHOW_ON_HOVER =
	"blocks-gutter:opacity-0 blocks-gutter:transition-opacity blocks-gutter:duration-0 blocks-gutter:ease-emdash blocks-gutter:group-hover/item:opacity-100 blocks-gutter:group-hover/item:duration-100 blocks-gutter:group-data-[menu-open]/item:opacity-100 blocks-gutter:group-data-[menu-open]/item:duration-100 blocks-gutter:[&:not([data-quiet-focus]):focus-visible]:opacity-100 blocks-gutter:[&:not([data-quiet-focus]):focus-visible]:duration-100";
// A closed item's head keeps its wash while its menu is open.
const HEAD_MENU_OPEN =
	"group-data-[menu-open]/item:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]";

/** How many items a list holds, in words. */
function itemCount(count: number): string {
	return plural(count, { one: "# item", other: "# items" });
}

export function ErrorDot({ id }: { id?: string }) {
	const { t } = useLingui();
	return (
		<span
			id={id}
			role="img"
			aria-label={t`Has fields to fix`}
			data-error-dot=""
			className="size-1.5 shrink-0 rounded-full bg-kumo-danger"
		/>
	);
}

function isRecord(value: unknown): value is ListItem {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameItems(a: readonly ListItem[], b: readonly ListItem[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Rows for `items`, which replace the `saved` rows: an item keeps the key it had, even after
 * a move or an Undo, and an item replaced in place takes over the key at its position.
 */
function syncRows(
	saved: readonly Row[],
	items: readonly ListItem[],
	known: WeakMap<ListItem, string>,
): Row[] {
	const incoming = new Set(items);
	return items.map((item, index) => {
		const atPosition = saved[index];
		const replaced = atPosition && !incoming.has(atPosition.item) ? atPosition.key : undefined;
		const key = known.get(item) ?? replaced ?? createBlockKey();
		known.set(item, key);
		return { key, item };
	});
}

function isImageValue(value: unknown): value is ImageFieldValue {
	return isRecord(value) && typeof value.id === "string";
}

/** The preview of the first photo set among `fields`, for a closed block or list item. */
export function firstPhotoUrl(
	values: Record<string, unknown>,
	fields: readonly { slug: string; type: string }[],
): string | undefined {
	for (const field of fields) {
		if (field.type !== "image") continue;
		const value = values[field.slug];
		const url =
			typeof value === "string" || isImageValue(value) ? mediaDisplayUrl(value) : undefined;
		if (url) return url;
	}
	return undefined;
}

export function toggled(keys: ReadonlySet<string>, key: string): ReadonlySet<string> {
	const next = new Set(keys);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/**
 * A list (`repeater` field) inside an open block: a type-in list of lines, a table, or
 * expandable items, depending on its sub-fields.
 */
export function BlockListField({
	labelId,
	label,
	value,
	onChange,
	subFields,
	minItems = 0,
	maxItems = Infinity,
	readOnly,
	error,
	invalidItems,
	revealToken,
	onItemDeleted,
	onItemDeleteStart,
	onItemsShift,
	renderControl,
	renderItemFields,
}: BlockListFieldProps) {
	const { t, i18n } = useLingui();
	const presentation = listPresentation(subFields);
	const lineField = presentation === "lines" ? subFields[0] : undefined;
	const titleField = itemTitleField(subFields);
	const items = React.useMemo(
		() => (Array.isArray(value) ? value.map((item) => (isRecord(item) ? item : {})) : []),
		[value],
	);
	const knownKeys = React.useRef(new WeakMap<ListItem, string>()).current;
	/** Items deleted here with an Undo, which grow back in when it puts them back. */
	const deletedItems = React.useRef(new WeakSet<ListItem>()).current;
	/** Table rows Enter added, which stay out of the saved list while all their cells are blank. */
	const enteredRows = React.useRef(new Set<string>()).current;
	/** Blank lines and table rows shrinking away now that focus has left them. */
	const shrinkingBlankRows = React.useRef(new Map<string, RowCollapse>()).current;
	const [rows, setRows] = React.useState<Row[]>(() => syncRows([], items, knownKeys));
	const [source, setSource] = React.useState(value);
	const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
	const [seenReveal, setSeenReveal] = React.useState(0);
	const [announcement, setAnnouncement] = React.useState("");
	/** The row just added, duplicated or put back by Undo, which grows into place. */
	const [arrived, setArrived] = React.useState<{ key: string; restored?: true } | null>(null);
	const rootRef = React.useRef<HTMLDivElement>(null);
	const addRef = React.useRef<HTMLButtonElement>(null);
	const focusRef = React.useRef<ListFocus | null>(null);
	const reorder = useReorderMotion(rootRef, "data-item-key");
	const errorId = React.useId();
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

	let current = rows;
	if (value !== source) {
		const wasSaved = new Set(Array.isArray(source) ? source : []);
		current = syncRows(
			rows.filter((row) => wasSaved.has(row.item)),
			items,
			knownKeys,
		);
		const shownKeys = new Set(rows.map((row) => row.key));
		const restored = current.find((row) => deletedItems.has(row.item) && !shownKeys.has(row.key));
		if (restored) setArrived({ key: restored.key, restored: true });
		setSource(value);
		setRows(current);
	}
	const savedIndex = new Map(items.map((item, index) => [item, index]));
	const blankCells = (row: Row) =>
		subFields.every((subField) => isBlankLine(row.item[subField.slug]));
	// Only a line or a row Enter added that isn't in the saved list is blank, so an empty item
	// already saved stays.
	const isBlank = (row: Row) => {
		if (savedIndex.has(row.item)) return false;
		if (lineField) return isBlankLine(row.item[lineField.slug]);
		return enteredRows.has(row.key) && blankCells(row);
	};
	// Problems and reveals point into the saved list, where a line typed but not yet saved has no place.
	const positions = current.map((row) => savedIndex.get(row.item));
	const at = (index: number) => {
		const position = positions[index];
		return position === undefined ? `new-${current[index]?.key}` : String(position);
	};

	if (revealToken !== seenReveal) {
		setSeenReveal(revealToken);
		const revealedKeys = current
			.filter((row, index) => {
				const position = positions[index];
				return position !== undefined && invalidItems.has(position) && !openKeys.has(row.key);
			})
			.map((row) => row.key);
		if (presentation === "items" && revealedKeys.length > 0) {
			setOpenKeys(new Set([...openKeys, ...revealedKeys]));
		}
	}

	const atMax = current.length >= maxItems;
	const savedCount = current.filter((row) => !isBlank(row)).length;
	const canDelete = (row: Row) => isBlank(row) || savedCount > minItems;
	const describedBy = error ? errorId : undefined;

	const emit = (next: Row[]) => {
		const kept = next.filter((row) => !isBlank(row));
		const nextItems = kept.map((row) => row.item);
		for (const row of next) knownKeys.set(row.item, row.key);
		setRows(next);
		if (sameItems(nextItems, items)) return;
		setSource(nextItems);
		onChange(nextItems);
		const keptKeys = kept.map((row) => row.key);
		const moves = current.filter((row) => !isBlank(row)).map((row) => keptKeys.indexOf(row.key));
		if (moves.some((to, from) => to !== from)) onItemsShift(moves);
	};

	const focusRow = (request: ListFocus) => {
		if (request.target === "add") {
			addRef.current?.focus();
			return;
		}
		const row = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-item-key]") ?? [])].find(
			(element) => element.dataset.itemKey === request.key,
		);
		if (!row) return;
		const target =
			request.target === "cell"
				? row.querySelectorAll('[role="cell"]')[request.column]
				: row.querySelector(
						request.target === "item" ? "[data-item-focus]" : "[data-item-control]",
					);
		const element = focusableIn(target) ?? focusableIn(row);
		element?.focus(
			request.target !== "cell" && request.scroll === false ? { preventScroll: true } : undefined,
		);
		if (
			request.target !== "item" &&
			element instanceof HTMLInputElement &&
			SELECTABLE_INPUT_TYPES.has(element.type)
		) {
			const caret =
				(request.target === "control" ? request.caret : undefined) ?? element.value.length;
			element.setSelectionRange(caret, caret);
		}
	};

	React.useEffect(() => {
		const request = focusRef.current;
		if (!request) return;
		focusRef.current = null;
		focusRow(request);
	});

	const name = (row: Row, index: number) => {
		const { title } = listItemText(row.item, subFields);
		return title || (titleField ? t`Untitled` : t`Item ${index + 1}`);
	};

	const newItem = (): ListItem =>
		Object.fromEntries(
			subFields
				.filter((subField) => subField.type === "boolean")
				.map((subField) => [subField.slug, false]),
		);

	const updateRow = (key: string, slug: string, next: unknown) => {
		emit(
			current.map((row) => (row.key === key ? { key, item: { ...row.item, [slug]: next } } : row)),
		);
	};

	const insertRow = (index: number, row: Row) => {
		emit([...current.slice(0, index), row, ...current.slice(index)]);
	};

	const addRowAt = (index: number) => {
		if (atMax) return;
		const row = { key: createBlockKey(), item: newItem() };
		insertRow(index, row);
		if (presentation === "items") setOpenKeys(new Set(openKeys).add(row.key));
		setArrived({ key: row.key });
		focusRef.current = { key: row.key, target: "control", scroll: false };
	};
	const addRow = () => addRowAt(current.length);
	// Runs once the menu it was chosen in has closed.
	const addRowLater = useStableCallback(addRowAt);

	const moveRow = (from: number, to: number, slide = false) => {
		const row = current[from];
		if (!row || to < 0 || to >= current.length) return;
		if (slide) reorder(row.key);
		emit(arrayMove(current, from, to));
		const moved = name(row, from);
		const position = to + 1;
		const total = current.length;
		setAnnouncement(t`Moved ${moved} to position ${position} of ${total}`);
	};

	const duplicateRow = (index: number) => {
		const row = current[index];
		if (!row || atMax) return;
		const copy = { key: createBlockKey(), item: cloneValue(row.item) };
		insertRow(index + 1, copy);
		if (openKeys.has(row.key)) setOpenKeys(new Set(openKeys).add(copy.key));
		setArrived({ key: copy.key });
		focusRef.current = { key: copy.key, target: "item", scroll: false };
		const copied = name(row, index);
		setAnnouncement(t`Duplicated ${copied}`);
	};

	const deleteRow = (key: string, hold?: DeletionHold, placeFocus = true) => {
		const index = current.findIndex((row) => row.key === key);
		const row = current[index];
		if (readOnly || !row || !canDelete(row)) return;
		const next = current.filter((candidate) => candidate.key !== key);
		const neighbour = next[index] ?? next[index - 1];
		if (placeFocus) {
			focusRef.current = neighbour ? { key: neighbour.key, target: "item" } : { target: "add" };
		}
		emit(next);
		const position = positions[index];
		if (position === undefined) return;
		deletedItems.add(row.item);
		onItemDeleted({ item: row.item, index: position, name: name(row, index), hold });
	};

	const rowElement = (key: string) =>
		[...(rootRef.current?.querySelectorAll<HTMLElement>("[data-item-key]") ?? [])].find(
			(candidate) => candidate.dataset.itemKey === key,
		);

	const deleteLater = useStableCallback(deleteRow);
	// A row deleted from its menu shrinks away first, and until it has, Undo calls the deletion off.
	const collapseAndDelete = (key: string) => {
		const row = current.find((candidate) => candidate.key === key);
		if (!row || !canDelete(row)) return;
		const element = rowElement(key);
		if (!element) {
			deleteRow(key);
			return;
		}
		let hold: DeletionHold | undefined;
		const collapse = collapseRow(
			element,
			(placeFocus) => deleteLater(key, hold, placeFocus),
			() => hold?.release(),
		);
		if (collapse) {
			hold = onItemDeleteStart?.(() => {
				collapse.reverse();
				focusRow({ key, target: "item", scroll: false });
			});
		}
	};

	const dropBlankRows = useStableCallback((keys: ReadonlySet<string>) => {
		const kept = current.filter((row) => !keys.has(row.key) || !isBlank(row));
		if (kept.length !== current.length) emit(kept);
	});
	// Blank rows shrink away, and come back if focus returns before they have gone. Those that
	// can't shrink go together, as one change.
	const shrinkBlankRows = (keys: readonly string[]) => {
		const atOnce = new Set<string>();
		let starting = true;
		for (const key of keys) {
			if (shrinkingBlankRows.has(key)) continue;
			const element = rowElement(key);
			if (!element) {
				atOnce.add(key);
				continue;
			}
			const collapse = collapseRow(
				element,
				() => {
					shrinkingBlankRows.delete(key);
					if (starting) atOnce.add(key);
					else dropBlankRows(new Set([key]));
				},
				// A row the value left out while it shrank isn't removed by the shrink.
				() => {
					if (shrinkingBlankRows.get(key) === collapse) shrinkingBlankRows.delete(key);
				},
			);
			if (collapse) shrinkingBlankRows.set(key, collapse);
		}
		starting = false;
		if (atOnce.size > 0) dropBlankRows(atOnce);
	};
	const keepBlankRows = (keys: Iterable<string>) => {
		for (const key of keys) {
			shrinkingBlankRows.get(key)?.reverse();
			shrinkingBlankRows.delete(key);
		}
	};

	const removeBlankLines = useStableCallback(() => {
		const root = rootRef.current;
		if (!root || root.contains(document.activeElement)) return;
		shrinkBlankRows(current.filter(isBlank).map((row) => row.key));
	});

	// A table row Enter added goes once focus leaves it with every cell still blank.
	const removeBlankRow = useStableCallback((key: string) => {
		if (!rootRef.current) return;
		const row = current.find((candidate) => candidate.key === key);
		if (row && isBlank(row)) shrinkBlankRows([key]);
	});

	const lineKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
		const input = event.target;
		const row = current[index];
		if (!(input instanceof HTMLInputElement) || !row) return;
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key === "Enter") {
			event.preventDefault();
			if (atMax) return;
			const added = { key: createBlockKey(), item: {} };
			insertRow(index + 1, added);
			focusRef.current = { key: added.key, target: "control" };
			return;
		}
		if (event.key === "Backspace") {
			const above = current[index - 1];
			if (!above || input.value !== "") return;
			event.preventDefault();
			if (positions[index] === undefined) {
				emit(current.filter((candidate) => candidate.key !== row.key));
			} else {
				if (!canDelete(row)) return;
				deleteRow(row.key);
			}
			focusRef.current = { key: above.key, target: "control" };
			return;
		}
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			const target = current[index + (event.key === "ArrowUp" ? -1 : 1)];
			if (!target) return;
			event.preventDefault();
			focusRow({ key: target.key, target: "control" });
		}
	};

	// Enter goes down a table's column, adding a row under the last unless that one is blank, and
	// the arrow keys go up and down it, except in a number, whose arrow keys step its value.
	// Backspace in the empty first cell of a blank row deletes the row, as it does an empty line.
	const cellKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number, column: number) => {
		const input = event.target;
		const row = current[index];
		if (!(input instanceof HTMLInputElement) || !TEXT_INPUT_TYPES.has(input.type) || !row) return;
		if (event.nativeEvent.isComposing || event.keyCode === 229) return;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key === "Backspace") {
			const above = current[index - 1];
			// A number's half-typed text, such as "-", reads as an empty value.
			const empty = input.value === "" && !input.validity.badInput;
			if (column !== 0 || !above || !empty || !blankCells(row)) return;
			if (positions[index] !== undefined && !canDelete(row)) return;
			event.preventDefault();
			if (positions[index] === undefined) emit(current.filter((candidate) => candidate !== row));
			else deleteRow(row.key);
			focusRef.current = { key: above.key, target: "cell", column };
			return;
		}
		const enter = event.key === "Enter";
		if (!enter && (input.type === "number" || !["ArrowUp", "ArrowDown"].includes(event.key))) {
			return;
		}
		const target = current[index + (event.key === "ArrowUp" ? -1 : 1)];
		if (target) {
			event.preventDefault();
			focusRow({ key: target.key, target: "cell", column });
			return;
		}
		if (!enter) return;
		event.preventDefault();
		if (atMax || isBlank(row)) return;
		const added = { key: createBlockKey(), item: newItem() };
		enteredRows.add(added.key);
		insertRow(index + 1, added);
		focusRef.current = { key: added.key, target: "cell", column };
	};

	const linePaste = (event: React.ClipboardEvent<HTMLElement>, index: number) => {
		const input = event.target;
		const row = current[index];
		if (!(input instanceof HTMLInputElement) || !row || !lineField) return;
		const text = event.clipboardData.getData("text/plain");
		if (!LINE_BREAK.test(text)) return;
		event.preventDefault();
		const [first, ...rest] = pastedLines(text);
		if (first === undefined) return;
		const before = input.value.slice(0, input.selectionStart ?? input.value.length);
		const after = input.value.slice(input.selectionEnd ?? input.value.length);
		const lines = [before + first, ...rest.slice(0, Math.max(0, maxItems - current.length))];
		const caret = (lines.at(-1) ?? "").length;
		const pasted = lines.map((line, offset) => {
			const textValue = offset === lines.length - 1 ? line + after : line;
			return offset === 0
				? { key: row.key, item: { ...row.item, [lineField.slug]: textValue } }
				: { key: createBlockKey(), item: { [lineField.slug]: textValue } };
		});
		emit([...current.slice(0, index), ...pasted, ...current.slice(index + 1)]);
		const last = pasted.at(-1);
		if (last) focusRef.current = { key: last.key, target: "control", caret };
	};

	const keys = current.map((row) => row.key);
	const drag = useDragAnnouncements({
		keys,
		nameOf: (key) => {
			const index = keys.indexOf(key);
			const row = current[index];
			return row ? name(row, index) : "";
		},
		announce: setAnnouncement,
		onMove: (from, to) => emit(arrayMove(current, from, to)),
	});

	const rowProps = (row: Row, index: number): SortableRowProps => ({
		row,
		index,
		count: current.length,
		name: name(row, index),
		readOnly,
		canDelete: canDelete(row),
		added: arrived?.key === row.key ? (arrived.restored ? "restored" : "new") : undefined,
		onMove: (to, slide) => moveRow(index, to, slide),
		onEdge: (edge) => {
			const moved = name(row, index);
			setAnnouncement(
				edge === "first" ? t`${moved} is already first` : t`${moved} is already last`,
			);
		},
		onDelete: () => collapseAndDelete(row.key),
	});

	const control = (
		row: Row,
		index: number,
		subField: ListSubField,
		input: Pick<ListControlInput, "labelledBy" | "placeholder" | "cell">,
	) =>
		renderControl({
			subField,
			at: at(index),
			value: row.item[subField.slug],
			onChange: (next) => updateRow(row.key, subField.slug, next),
			...input,
		});

	let body: React.ReactNode = null;
	if (presentation === "lines" && lineField) {
		body = (
			<ul
				role="list"
				aria-labelledby={labelId}
				aria-describedby={describedBy}
				className="grid grid-cols-[minmax(0,1fr)]"
			>
				{current.map((row, index) => (
					<LineRow key={row.key} {...rowProps(row, index)} lineLabel={lineField.label}>
						{(labelledBy) => (
							<div
								data-item-control
								data-item-focus
								className="min-w-0 flex-1"
								onKeyDown={readOnly ? undefined : (event) => lineKeyDown(event, index)}
								onPaste={readOnly ? undefined : (event) => linePaste(event, index)}
							>
								{control(row, index, lineField, { labelledBy })}
							</div>
						)}
					</LineRow>
				))}
			</ul>
		);
	} else if (presentation === "table") {
		const textColumns = subFields.filter((subField) => subField.type !== "image").length;
		const columns = [
			...subFields.map((subField, column) => {
				if (subField.type === "image") return IMAGE_COLUMN;
				return textColumns === 2 && column === subFields.findLastIndex((f) => f.type !== "image")
					? "minmax(0,3fr)"
					: "minmax(0,1fr)";
			}),
			...(readOnly ? [] : [MENU_COLUMN]),
		].join(" ");
		body = (
			<div role="table" aria-labelledby={labelId} aria-describedby={describedBy}>
				<div role="row" className="grid" style={{ gridTemplateColumns: columns }}>
					{subFields.map((subField) => (
						<span
							key={subField.slug}
							role="columnheader"
							className={cn(
								"min-w-0 px-2 pt-1.5 pb-1 text-xs leading-4 text-kumo-subtle wrap-anywhere",
								subField.type === "image" && "text-center",
							)}
						>
							{subField.label}
						</span>
					))}
					{!readOnly && (
						<span role="columnheader">
							<span className="sr-only">{t`Actions`}</span>
						</span>
					)}
				</div>
				{current.map((row, index) => (
					<TableRow
						key={row.key}
						{...rowProps(row, index)}
						columns={columns}
						onFocus={
							readOnly || !enteredRows.has(row.key) ? undefined : () => keepBlankRows([row.key])
						}
						onBlur={
							readOnly || !enteredRows.has(row.key)
								? undefined
								: (event) =>
										whenFocusLeaves(event, () => queueMicrotask(() => removeBlankRow(row.key)))
						}
					>
						{subFields.map((subField, column) => (
							<LabelledCell
								key={subField.slug}
								label={subField.label}
								position={index + 1}
								first={column === 0}
								onKeyDown={readOnly ? undefined : (event) => cellKeyDown(event, index, column)}
							>
								{(labelledBy) => control(row, index, subField, { labelledBy, cell: true })}
							</LabelledCell>
						))}
					</TableRow>
				))}
			</div>
		);
	} else {
		const editableTitle = titleField?.type === "string" ? titleField : undefined;
		const bodyFields = editableTitle
			? subFields.filter((subField) => subField !== editableTitle)
			: subFields;
		body = (
			<div
				role="list"
				aria-labelledby={labelId}
				aria-describedby={describedBy}
				className="grid grid-cols-[minmax(0,1fr)] gap-0.5"
			>
				{current.map((row, index) => {
					const position = positions[index];
					return (
						<ItemRow
							key={row.key}
							{...rowProps(row, index)}
							open={readOnly || openKeys.has(row.key)}
							text={listItemText(row.item, subFields)}
							thumbnail={firstPhotoUrl(row.item, subFields)}
							invalid={position !== undefined && invalidItems.has(position)}
							duplicate={{ disabled: atMax, onSelect: () => duplicateRow(index) }}
							add={{
								disabled: atMax,
								onSelect: (side) => addRowLater(side === "above" ? index : index + 1),
							}}
							onToggle={(titleCaret) => {
								setOpenKeys(toggled(openKeys, row.key));
								if (titleCaret) {
									focusRef.current = { key: row.key, target: "control", caret: titleCaret.at };
								}
							}}
							title={
								editableTitle &&
								((labelledBy) =>
									control(row, index, editableTitle, {
										labelledBy,
										placeholder: editableTitle.label,
									}))
							}
							titleLabel={editableTitle?.label}
						>
							{renderItemFields({
								at: at(index),
								item: row.item,
								subFields: bodyFields,
								onChange: (slug, next) => updateRow(row.key, slug, next),
							})}
						</ItemRow>
					);
				})}
			</div>
		);
	}

	return (
		<div
			ref={rootRef}
			className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
			onFocus={lineField && !readOnly ? () => keepBlankRows(shrinkingBlankRows.keys()) : undefined}
			onBlur={
				lineField && !readOnly
					? (event) => {
							whenFocusLeaves(event, () => queueMicrotask(removeBlankLines));
						}
					: undefined
			}
		>
			<div className="flex min-w-0 items-baseline gap-1.5 ps-2 pb-1">
				<span id={labelId} className={cn(LABEL, "wrap-anywhere")}>
					{label}
				</span>
				{savedCount > 0 && (
					<>
						<bdi aria-hidden="true" className={cn(NOTE, "text-kumo-subtle tabular-nums")}>
							{i18n.number(savedCount)}
						</bdi>
						<span className="sr-only">{itemCount(savedCount)}</span>
					</>
				)}
				{/* On the label's line, so showing it moves nothing. */}
				{error && (
					<>
						<span aria-hidden="true" className={cn(NOTE, "text-kumo-placeholder")}>
							·
						</span>
						<span id={errorId} className={cn(NOTE, "min-w-0 wrap-anywhere text-kumo-danger")}>
							{error}
						</span>
					</>
				)}
			</div>
			{current.length > 0 ? (
				<DndContext sensors={sensors} collisionDetection={closestCenter} {...drag}>
					<SortableContext items={keys} strategy={verticalListSortingStrategy}>
						{body}
					</SortableContext>
				</DndContext>
			) : (
				readOnly && <p className="ps-2 text-base text-kumo-subtle">{t`No items yet`}</p>
			)}
			{!readOnly && !atMax && (
				<Button
					ref={addRef}
					variant="ghost"
					icon={<Plus className="size-4" aria-hidden="true" />}
					className={cn(
						ROW_BUTTON,
						"h-8 w-full justify-start gap-2 px-2 font-normal text-kumo-subtle shadow-none hover:text-kumo-default pointer-coarse:h-11",
						presentation === "items" && current.length > 0 && "mt-0.5",
					)}
					aria-label={t`Add item to ${label}`}
					onClick={addRow}
				>
					{t`Add item`}
				</Button>
			)}
			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>
		</div>
	);
}

interface SortableRowProps {
	row: Row;
	index: number;
	count: number;
	name: string;
	readOnly: boolean;
	canDelete: boolean;
	/**
	 * The row was just added or duplicated, and grows into place and into view, or put back by
	 * Undo, and grows in where it was.
	 */
	added?: "new" | "restored";
	/** Moves the row; `slide` slides it and the rows it passes into their places. */
	onMove: (to: number, slide?: boolean) => void;
	/** Called when the move keys would take the row past either end. */
	onEdge: (edge: "first" | "last") => void;
	onDelete: () => void;
}

function useSortableRow(key: string, readOnly: boolean, added: SortableRowProps["added"]) {
	const { listeners, setNodeRef, node, transform, transition, isDragging } = useSortable({
		id: key,
		disabled: readOnly,
		transition: prefersReducedMotion() ? null : SORT_TRANSITION,
	});
	const drop = useDropSettle(key, isDragging, setNodeRef);
	const [menuOpen, setMenuOpen] = React.useState(false);
	React.useLayoutEffect(() => {
		if (added && node.current) growRow(node.current, { reveal: added === "new" });
	}, [added, node]);
	return {
		listeners,
		setNodeRef: drop.setNodeRef,
		className: cn(
			!readOnly && LIFT_SHADOW,
			(isDragging || drop.settling) && DRAGGING,
			isDragging && LIFTED,
		),
		menuOpen,
		setMenuOpen,
		style: { transform: CSS.Translate.toString(transform), transition },
	};
}

function DragHandle({
	listeners,
	className,
}: {
	listeners: ReturnType<typeof useSortable>["listeners"];
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			{...listeners}
			className={cn(
				"absolute end-full me-0.5 hidden h-6 w-[1.125rem] cursor-grab touch-none place-items-center rounded-md text-kumo-subtle opacity-0 transition-opacity duration-0 ease-emdash hover:bg-emdash-hover active:cursor-grabbing blocks-gutter:@min-[440px]/blocks:grid group-hover/item:opacity-100 group-hover/item:duration-100 group-data-[menu-open]/item:opacity-100 group-data-[menu-open]/item:duration-100",
				className,
			)}
		>
			<DotsSixVertical className="size-4" weight="bold" />
		</span>
	);
}

interface RowMenuProps {
	name: string;
	index: number;
	count: number;
	canDelete: boolean;
	/** Adds an item above or below this one. */
	add?: { disabled: boolean; onSelect: (side: "above" | "below") => void };
	duplicate?: { disabled: boolean; onSelect: () => void };
	onMove: (to: number, slide?: boolean) => void;
	onEdge: (edge: "first" | "last") => void;
	onDelete: () => void;
	onOpenChange: (open: boolean) => void;
	className?: string;
}

function RowMenu({
	name,
	index,
	count,
	canDelete,
	add,
	duplicate,
	onMove,
	onEdge,
	onDelete,
	onOpenChange,
	className,
}: RowMenuProps) {
	const { t } = useLingui();
	// Adding, Duplicate and Delete run once the menu has closed. Adding and Duplicate then focus
	// the new row, so the menu doesn't hand focus back to its button.
	const afterCloseRef = React.useRef<(() => void) | null>(null);
	const keepFocusRef = React.useRef(false);
	const moveKeys = useMoveKeys(index, count, onMove, onEdge);
	const quiet = useQuietReturnFocus();
	const label = name;
	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (open) keepFocusRef.current = false;
				onOpenChange(open);
			}}
			onOpenChangeComplete={(open) => {
				const after = afterCloseRef.current;
				if (open || !after) return;
				afterCloseRef.current = null;
				after();
			}}
		>
			<DropdownMenu.Trigger
				render={
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						className={cn(
							ROW_BUTTON,
							"shrink-0 text-kumo-subtle",
							SHOW_ON_HOVER,
							ROW_TOUCH_TARGET,
							className,
						)}
						aria-label={t`${label} actions`}
						aria-keyshortcuts={MOVE_KEYS}
						{...quiet.groupProps}
						onClick={quiet.markOpener}
						onKeyDown={(event) => {
							quiet.groupProps.onKeyDown(event);
							moveKeys(event);
						}}
					>
						<DotsThree className="size-4" weight="bold" aria-hidden="true" />
					</Button>
				}
			/>
			<DropdownMenu.Portal>
				<DropdownMenu.Positioner align="end">
					<DropdownMenu.Popup
						className={cn("min-w-44", POPUP_MOTION, MENU_TOUCH)}
						finalFocus={() => !keepFocusRef.current}
					>
						<RowMenuItems
							index={index}
							count={count}
							add={
								add && {
									above: t`Add item above`,
									below: t`Add item below`,
									disabled: add.disabled,
									onSelect: (side) => {
										afterCloseRef.current = () => add.onSelect(side);
										keepFocusRef.current = true;
									},
								}
							}
							duplicate={
								duplicate && {
									disabled: duplicate.disabled,
									onSelect: () => {
										afterCloseRef.current = duplicate.onSelect;
										keepFocusRef.current = true;
									},
								}
							}
							deleteDisabled={!canDelete}
							onMove={onMove}
							onDelete={() => {
								afterCloseRef.current = onDelete;
							}}
						/>
					</DropdownMenu.Popup>
				</DropdownMenu.Positioner>
			</DropdownMenu.Portal>
		</DropdownMenu>
	);
}

function LineRow({
	row,
	index,
	count,
	name,
	readOnly,
	canDelete,
	added,
	onMove,
	onEdge,
	onDelete,
	lineLabel,
	children,
}: SortableRowProps & {
	lineLabel: string;
	children: (labelledBy: string) => React.ReactNode;
}) {
	const { t } = useLingui();
	const sortable = useSortableRow(row.key, readOnly, added);
	const labelId = React.useId();
	const label = lineLabel;
	const position = index + 1;
	return (
		<li
			ref={sortable.setNodeRef}
			style={sortable.style}
			data-list-item
			data-item-key={row.key}
			data-menu-open={sortable.menuOpen || undefined}
			className={cn("group/item relative flex min-h-8 items-center pe-0.5", sortable.className)}
		>
			{!readOnly && <DragHandle listeners={sortable.listeners} className="top-1" />}
			<span aria-hidden="true" className="ms-2 grid w-4 shrink-0 place-items-center self-stretch">
				<span className="size-[5px] rounded-full bg-current text-kumo-subtle" />
			</span>
			<span id={labelId} hidden>
				{t`${label} ${position}`}
			</span>
			{children(labelId)}
			{!readOnly && (
				<RowMenu
					name={name}
					index={index}
					count={count}
					canDelete={canDelete}
					onMove={onMove}
					onEdge={onEdge}
					onDelete={onDelete}
					onOpenChange={sortable.setMenuOpen}
				/>
			)}
		</li>
	);
}

function LabelledCell({
	label,
	position,
	first,
	onKeyDown,
	children,
}: {
	label: string;
	position: number;
	first: boolean;
	onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
	children: (labelledBy: string) => React.ReactNode;
}) {
	const { t } = useLingui();
	const labelId = React.useId();
	return (
		<div
			role="cell"
			className="min-w-0 tabular-nums"
			data-item-control={first || undefined}
			data-item-focus={first || undefined}
			onKeyDown={onKeyDown}
		>
			<span id={labelId} hidden>
				{t`${label} ${position}`}
			</span>
			{children(labelId)}
		</div>
	);
}

function TableRow({
	row,
	index,
	count,
	name,
	readOnly,
	canDelete,
	added,
	onMove,
	onEdge,
	onDelete,
	columns,
	onFocus,
	onBlur,
	children,
}: SortableRowProps & {
	columns: string;
	onFocus?: React.FocusEventHandler<HTMLDivElement>;
	onBlur?: React.FocusEventHandler<HTMLDivElement>;
	children: React.ReactNode;
}) {
	const sortable = useSortableRow(row.key, readOnly, added);
	return (
		<div
			ref={sortable.setNodeRef}
			role="row"
			onFocus={onFocus}
			onBlur={onBlur}
			data-list-item
			data-item-key={row.key}
			data-menu-open={sortable.menuOpen || undefined}
			style={{ ...sortable.style, gridTemplateColumns: columns }}
			className={cn(
				"group/item relative grid items-center rounded-md",
				!readOnly &&
					cn(
						ROW_HOVER,
						"data-[menu-open]:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]",
					),
				sortable.className,
			)}
		>
			{children}
			{!readOnly && (
				<div role="cell" className="flex justify-end pe-0.5">
					<DragHandle listeners={sortable.listeners} className="top-1" />
					<RowMenu
						name={name}
						index={index}
						count={count}
						canDelete={canDelete}
						onMove={onMove}
						onEdge={onEdge}
						onDelete={onDelete}
						onOpenChange={sortable.setMenuOpen}
					/>
				</div>
			)}
		</div>
	);
}

interface ItemRowProps extends SortableRowProps {
	open: boolean;
	text: { title: string; summary: string };
	thumbnail?: string;
	invalid: boolean;
	duplicate: { disabled: boolean; onSelect: () => void };
	add: { disabled: boolean; onSelect: (side: "above" | "below") => void };
	/**
	 * Opens or closes the item. A click that opens it passes where to put the caret in the
	 * title: `at` is the offset clicked in the title's text, or undefined for its end.
	 */
	onToggle: (titleCaret?: { at?: number }) => void;
	/** The editable title, drawn in the row while the item is open. */
	title?: (labelledBy: string) => React.ReactNode;
	titleLabel?: string;
	children: React.ReactNode;
}

function ItemRow({
	row,
	index,
	count,
	name,
	readOnly,
	canDelete,
	added,
	onMove,
	onEdge,
	onDelete,
	open,
	text,
	thumbnail,
	invalid,
	duplicate,
	add,
	onToggle,
	title,
	titleLabel,
	children,
}: ItemRowProps) {
	const sortable = useSortableRow(row.key, readOnly, added);
	const moveKeys = useMoveKeys(index, count, onMove, onEdge);
	/** The kind of pointer that pressed the toggle last. */
	const pointerRef = React.useRef("");
	const id = React.useId();
	const nameId = `${id}-name`;
	const summaryId = `${id}-summary`;
	const dotId = `${id}-dot`;
	const titleLabelId = `${id}-title`;
	const bodyId = `${id}-body`;
	const editingTitle = open && title !== undefined;
	const showDot = !open && invalid;
	const summary = !open && text.summary;
	const nameText = (
		<span
			id={nameId}
			dir="auto"
			className={
				editingTitle
					? "sr-only"
					: cn("min-w-0 truncate", text.title ? ITEM_TITLE : "text-base text-kumo-placeholder")
			}
		>
			{name}
		</span>
	);
	// While the title is edited in the row, the photo sits between the caret and the title input,
	// so the title keeps its place.
	const thumb = thumbnail && !readOnly && (
		<img
			key={thumbnail}
			src={thumbnail}
			alt=""
			loading="lazy"
			className={cn(IMAGE_EDGE, "size-6 shrink-0 rounded-md object-cover")}
			onError={(event) => {
				event.currentTarget.hidden = true;
			}}
		/>
	);
	return (
		<div
			ref={sortable.setNodeRef}
			style={sortable.style}
			role="listitem"
			data-list-item
			data-item-key={row.key}
			data-menu-open={sortable.menuOpen || undefined}
			className={cn(
				"group/item relative rounded-lg transition-[background-color] duration-200 ease-emdash motion-reduce:transition-none",
				// Hover washes a row too, so an open item also takes an edge no hovered row has.
				open && "bg-emdash-hover ring-1 ring-kumo-line ring-inset",
				sortable.className,
				"rounded-lg",
			)}
		>
			{!readOnly && <DragHandle listeners={sortable.listeners} className="top-1.5" />}
			<div
				className={cn(
					// The end keeps room for the menu button drawn over it.
					"flex min-h-9 min-w-0 items-center gap-2 rounded-lg ps-2",
					readOnly ? "pe-0.5" : "pe-9",
					!open && !readOnly && cn(ROW_HOVER, HEAD_MENU_OPEN, HEAD_PRESSED),
					!editingTitle && HEAD_FOCUS,
				)}
			>
				{readOnly ? (
					editingTitle ? (
						nameText
					) : (
						<div className="flex min-h-9 min-w-0 flex-1 items-center ps-6">{nameText}</div>
					)
				) : (
					<button
						type="button"
						data-item-focus
						aria-expanded={open}
						aria-controls={bodyId}
						aria-labelledby={nameId}
						aria-describedby={
							[showDot && dotId, summary && summaryId].filter(Boolean).join(" ") || undefined
						}
						aria-keyshortcuts={MOVE_KEYS}
						onPointerDown={(event) => {
							pointerRef.current = event.pointerType;
						}}
						onClick={(event) => {
							// A mouse click opens the item into its title, at the point clicked. A tap only
							// opens it, so reading an item doesn't raise the keyboard. Enter and Space click
							// with no detail, and leave focus on the toggle.
							if (
								event.detail === 0 ||
								open ||
								title === undefined ||
								pointerRef.current !== "mouse"
							) {
								onToggle();
								return;
							}
							const at = text.title
								? textOffsetAt(event.clientX, event.clientY, document.getElementById(nameId))
								: undefined;
							onToggle({ at });
						}}
						onKeyDown={moveKeys}
						className={cn(
							"text-start outline-none",
							// A 24px target around a 20px caret, 44px on a coarse pointer. It reaches under the
							// title's box, so it sits above it.
							editingTitle
								? "group/caret relative z-1 -mx-1 grid size-6 shrink-0 place-items-center pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5"
								: "flex min-h-9 min-w-0 flex-1 items-center gap-2 self-stretch",
						)}
					>
						{editingTitle ? (
							<span className="grid size-5 place-items-center rounded-md group-hover/caret:bg-emdash-hover group-focus-visible/caret:ring-1 group-focus-visible/caret:ring-kumo-focus/50 group-active/caret:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))]">
								<DisclosureCaret open={open} className={GLYPH_NUDGE} />
							</span>
						) : (
							<DisclosureCaret open={open} className={GLYPH_NUDGE} />
						)}
						{!editingTitle && thumb}
						{nameText}
						{summary && (
							<span className={cn(ROW_SUMMARY, SUMMARY_SLOT)}>
								<span id={summaryId} dir="auto" className={SUMMARY_TEXT}>
									{summary}
								</span>
							</span>
						)}
					</button>
				)}
				{editingTitle && thumb}
				{editingTitle && (
					// The title keeps its closed weight. The editor's field column sets input text to
					// font-normal, which only `!` outranks. A box shorter than the row keeps the focused
					// title off the card's edge without moving its text.
					<div
						data-item-control
						className={cn(
							"min-w-0 flex-1 [&_input]:h-8 [&_input]:font-medium!",
							readOnly ? "ms-4" : "-ms-2",
						)}
					>
						<span id={titleLabelId} hidden>
							{titleLabel}
						</span>
						{title(titleLabelId)}
					</div>
				)}
				{showDot && <ErrorDot id={dotId} />}
			</div>
			<DisclosurePanel
				open={open}
				id={bodyId}
				role="group"
				aria-labelledby={nameId}
				data-item-control={title === undefined || undefined}
			>
				<div className="pe-2 pt-1 pb-3 ps-6">{children}</div>
			</DisclosurePanel>
			{/* After the fields in the page, so Tab reaches them first. */}
			{!readOnly && (
				<RowMenu
					name={name}
					index={index}
					count={count}
					canDelete={canDelete}
					add={add}
					duplicate={duplicate}
					onMove={onMove}
					onEdge={onEdge}
					onDelete={onDelete}
					onOpenChange={sortable.setMenuOpen}
					className="absolute end-0.5 top-[5px]"
				/>
			)}
		</div>
	);
}
