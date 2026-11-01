import { Button, DropdownMenu } from "@cloudflare/kumo";
import {
	closestCenter,
	DndContext,
	PointerSensor,
	type DragEndEvent,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowUp,
	CaretRight,
	Copy,
	DotsSixVertical,
	DotsThree,
	Plus,
	Trash,
} from "@phosphor-icons/react";
import * as React from "react";

import {
	itemTitleField,
	type ListSubField,
	listItemText,
	listPresentation,
	splitLabelHint,
} from "../lib/block-field-layout.js";
import { cloneValue, createBlockKey, isBlankLine, pastedLines } from "../lib/block-field-state.js";
import { useStableCallback } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import { type ImageFieldValue, mediaDisplayUrl } from "./ImageFieldRenderer.js";

type ListItem = Record<string, unknown>;

interface Row {
	/** Editor-only identity for drag, focus and open state. Never saved. */
	key: string;
	item: ListItem;
}

export interface DeletedListItem {
	item: ListItem;
	/** Where the item sat in the saved list. */
	index: number;
	name: string;
}

export interface ListControlInput {
	subField: ListSubField;
	/** The item's segment in control names: its index in the saved list, or a key for a blank line. */
	at: string;
	value: unknown;
	onChange: (value: unknown) => void;
	labelledBy: string;
	placeholder?: string;
	thumbnail?: "cell";
	/** A table cell, with no room under the control for a hint or an error. */
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
	/** A problem with the list's size, shown under its label. */
	error?: string;
	/** Indexes, in the saved list, of the items that hold a problem to show. */
	invalidItems: ReadonlySet<number>;
	/** A new token opens the items in `invalidItems`. */
	revealToken: number;
	onItemDeleted: (deleted: DeletedListItem) => void;
	renderControl: (input: ListControlInput) => React.ReactNode;
	renderItemFields: (input: ListItemFieldsInput) => React.ReactNode;
}

type ListFocus =
	| { key: string; target: "control"; caret?: number }
	| { key: string; target: "item" }
	| { target: "add" };

export const FOCUSABLE =
	'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const MENU_ICON = "me-2 size-4";
const LINE_BREAK = /[\r\n]/;
// Other input types, such as number and email, throw when a script sets their selection.
const SELECTABLE_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);
const POPUP = '[role="dialog"], [role="menu"], [role="listbox"]';
const IMAGE_COLUMN = "4.5rem";
const MENU_COLUMN = "2rem";
// Touch and narrow screens have no hover, so their menus always show.
const SHOW_ON_HOVER =
	"blocks-gutter:opacity-0 blocks-gutter:group-hover/item:opacity-100 blocks-gutter:group-focus-within/item:opacity-100 blocks-gutter:group-data-[menu-open]/item:opacity-100";

export function focusableIn(element: Element | null | undefined): HTMLElement | null {
	if (!element) return null;
	const candidates = [element, ...element.querySelectorAll(FOCUSABLE)];
	return (
		candidates.find(
			(candidate): candidate is HTMLElement =>
				candidate instanceof HTMLElement &&
				candidate.matches(FOCUSABLE) &&
				candidate.tabIndex >= 0 &&
				!candidate.closest("[aria-hidden='true']"),
		) ?? null
	);
}

/**
 * Whether focus left `event.currentTarget`. Focus that moves into a popup the control opened,
 * such as a menu or the media picker, or out of the window, has not left it.
 */
export function focusLeft(event: React.FocusEvent<HTMLElement>): boolean {
	const next = event.relatedTarget;
	return next instanceof Element && !event.currentTarget.contains(next) && !next.closest(POPUP);
}

export function ErrorDot({ id }: { id?: string }) {
	const { t } = useLingui();
	return (
		<span
			id={id}
			role="img"
			aria-label={t`Has fields to fix`}
			className="size-2 shrink-0 rounded-full bg-kumo-danger"
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
 * Keys for `items`: an item keeps the key it had, even after a move or an Undo, and an
 * item replaced in place takes over the key at its position.
 */
function syncRows(
	previous: readonly Row[],
	items: readonly ListItem[],
	known: WeakMap<ListItem, string>,
): Row[] {
	const incoming = new Set(items);
	const taken = new Set<string>();
	const keys = items.map((item) => {
		const key = known.get(item);
		if (key === undefined || taken.has(key)) return undefined;
		taken.add(key);
		return key;
	});
	return items.map((item, index) => {
		let key = keys[index];
		if (key === undefined) {
			const atPosition = previous[index];
			key =
				atPosition && !taken.has(atPosition.key) && !incoming.has(atPosition.item)
					? atPosition.key
					: createBlockKey();
			taken.add(key);
		}
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
	const [rows, setRows] = React.useState<Row[]>(() => syncRows([], items, knownKeys));
	const [source, setSource] = React.useState(value);
	const [openKeys, setOpenKeys] = React.useState<ReadonlySet<string>>(() => new Set());
	const [seenReveal, setSeenReveal] = React.useState(0);
	const [announcement, setAnnouncement] = React.useState("");
	const rootRef = React.useRef<HTMLDivElement>(null);
	const addRef = React.useRef<HTMLButtonElement>(null);
	const focusRef = React.useRef<ListFocus | null>(null);
	const hintId = React.useId();
	const errorId = React.useId();
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

	let current = rows;
	if (value !== source) {
		current = syncRows(rows, items, knownKeys);
		setSource(value);
		setRows(current);
	}

	const isBlank = (row: Row) => lineField !== undefined && isBlankLine(row.item[lineField.slug]);
	const savedIndex = new Map(items.map((item, index) => [item, index]));
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
	const { label: listLabel, hint } = splitLabelHint(label);
	const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;

	const emit = (next: Row[]) => {
		const nextItems = next.filter((row) => !isBlank(row)).map((row) => row.item);
		for (const row of next) knownKeys.set(row.item, row.key);
		setRows(next);
		if (sameItems(nextItems, items)) return;
		setSource(nextItems);
		onChange(nextItems);
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
		const target = row.querySelector(
			request.target === "item" ? "[data-item-focus]" : "[data-item-control]",
		);
		const element = focusableIn(target) ?? focusableIn(row);
		element?.focus();
		if (
			request.target === "control" &&
			element instanceof HTMLInputElement &&
			SELECTABLE_INPUT_TYPES.has(element.type)
		) {
			const caret = request.caret ?? element.value.length;
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

	const addRow = () => {
		if (atMax) return;
		const row = { key: createBlockKey(), item: newItem() };
		insertRow(current.length, row);
		if (presentation === "items") setOpenKeys(new Set(openKeys).add(row.key));
		focusRef.current = { key: row.key, target: "control" };
	};

	const moveRow = (from: number, to: number) => {
		const row = current[from];
		if (!row || to < 0 || to >= current.length) return;
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
		setOpenKeys(new Set(openKeys).add(copy.key));
	};

	const deleteRow = (key: string) => {
		const index = current.findIndex((row) => row.key === key);
		const row = current[index];
		if (!row || !canDelete(row)) return;
		const next = current.filter((candidate) => candidate.key !== key);
		const neighbour = next[index] ?? next[index - 1];
		focusRef.current = neighbour ? { key: neighbour.key, target: "item" } : { target: "add" };
		emit(next);
		const position = positions[index];
		if (position === undefined) return;
		onItemDeleted({ item: row.item, index: position, name: name(row, index) });
	};

	const removeBlankLines = useStableCallback(() => {
		const root = rootRef.current;
		if (!root || root.contains(document.activeElement)) return;
		const kept = current.filter((row) => !isBlank(row));
		if (kept.length !== current.length) emit(kept);
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
			emit(current.filter((candidate) => candidate.key !== row.key));
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

	const handleDragEnd = (event: DragEndEvent) => {
		if (!event.over || event.active.id === event.over.id) return;
		const from = current.findIndex((row) => row.key === event.active.id);
		const to = current.findIndex((row) => row.key === event.over?.id);
		if (from < 0 || to < 0) return;
		emit(arrayMove(current, from, to));
	};

	const rowProps = (row: Row, index: number): SortableRowProps => ({
		row,
		index,
		count: current.length,
		name: name(row, index),
		readOnly,
		canDelete: canDelete(row),
		onMove: (to) => moveRow(index, to),
		onDelete: () => deleteRow(row.key),
	});

	const control = (
		row: Row,
		index: number,
		subField: ListSubField,
		input: Pick<ListControlInput, "labelledBy" | "placeholder" | "thumbnail" | "cell">,
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
					<LineRow
						key={row.key}
						{...rowProps(row, index)}
						lineLabel={splitLabelHint(lineField.label).label}
					>
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
								"min-w-0 px-2 pb-1 text-xs leading-4 font-medium text-kumo-subtle wrap-anywhere",
								subField.type === "image" && "text-center",
							)}
						>
							{splitLabelHint(subField.label).label}
						</span>
					))}
					{!readOnly && (
						<span role="columnheader">
							<span className="sr-only">{t`Actions`}</span>
						</span>
					)}
				</div>
				{current.map((row, index) => (
					<TableRow key={row.key} {...rowProps(row, index)} columns={columns}>
						{subFields.map((subField, column) => (
							<LabelledCell
								key={subField.slug}
								label={splitLabelHint(subField.label).label}
								position={index + 1}
								first={column === 0}
							>
								{(labelledBy) =>
									control(row, index, subField, {
										labelledBy,
										cell: true,
										...(subField.type === "image" ? { thumbnail: "cell" as const } : {}),
									})
								}
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
							onToggle={() => setOpenKeys(toggled(openKeys, row.key))}
							title={
								editableTitle &&
								((labelledBy) =>
									control(row, index, editableTitle, {
										labelledBy,
										placeholder: splitLabelHint(editableTitle.label).label,
									}))
							}
							titleLabel={editableTitle && splitLabelHint(editableTitle.label).label}
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
			className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1"
			onBlur={
				lineField && !readOnly
					? (event) => {
							if (focusLeft(event)) queueMicrotask(removeBlankLines);
						}
					: undefined
			}
		>
			<div className="flex min-h-6 min-w-0 items-baseline gap-1.5 ps-2">
				<span id={labelId} className="text-sm font-medium text-kumo-default wrap-anywhere">
					{listLabel}
				</span>
				{savedCount > 0 && (
					<bdi className="text-sm text-kumo-placeholder tabular-nums">
						{i18n.number(savedCount)}
					</bdi>
				)}
			</div>
			{hint && (
				<p id={hintId} className="ps-2 text-xs leading-4 text-kumo-subtle">
					{hint}
				</p>
			)}
			{error && (
				<p id={errorId} className="ps-2 text-xs leading-4 text-kumo-danger">
					{error}
				</p>
			)}
			{current.length > 0 ? (
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext
						items={current.map((row) => row.key)}
						strategy={verticalListSortingStrategy}
					>
						{body}
					</SortableContext>
				</DndContext>
			) : (
				readOnly && <p className="ps-2 text-sm text-kumo-subtle">{t`No items yet`}</p>
			)}
			{!readOnly && !atMax && (
				<Button
					ref={addRef}
					variant="ghost"
					icon={<Plus className="size-4" aria-hidden="true" />}
					className={cn(
						"h-8 w-full justify-start px-2 font-normal text-kumo-subtle shadow-none hover:text-kumo-default",
						presentation === "lines" ? "gap-2.5 ps-0.5" : "gap-2",
					)}
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
	onMove: (to: number) => void;
	onDelete: () => void;
}

function useSortableRow(key: string, readOnly: boolean) {
	const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: key,
		disabled: readOnly,
	});
	const [menuOpen, setMenuOpen] = React.useState(false);
	return {
		listeners,
		setNodeRef,
		isDragging,
		menuOpen,
		setMenuOpen,
		style: { transform: CSS.Transform.toString(transform), transition },
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
				"absolute end-full me-0.5 hidden h-6 w-[1.125rem] cursor-grab touch-none place-items-center rounded-md text-kumo-placeholder opacity-0 transition-opacity hover:bg-kumo-tint hover:text-kumo-subtle active:cursor-grabbing blocks-gutter:@min-[440px]/blocks:grid group-hover/item:opacity-100 group-data-[menu-open]/item:opacity-100",
				className,
			)}
		>
			<DotsSixVertical className="size-3.5" weight="bold" />
		</span>
	);
}

interface RowMenuProps {
	name: string;
	index: number;
	count: number;
	canDelete: boolean;
	duplicate?: { disabled: boolean; onSelect: () => void };
	onMove: (to: number) => void;
	onDelete: () => void;
	onOpenChange: (open: boolean) => void;
}

function RowMenu({
	name,
	index,
	count,
	canDelete,
	duplicate,
	onMove,
	onDelete,
	onOpenChange,
}: RowMenuProps) {
	const { t } = useLingui();
	const deleteOnCloseRef = React.useRef(false);
	const label = name;
	return (
		<DropdownMenu
			onOpenChange={onOpenChange}
			onOpenChangeComplete={(open) => {
				if (open || !deleteOnCloseRef.current) return;
				deleteOnCloseRef.current = false;
				onDelete();
			}}
		>
			<DropdownMenu.Trigger
				render={
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						className={cn("size-7 shrink-0 text-kumo-subtle", SHOW_ON_HOVER)}
						aria-label={t`${label} actions`}
					>
						<DotsThree className="size-4" weight="bold" aria-hidden="true" />
					</Button>
				}
			/>
			<DropdownMenu.Content align="end" className="min-w-44">
				<DropdownMenu.Item
					icon={<ArrowUp className={MENU_ICON} aria-hidden="true" />}
					disabled={index === 0}
					onClick={() => onMove(index - 1)}
				>
					{t`Move up`}
				</DropdownMenu.Item>
				<DropdownMenu.Item
					icon={<ArrowDown className={MENU_ICON} aria-hidden="true" />}
					disabled={index === count - 1}
					onClick={() => onMove(index + 1)}
				>
					{t`Move down`}
				</DropdownMenu.Item>
				{duplicate && (
					<DropdownMenu.Item
						icon={<Copy className={MENU_ICON} aria-hidden="true" />}
						disabled={duplicate.disabled}
						onClick={duplicate.onSelect}
					>
						{t`Duplicate`}
					</DropdownMenu.Item>
				)}
				<DropdownMenu.Separator />
				<DropdownMenu.Item
					variant="danger"
					icon={<Trash className={MENU_ICON} aria-hidden="true" />}
					disabled={!canDelete}
					onClick={() => {
						deleteOnCloseRef.current = true;
					}}
				>
					{t`Delete`}
				</DropdownMenu.Item>
			</DropdownMenu.Content>
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
	onMove,
	onDelete,
	lineLabel,
	children,
}: SortableRowProps & {
	lineLabel: string;
	children: (labelledBy: string) => React.ReactNode;
}) {
	const { t } = useLingui();
	const sortable = useSortableRow(row.key, readOnly);
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
			className={cn(
				"group/item relative flex min-h-8 items-center",
				sortable.isDragging && "opacity-50",
			)}
		>
			{!readOnly && <DragHandle listeners={sortable.listeners} className="top-1" />}
			<span aria-hidden="true" className="grid w-5 shrink-0 place-items-center self-stretch">
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
	children,
}: {
	label: string;
	position: number;
	first: boolean;
	children: (labelledBy: string) => React.ReactNode;
}) {
	const { t } = useLingui();
	const labelId = React.useId();
	return (
		<div
			role="cell"
			className="min-w-0"
			data-item-control={first || undefined}
			data-item-focus={first || undefined}
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
	onMove,
	onDelete,
	columns,
	children,
}: SortableRowProps & { columns: string; children: React.ReactNode }) {
	const sortable = useSortableRow(row.key, readOnly);
	return (
		<div
			ref={sortable.setNodeRef}
			role="row"
			data-list-item
			data-item-key={row.key}
			data-menu-open={sortable.menuOpen || undefined}
			style={{ ...sortable.style, gridTemplateColumns: columns }}
			className={cn(
				"group/item relative grid items-center rounded-md",
				!readOnly && "hover:bg-kumo-tint",
				sortable.isDragging && "opacity-50",
			)}
		>
			{children}
			{!readOnly && (
				<div role="cell" className="flex justify-end">
					<DragHandle listeners={sortable.listeners} className="top-1" />
					<RowMenu
						name={name}
						index={index}
						count={count}
						canDelete={canDelete}
						onMove={onMove}
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
	onToggle: () => void;
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
	onMove,
	onDelete,
	open,
	text,
	thumbnail,
	invalid,
	duplicate,
	onToggle,
	title,
	titleLabel,
	children,
}: ItemRowProps) {
	const sortable = useSortableRow(row.key, readOnly);
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
					: cn(
							"min-w-0 truncate",
							summary && "@min-[440px]/blocks:max-w-[55%]",
							text.title ? "font-medium text-kumo-default" : "text-kumo-placeholder",
						)
			}
		>
			{name}
		</span>
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
				"group/item relative rounded-lg",
				open && "bg-kumo-elevated",
				sortable.isDragging && "opacity-50",
			)}
		>
			{!readOnly && <DragHandle listeners={sortable.listeners} className="top-1.5" />}
			<div
				className={cn(
					"flex min-h-9 min-w-0 items-center gap-2 rounded-lg py-0.5 ps-1 pe-1",
					!open && !readOnly && "hover:bg-kumo-tint",
				)}
			>
				{readOnly ? (
					editingTitle ? (
						nameText
					) : (
						<div className="flex min-h-8 min-w-0 flex-1 items-center ps-6">{nameText}</div>
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
						onClick={onToggle}
						className={cn(
							"flex min-h-8 items-center gap-2 self-stretch rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand",
							editingTitle ? "shrink-0 px-1" : "min-w-0 flex-1 ps-1",
						)}
					>
						<CaretRight
							weight="bold"
							aria-hidden="true"
							className={cn(
								"size-3 shrink-0 text-kumo-subtle transition-transform rtl:-scale-x-100",
								open && "rotate-90 rtl:-rotate-90",
							)}
						/>
						{thumbnail && !open && (
							<img
								key={thumbnail}
								src={thumbnail}
								alt=""
								loading="lazy"
								className="size-6 shrink-0 rounded-md object-cover ring-1 ring-kumo-line"
								onError={(event) => {
									event.currentTarget.hidden = true;
								}}
							/>
						)}
						{nameText}
						{summary && (
							<span className="min-w-0 flex-1 overflow-hidden text-kumo-subtle">
								<span
									id={summaryId}
									dir="auto"
									className="inline-block max-w-full truncate align-top"
								>
									{summary}
								</span>
							</span>
						)}
					</button>
				)}
				{editingTitle && (
					// The title keeps its closed weight. The editor's field column sets input text to
					// font-normal, which only `!` outranks.
					<div
						data-item-control
						className={cn("min-w-0 flex-1 [&_input]:font-medium!", readOnly ? "ms-4" : "-ms-3")}
					>
						<span id={titleLabelId} hidden>
							{titleLabel}
						</span>
						{title(titleLabelId)}
					</div>
				)}
				{showDot && <ErrorDot id={dotId} />}
				{!readOnly && (
					<RowMenu
						name={name}
						index={index}
						count={count}
						canDelete={canDelete}
						duplicate={duplicate}
						onMove={onMove}
						onDelete={onDelete}
						onOpenChange={sortable.setMenuOpen}
					/>
				)}
			</div>
			{open && (
				<div
					id={bodyId}
					role="group"
					aria-labelledby={nameId}
					data-item-control={title === undefined || undefined}
					className="pe-2 pb-3 ps-5"
				>
					{children}
				</div>
			)}
		</div>
	);
}
