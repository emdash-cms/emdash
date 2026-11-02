import { Button, DropdownMenu } from "@cloudflare/kumo";
import {
	closestCenter,
	DndContext,
	PointerSensor,
	type DragEndEvent,
	useDndMonitor,
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
import {
	DRAGGING,
	GLYPH_NUDGE,
	LIST_LABEL,
	LIST_NOTE,
	ROW_BUTTON,
	ROW_HOVER,
	ROW_SUMMARY,
	ROW_TITLE,
	SORT_TRANSITION,
} from "./block-field-styles.js";
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
	/**
	 * A table cell, where a photo draws as a thumbnail and there is no room under the control
	 * for a hint or an error.
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
	 * Called when saved items change position, with each item's new position by its old one,
	 * or -1 for an item removed.
	 */
	onItemsShift: (moves: readonly number[]) => void;
	renderControl: (input: ListControlInput) => React.ReactNode;
	renderItemFields: (input: ListItemFieldsInput) => React.ReactNode;
}

type ListFocus =
	| { key: string; target: "control"; caret?: number }
	| { key: string; target: "item" }
	| { target: "add" };

const FOCUSABLE =
	'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const MENU_ICON = "size-4";
const LINE_BREAK = /[\r\n]/;
// Other input types, such as number and email, throw when a script sets their selection.
const SELECTABLE_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);
const POPUP = '[role="dialog"], [role="menu"], [role="listbox"]';
const IMAGE_COLUMN = "4.5rem";
const MENU_COLUMN = "2rem";
// Touch and narrow screens have no hover, so their menus always show. Focus from a click doesn't
// show them; the state being entered sets the duration, so they fade in and vanish at once.
const SHOW_ON_HOVER =
	"blocks-gutter:opacity-0 blocks-gutter:transition-opacity blocks-gutter:duration-0 blocks-gutter:ease-out blocks-gutter:group-hover/item:opacity-100 blocks-gutter:group-hover/item:duration-100 blocks-gutter:group-data-[menu-open]/item:opacity-100 blocks-gutter:group-data-[menu-open]/item:duration-100 blocks-gutter:focus-visible:opacity-100 blocks-gutter:focus-visible:duration-100";
const HEAD_FOCUS =
	"has-[[data-item-focus]:focus-visible]:bg-[image:linear-gradient(var(--color-emdash-hover),var(--color-emdash-hover))] has-[[data-item-focus]:focus-visible]:ring-1 has-[[data-item-focus]:focus-visible]:ring-kumo-focus/50 has-[[data-item-focus]:focus-visible]:ring-inset";

export function focusableIn(element: Element | null | undefined): HTMLElement | null {
	if (!element) return null;
	const candidates = [element, ...element.querySelectorAll(FOCUSABLE)];
	return (
		candidates.find(
			(candidate): candidate is HTMLElement =>
				candidate instanceof HTMLElement &&
				candidate.matches(FOCUSABLE) &&
				candidate.tabIndex >= 0 &&
				!candidate.closest("[aria-hidden='true']") &&
				// A rich text field's toolbar comes before its text, and a hidden control can't take focus.
				!candidate.closest('[role="toolbar"]') &&
				candidate.getClientRects().length > 0,
		) ?? null
	);
}

function leftFor(container: Element, next: Element | null): boolean {
	return next !== null && !container.contains(next) && !next.closest(POPUP);
}

/**
 * Calls `callback` when focus leaves `event.currentTarget`. Focus that moves into a popup the
 * control opened, such as a menu or the media picker, or out of the window, has not left it.
 */
export function whenFocusLeaves(event: React.FocusEvent<HTMLElement>, callback: () => void) {
	const container = event.currentTarget;
	const next = event.relatedTarget;
	if (next instanceof Element) {
		if (leftFor(container, next)) callback();
		return;
	}
	// Clicking something that can't take focus blurs with no relatedTarget, and so does leaving
	// the window; only the first moves focus to the page. Safari doesn't focus a clicked button
	// either, so a click that lands inside the element, still under the pointer, stays in it.
	queueMicrotask(() => {
		if (
			document.hasFocus() &&
			!container.matches(":hover") &&
			leftFor(container, document.activeElement ?? document.body)
		) {
			callback();
		}
	});
}

// The rows below a panel move with its height, so the curve starts gently enough that no frame
// carries them more than about a quarter of the way. The caret's class repeats it.
const DISCLOSURE_EASE = "cubic-bezier(0.33, 1, 0.68, 1)";
const OPEN_MS = 200;
const CLOSE_MS = 160;
const DROP_MS = 200;

const noop = () => {};

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The nearest ancestor of `element` that scrolls, or the page when it scrolls. */
function scrollerOf(element: Element): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
			return node;
		}
	}
	const page = document.scrollingElement;
	return page instanceof HTMLElement && page.scrollHeight > page.clientHeight ? page : null;
}

function scrollInstantly(scroller: HTMLElement, by: number) {
	scroller.scrollBy({ top: by, behavior: "instant" });
}

function viewBottom(scroller: HTMLElement | null): number {
	if (!scroller || scroller === document.scrollingElement) return window.innerHeight;
	return scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
}

/**
 * How far a panel `height` tall, at `top`, moves. One taller than the scroller moves only down to
 * its bottom edge: the rest of its travel would be out of sight, and would crowd the part in
 * sight into the first frames.
 */
function travel(scroller: HTMLElement | null, top: number, height: number): number {
	const bottom = viewBottom(scroller);
	if (top >= bottom) return 0;
	return height > (scroller?.clientHeight ?? window.innerHeight)
		? Math.min(height, bottom - top)
		: height;
}

interface ScrollRoom {
	/** Space added under the content. */
	room: number;
	/** How far the panels closing now will still shrink the content. */
	shrink: number;
	holds: number;
	trim: () => void;
	set: (room: number) => void;
}

const scrollRooms = new WeakMap<HTMLElement, ScrollRoom>();

function scrollRoomOf(scroller: HTMLElement): ScrollRoom {
	const existing = scrollRooms.get(scroller);
	if (existing) return existing;
	const events: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
	const padding = Number.parseFloat(getComputedStyle(scroller).paddingBlockEnd) || 0;
	const resizes = new ResizeObserver(() => state.trim());
	const state: ScrollRoom = {
		room: 0,
		shrink: 0,
		holds: 0,
		set(room) {
			const next = Math.max(0, room);
			if (next > 0 && state.room === 0) {
				events.addEventListener("scroll", state.trim, { passive: true });
				for (const child of scroller.children) resizes.observe(child);
			}
			state.room = next;
			if (next > 0) {
				scroller.style.setProperty("padding-block-end", `${padding + next}px`);
				return;
			}
			scroller.style.removeProperty("padding-block-end");
			events.removeEventListener("scroll", state.trim);
			resizes.disconnect();
			if (state.holds === 0) scrollRooms.delete(scroller);
		},
		// As the reader scrolls back up, or the content grows, the room shrinks to what keeps the
		// scroller where it is.
		trim() {
			if (state.holds > 0) return;
			const content = scroller.scrollHeight - state.room;
			const needed = Math.ceil(scroller.scrollTop + scroller.clientHeight - content);
			state.set(Math.min(state.room, needed));
		},
	};
	scrollRooms.set(scroller, state);
	return state;
}

/**
 * Keeps `scroller` where it is while its content shrinks by `shrink`. When the content would end
 * above the scroller's bottom, room is added under it, so the row being closed stays under the
 * pointer instead of the page sliding down to meet the shorter content. Returns the function
 * that ends the hold, for once the content has shrunk.
 */
function holdScroll(scroller: HTMLElement | null, shrink: number): () => void {
	if (!scroller || shrink <= 0) return noop;
	const state = scrollRoomOf(scroller);
	state.holds += 1;
	state.shrink += shrink;
	const content = scroller.scrollHeight - state.room;
	const needed = Math.ceil(scroller.scrollTop + scroller.clientHeight - (content - state.shrink));
	if (needed > state.room) state.set(needed);
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		state.holds -= 1;
		state.shrink -= shrink;
		state.trim();
	};
}

interface PanelMotion {
	height: Animation;
	/** Holds the content drawn up by `lift` while the panel closes under its pinned head. */
	content?: Animation;
	lift: number;
	release: () => void;
	/** Puts the panel where the motion ends. */
	finish: () => void;
}

function liftContent(panel: HTMLElement, lift: number, duration: number): Animation | undefined {
	const content = panel.firstElementChild;
	if (lift <= 0 || !content) return undefined;
	const transform = `translateY(${-lift}px)`;
	return content.animate({ transform: [transform, transform] }, { duration, fill: "forwards" });
}

/**
 * The body of a block, a list item or the Advanced rows: grows open and shrinks closed, then
 * unmounts. Padding belongs on a child, since the panel's own height runs down to zero.
 *
 * Motion starts from wherever the panel is, so a toggle can be reversed midway, and only covers
 * what the scroller shows: the part of a tall panel below its bottom edge appears or goes at once.
 * The clip lasts only as long as the motion, so sticky toolbars and floating hints inside aren't
 * cut off at rest.
 */
export function DisclosurePanel({
	open,
	instant = false,
	headRef,
	onClosed,
	className,
	...props
}: {
	open: boolean;
	/** Opens or closes without motion, as Expand all and Collapse all do. */
	instant?: boolean;
	/**
	 * The panel's head. When it's pinned over a scrolled panel, the panel closes in place: the
	 * fields in view stay put and the rows below rise to meet the head.
	 */
	headRef?: React.RefObject<HTMLElement | null>;
	/** Called once a closed panel is gone. */
	onClosed?: () => void;
} & React.ComponentPropsWithoutRef<"div">) {
	const ref = React.useRef<HTMLDivElement>(null);
	const motionRef = React.useRef<PanelMotion | null>(null);
	const shownRef = React.useRef(open);
	const [mounted, setMounted] = React.useState(open);
	if (open && !mounted) setMounted(true);
	const unmount = useStableCallback(() => {
		setMounted(false);
		onClosed?.();
	});

	React.useLayoutEffect(() => {
		if (open === shownRef.current) {
			// Expand all and Collapse all also finish a panel already on its way.
			const motion = motionRef.current;
			if (instant && motion) {
				motionRef.current = null;
				motion.finish();
			}
			return;
		}
		shownRef.current = open;
		const panel = ref.current;
		if (!panel) return;
		const scroller = scrollerOf(panel);
		const previous = motionRef.current;
		motionRef.current = null;
		const current = panel.getBoundingClientRect().height;
		const opacity = previous ? Number(getComputedStyle(panel).opacity) : open ? 0 : 1;
		let lift = previous?.lift ?? 0;
		previous?.height.cancel();
		previous?.content?.cancel();
		// A close being reversed keeps holding the scroller until the panel is open again.
		const held = previous?.release ?? noop;
		const still = instant || prefersReducedMotion();

		if (open) {
			// An open panel takes the place of any room a close left under the content.
			const restore = () => {
				if (scroller && lift > 0) scrollInstantly(scroller, lift);
				held();
				if (scroller) scrollRooms.get(scroller)?.trim();
			};
			if (still) {
				restore();
				return;
			}
			const { top, height: natural } = panel.getBoundingClientRect();
			const from = previous ? current : 0;
			const to = Math.max(from, travel(scroller, top, natural - lift));
			if (to - from < 1) {
				restore();
				return;
			}
			const height = panel.animate(
				{
					height: [`${from}px`, `${to}px`],
					opacity: [opacity, 1],
					clipPath: ["inset(0)", "inset(0)"],
				},
				{ duration: OPEN_MS, easing: DISCLOSURE_EASE, fill: lift > 0 ? "forwards" : "none" },
			);
			const motion: PanelMotion = {
				height,
				content: liftContent(panel, lift, OPEN_MS),
				lift,
				release: held,
				finish() {
					height.cancel();
					motion.content?.cancel();
					restore();
				},
			};
			motionRef.current = motion;
			height.addEventListener("finish", () => {
				if (motionRef.current !== motion) return;
				motionRef.current = null;
				motion.finish();
			});
			return;
		}

		let shown = current;
		const head = headRef?.current;
		if (head && scroller) {
			// A head pinned over the panel hides the part above it. Scrolling the block's top up to
			// the head while drawing the content up as far leaves everything in view where it was.
			const pinned = Math.round(
				head.getBoundingClientRect().bottom - panel.getBoundingClientRect().top,
			);
			if (pinned > 0) {
				scrollInstantly(scroller, -pinned);
				lift += pinned;
				shown = Math.max(0, shown - pinned);
			}
		}
		const { top, height: laidOut } = panel.getBoundingClientRect();
		const release = holdScroll(scroller, laidOut);
		held();
		const from = travel(scroller, top, shown);
		if (still || from < 1) {
			unmount();
			requestAnimationFrame(release);
			return;
		}
		const height = panel.animate(
			{
				height: [`${from}px`, "0px"],
				opacity: [opacity, 0],
				clipPath: ["inset(0)", "inset(0)"],
			},
			{ duration: CLOSE_MS, easing: DISCLOSURE_EASE, fill: "forwards" },
		);
		const motion: PanelMotion = {
			height,
			content: liftContent(panel, lift, CLOSE_MS),
			lift,
			release,
			finish() {
				height.finish();
				release();
				unmount();
			},
		};
		motionRef.current = motion;
		height.addEventListener("finish", () => {
			if (motionRef.current !== motion) return;
			motionRef.current = null;
			motion.finish();
		});
	}, [open, instant, headRef, unmount]);

	React.useEffect(() => () => motionRef.current?.release(), []);

	if (!mounted) return null;
	return (
		<div
			ref={ref}
			inert={!open || undefined}
			className={cn("emdash-disclosure", className)}
			{...props}
		/>
	);
}

/**
 * A dragged row eases from where it was let go into its slot, still lifted, instead of jumping
 * there. Returns the sortable's node ref, wrapped, and whether the row is still settling.
 */
export function useDropSettle(
	id: string,
	isDragging: boolean,
	setSortableRef: (node: HTMLElement | null) => void,
) {
	const nodeRef = React.useRef<HTMLElement | null>(null);
	const letGoRef = React.useRef<DOMRect | null>(null);
	const [settling, setSettling] = React.useState(false);
	const setNodeRef = React.useCallback(
		(node: HTMLElement | null) => {
			nodeRef.current = node;
			setSortableRef(node);
		},
		[setSortableRef],
	);
	const monitor = React.useMemo(() => {
		const letGo = ({ active }: DragEndEvent) => {
			if (active.id === id && nodeRef.current) {
				letGoRef.current = nodeRef.current.getBoundingClientRect();
			}
		};
		return { onDragEnd: letGo, onDragCancel: letGo };
	}, [id]);
	useDndMonitor(monitor);

	// Runs in the commit that drops the row, once it sits in its new slot but before it paints.
	React.useLayoutEffect(() => {
		const from = letGoRef.current;
		letGoRef.current = null;
		const node = nodeRef.current;
		if (isDragging || !from || !node || prefersReducedMotion()) return;
		const to = node.getBoundingClientRect();
		const x = from.left - to.left;
		const y = from.top - to.top;
		if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
		setSettling(true);
		const settle = node.animate(
			{ transform: [`translate(${x}px, ${y}px)`, "none"] },
			{ duration: DROP_MS, easing: DISCLOSURE_EASE },
		);
		const done = () => setSettling(false);
		settle.addEventListener("finish", done);
		settle.addEventListener("cancel", done);
	}, [isDragging]);

	return { setNodeRef, settling };
}

/** The caret of a disclosure row, which turns to point at the open body as the body moves. */
export function DisclosureCaret({
	open,
	instant = false,
	className,
}: {
	open: boolean;
	instant?: boolean;
	className?: string;
}) {
	return (
		<span aria-hidden="true" className={cn("grid size-4 shrink-0 place-items-center", className)}>
			<CaretRight
				weight="bold"
				className={cn(
					"size-3 text-kumo-subtle transition-transform duration-160 ease-[cubic-bezier(0.33,1,0.68,1)] motion-reduce:transition-none rtl:-scale-x-100",
					open && "rotate-90 duration-200 rtl:-rotate-90",
					instant && "transition-none",
				)}
			/>
		</span>
	);
}

export function ErrorDot({ id }: { id?: string }) {
	const { t } = useLingui();
	return (
		<span
			id={id}
			role="img"
			aria-label={t`Has fields to fix`}
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
		const wasSaved = new Set(Array.isArray(source) ? source : []);
		current = syncRows(
			rows.filter((row) => wasSaved.has(row.item)),
			items,
			knownKeys,
		);
		setSource(value);
		setRows(current);
	}
	const savedIndex = new Map(items.map((item, index) => [item, index]));
	// Only a line that isn't in the saved list is blank, so an empty item already saved stays.
	const isBlank = (row: Row) =>
		lineField !== undefined && !savedIndex.has(row.item) && isBlankLine(row.item[lineField.slug]);
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
								"min-w-0 px-2 pt-1.5 pb-1 text-xs leading-4 text-kumo-subtle wrap-anywhere",
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
			className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
			onBlur={
				lineField && !readOnly
					? (event) => {
							whenFocusLeaves(event, () => queueMicrotask(removeBlankLines));
						}
					: undefined
			}
		>
			<div className={cn("flex min-w-0 items-baseline gap-1.5 ps-2", !hint && "pb-1")}>
				<span id={labelId} className={cn(LIST_LABEL, "wrap-anywhere")}>
					{listLabel}
				</span>
				{savedCount > 0 && (
					<bdi className={cn(LIST_NOTE, "text-kumo-placeholder tabular-nums")}>
						{i18n.number(savedCount)}
					</bdi>
				)}
				{/* On the label's line, so showing it moves nothing. */}
				{error && (
					<>
						<span aria-hidden="true" className={cn(LIST_NOTE, "text-kumo-placeholder")}>
							·
						</span>
						<span id={errorId} className={cn(LIST_NOTE, "min-w-0 truncate text-kumo-danger")}>
							{error}
						</span>
					</>
				)}
			</div>
			{hint && (
				<p id={hintId} className="ps-2 pt-0.5 pb-1 text-xs leading-4 text-kumo-subtle">
					{hint}
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
				readOnly && <p className="ps-2 text-base text-kumo-subtle">{t`No items yet`}</p>
			)}
			{!readOnly && !atMax && (
				<Button
					ref={addRef}
					variant="ghost"
					icon={<Plus className="size-4" aria-hidden="true" />}
					className={cn(
						ROW_BUTTON,
						"h-8 w-full justify-start gap-2 px-2 font-normal text-kumo-subtle shadow-none hover:text-kumo-default",
						presentation === "items" && current.length > 0 && "mt-0.5",
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
		transition: SORT_TRANSITION,
	});
	const drop = useDropSettle(key, isDragging, setNodeRef);
	const [menuOpen, setMenuOpen] = React.useState(false);
	return {
		listeners,
		setNodeRef: drop.setNodeRef,
		isDragging: isDragging || drop.settling,
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
				"absolute end-full me-0.5 hidden h-6 w-[1.125rem] cursor-grab touch-none place-items-center rounded-md text-kumo-placeholder opacity-0 transition-opacity duration-0 ease-out hover:bg-emdash-hover hover:text-kumo-subtle active:cursor-grabbing blocks-gutter:@min-[440px]/blocks:grid group-hover/item:opacity-100 group-hover/item:duration-100 group-data-[menu-open]/item:opacity-100 group-data-[menu-open]/item:duration-100",
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
						className={cn(ROW_BUTTON, "shrink-0 text-kumo-subtle", SHOW_ON_HOVER)}
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
				"group/item relative flex min-h-8 items-center pe-0.5",
				sortable.isDragging && DRAGGING,
			)}
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
				!readOnly && ROW_HOVER,
				sortable.isDragging && DRAGGING,
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
							text.title ? ROW_TITLE : "text-base text-kumo-placeholder",
						)
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
			className="size-6 shrink-0 rounded-md object-cover ring-1 ring-kumo-line"
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
				open && "bg-emdash-hover",
				sortable.isDragging && cn(DRAGGING, "rounded-lg"),
			)}
		>
			{!readOnly && <DragHandle listeners={sortable.listeners} className="top-1.5" />}
			<div
				className={cn(
					"flex min-h-9 min-w-0 items-center gap-2 rounded-lg ps-2 pe-0.5",
					!open && !readOnly && ROW_HOVER,
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
						onClick={onToggle}
						className={cn(
							"text-start outline-none",
							editingTitle
								? "-mx-0.5 grid size-5 shrink-0 place-items-center rounded-md hover:bg-emdash-hover focus-visible:ring-1 focus-visible:ring-kumo-focus/50"
								: "flex min-h-9 min-w-0 flex-1 items-center gap-2 self-stretch",
						)}
					>
						<DisclosureCaret open={open} className={GLYPH_NUDGE} />
						{!editingTitle && thumb}
						{nameText}
						{summary && (
							<span className={cn(ROW_SUMMARY, "min-w-0 flex-1 overflow-hidden")}>
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
			<DisclosurePanel
				open={open}
				id={bodyId}
				role="group"
				aria-labelledby={nameId}
				data-item-control={title === undefined || undefined}
			>
				<div className="pe-2 pt-1 pb-3 ps-6">{children}</div>
			</DisclosurePanel>
		</div>
	);
}
