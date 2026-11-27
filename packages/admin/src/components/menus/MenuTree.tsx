import { Button, DropdownMenu } from "@cloudflare/kumo";
import {
	closestCenter,
	defaultDropAnimationSideEffects,
	DndContext,
	DragOverlay,
	KeyboardSensor,
	MeasuringStrategy,
	PointerSensor,
	useSensor,
	useSensors,
	type Announcements,
	type DragEndEvent,
	type DragMoveEvent,
	type DragStartEvent,
	type DropAnimation,
	type KeyboardCoordinateGetter,
	type Modifier,
	type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowUp,
	DotsSixVertical,
	PencilSimple,
	Plus,
	TextIndent,
	TextOutdent,
	Trash,
} from "@phosphor-icons/react";
import * as React from "react";

import type { MenuItem } from "../../lib/api";
import { cn } from "../../lib/utils.js";
import { RowActionsMenu } from "../DataTable.js";
import {
	applyDrop,
	applyMove,
	availableMoves,
	deepestAllowedDepth,
	flattenMenu,
	getProjection,
	INDENT_WIDTH,
	MAX_DEPTH,
	removeChildrenOf,
	type FlatMenuItem,
	type MenuMove,
} from "./menu-tree.js";
import { MenuItemRowBody, ROW_CLASS } from "./MenuItemRow.js";

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const HANDLE_COLUMN = 38;

const dropAnimation: DropAnimation = {
	duration: 200,
	easing: EASE_OUT,
	sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

const measuring = { droppable: { strategy: MeasuringStrategy.Always } };

/** The lifted row stays in the list's column; its indent shows the depth it will land at. */
const lockToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/** What the keyboard sensor and the announcements read, since they run outside render. */
interface DragState {
	items: MenuItem[];
	/** Rows in display order, without the lifted row's children. */
	visible: FlatMenuItem[];
	offset: number;
	maxDepth: number;
	rtl: boolean;
}

const VERTICAL = ["ArrowDown", "ArrowUp"];
const HORIZONTAL = ["ArrowLeft", "ArrowRight"];

function placesOf(flat: readonly FlatMenuItem[]) {
	return flat.map((entry) => `${entry.id}:${entry.parentId}`).join();
}

function depthOffsetFor(offset: number, rtl: boolean) {
	return Math.round(((rtl ? -1 : 1) * offset) / INDENT_WIDTH);
}

function project(
	state: DragState,
	activeId: UniqueIdentifier,
	overId: UniqueIdentifier,
	offset: number,
) {
	return getProjection(
		state.visible,
		String(activeId),
		String(overId),
		depthOffsetFor(offset, state.rtl),
		state.maxDepth,
	);
}

/**
 * Arrow keys for a lifted row: up and down move it to the next spot it can
 * land in, keeping its depth where that spot allows; the inline arrows change
 * its depth one level, mirrored in right-to-left layouts.
 */
function treeKeyboardCoordinates(state: React.RefObject<DragState>): KeyboardCoordinateGetter {
	return (event, { currentCoordinates, context }) => {
		const { active, over, collisionRect, droppableRects, droppableContainers } = context;
		if (![...VERTICAL, ...HORIZONTAL].includes(event.code)) return undefined;
		if (!active || !collisionRect || !over) return undefined;
		event.preventDefault();

		const { visible, offset, rtl } = state.current;
		const activeItem = visible.find((entry) => entry.id === active.id);
		if (!activeItem) return undefined;
		const originX = currentCoordinates.x - offset;
		const xForDepth = (depth: number) =>
			originX + (rtl ? -1 : 1) * (depth - activeItem.depth) * INDENT_WIDTH;

		if (HORIZONTAL.includes(event.code)) {
			const projection = project(state.current, active.id, over.id, offset);
			if (!projection) return undefined;
			const deeper = (event.code === "ArrowRight") !== rtl;
			const depth = projection.depth + (deeper ? 1 : -1);
			if (depth < projection.minDepth || depth > projection.maxDepth) return undefined;
			return { ...currentCoordinates, x: xForDepth(depth) };
		}

		const down = event.code === "ArrowDown";
		const ahead = droppableContainers
			.getEnabled()
			.flatMap((container) => {
				const rect = droppableRects.get(container.id);
				if (container.id === over.id || !rect) return [];
				const isAhead = down ? rect.top > collisionRect.top : rect.top < collisionRect.top;
				return isAhead ? [{ id: container.id, top: rect.top }] : [];
			})
			.toSorted((a, b) => (down ? a.top - b.top : b.top - a.top));
		for (const slot of ahead) {
			const projection = project(state.current, active.id, slot.id, offset);
			if (projection) return { x: xForDepth(projection.depth), y: slot.top };
		}
		return undefined;
	};
}

interface MenuTreeProps {
	items: MenuItem[];
	locale?: string;
	onReorder: (next: MenuItem[]) => void;
	onEdit: (item: MenuItem) => void;
	onAddInside: (item: MenuItem) => void;
	onDelete: (item: MenuItem) => void;
}

/**
 * The menu as one sortable tree. Rows drag by their handle; the horizontal
 * offset of a drag picks the depth in `INDENT_WIDTH` steps, and a parent
 * carries its children.
 */
export function MenuTree({
	items,
	locale,
	onReorder,
	onEdit,
	onAddInside,
	onDelete,
}: MenuTreeProps) {
	const { t } = useLingui();
	const [activeId, setActiveId] = React.useState<string | null>(null);
	const [overId, setOverId] = React.useState<string | null>(null);
	const [offset, setOffset] = React.useState(0);
	const [moveMessage, setMoveMessage] = React.useState("");
	const rtl = React.useRef(false);
	const refocus = React.useRef<{ id: string; selector: string } | null>(null);
	const lastAnnounced = React.useRef("");

	// A moved row's node is re-inserted in the list, which drops focus from its controls.
	React.useLayoutEffect(() => {
		const target = refocus.current;
		if (!target) return;
		refocus.current = null;
		document
			.querySelector<HTMLElement>(`[data-menu-item-id="${target.id}"] ${target.selector}`)
			?.focus();
	}, [items]);

	const flat = React.useMemo(() => flattenMenu(items), [items]);
	const visible = React.useMemo(
		() => (activeId ? removeChildrenOf(flat, [activeId]) : flat),
		[flat, activeId],
	);
	const sortedIds = React.useMemo(() => visible.map((entry) => entry.id), [visible]);
	const moves = React.useMemo(
		() => new Map(flat.map((entry) => [entry.id, availableMoves(items, entry.id)])),
		[flat, items],
	);
	const activeMaxDepth = activeId ? deepestAllowedDepth(flat, activeId) : MAX_DEPTH - 1;

	const dragState: DragState = {
		items,
		visible,
		offset,
		maxDepth: activeMaxDepth,
		rtl: rtl.current,
	};
	const drag = React.useRef(dragState);
	drag.current = dragState;
	const projection = activeId && overId ? project(dragState, activeId, overId, offset) : null;

	const [coordinateGetter] = React.useState(() => treeKeyboardCoordinates(drag));
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter }),
	);

	const describe = React.useCallback(
		(next: readonly MenuItem[], id: string, dropped: boolean) => {
			const item = next.find((candidate) => candidate.id === id);
			if (!item) return undefined;
			const siblings = next.filter((candidate) => candidate.parentId === item.parentId);
			const position = siblings.indexOf(item) + 1;
			const count = siblings.length;
			const label = item.label;
			const parent = next.find((candidate) => candidate.id === item.parentId)?.label;
			if (parent !== undefined) {
				return dropped
					? t`Dropped ${label} inside ${parent}, position ${position} of ${count}.`
					: t`${label} is inside ${parent}, position ${position} of ${count}.`;
			}
			return dropped
				? t`Dropped ${label} at the top level, position ${position} of ${count}.`
				: t`${label} is at the top level, position ${position} of ${count}.`;
		},
		[t],
	);

	const accessibility = React.useMemo(() => {
		const labelOf = (id: UniqueIdentifier) =>
			drag.current.items.find((item) => item.id === String(id))?.label ?? "";

		const describeDrop = (
			activeKey: UniqueIdentifier,
			overKey: UniqueIdentifier,
			dropped: boolean,
		) => {
			const current = project(drag.current, activeKey, overKey, drag.current.offset);
			if (!current) return undefined;
			const next = applyDrop(
				drag.current.items,
				String(activeKey),
				String(overKey),
				current.parentId,
			);
			return describe(next, String(activeKey), dropped);
		};

		const moved: Announcements["onDragOver"] = ({ active, over }) => {
			if (!over) return undefined;
			const current = project(drag.current, active.id, over.id, drag.current.offset);
			const key = `${over.id}:${current?.parentId}:${current?.depth}`;
			if (key === lastAnnounced.current) return undefined;
			lastAnnounced.current = key;
			return describeDrop(active.id, over.id, false);
		};

		const cancelled = (id: UniqueIdentifier) => {
			const label = labelOf(id);
			return t`Cancelled. ${label} is back where it was.`;
		};

		const announcements: Announcements = {
			onDragStart: ({ active }) => {
				const label = labelOf(active.id);
				return t`Picked up ${label}.`;
			},
			onDragMove: moved,
			onDragOver: moved,
			onDragEnd: ({ active, over }) => {
				if (!over) {
					const label = labelOf(active.id);
					return t`Dropped ${label}.`;
				}
				return describeDrop(active.id, over.id, true) ?? cancelled(active.id);
			},
			onDragCancel: ({ active }) => cancelled(active.id),
		};
		return {
			announcements,
			screenReaderInstructions: {
				draggable: t`To pick up an item, press Space. Use the up and down arrow keys to move it and the left and right arrow keys to change how deeply it is nested. Press Space again to drop it, or Escape to cancel.`,
			},
		};
	}, [describe, t]);

	const reset = () => {
		setActiveId(null);
		setOverId(null);
		setOffset(0);
		lastAnnounced.current = "";
		document.body.style.removeProperty("cursor");
	};

	const handleDragStart = ({ active }: DragStartEvent) => {
		rtl.current = document.documentElement.dir === "rtl";
		setActiveId(String(active.id));
		setOverId(String(active.id));
		document.body.style.setProperty("cursor", "grabbing");
	};

	const handleDragMove = ({ delta }: DragMoveEvent) => {
		// The announcement for this move runs before the next render updates the ref.
		drag.current.offset = delta.x;
		setOffset(delta.x);
	};

	const handleDragEnd = ({ active, over, delta, activatorEvent }: DragEndEvent) => {
		const current = over ? project(drag.current, active.id, over.id, delta.x) : null;
		reset();
		if (!over || !current) return;
		const next = applyDrop(items, String(active.id), String(over.id), current.parentId);
		if (placesOf(flat) === placesOf(flattenMenu(next))) return;
		if (activatorEvent instanceof KeyboardEvent) {
			refocus.current = { id: String(active.id), selector: "[data-drag-handle]" };
		}
		onReorder(next);
	};

	const handleMove = (item: MenuItem, move: MenuMove) => {
		const next = applyMove(items, item.id, move);
		if (!next) return;
		onReorder(next);
		setMoveMessage(describe(next, item.id, false) ?? "");
		refocus.current = { id: item.id, selector: '[aria-haspopup="menu"]' };
	};

	const activeEntry = activeId ? flat.find((entry) => entry.id === activeId) : undefined;
	const liftedDepth = projection?.depth ?? activeEntry?.depth ?? 0;
	const visibleIds = new Set(sortedIds);
	const activeChildren = activeEntry ? flat.filter((entry) => !visibleIds.has(entry.id)) : [];

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			measuring={measuring}
			accessibility={accessibility}
			onDragStart={handleDragStart}
			onDragMove={handleDragMove}
			onDragOver={({ over }) => setOverId(over ? String(over.id) : null)}
			onDragEnd={handleDragEnd}
			onDragCancel={reset}
		>
			<SortableContext items={sortedIds} strategy={verticalListSortingStrategy}>
				<ul
					aria-label={t`Menu items`}
					className="@container/menu-items rounded-xl bg-kumo-base ring ring-kumo-line [&>li:first-child>div]:rounded-t-xl [&>li:last-child>div]:rounded-b-xl [&>li:not(:last-child)]:border-b [&>li]:border-kumo-line"
				>
					{visible.map((entry) => (
						<SortableMenuRow
							key={entry.id}
							entry={entry}
							locale={locale}
							depth={entry.id === activeId && projection ? projection.depth : entry.depth}
							canDrop={entry.id !== activeId || projection !== null}
							moves={moves.get(entry.id)!}
							canAddInside={entry.depth < MAX_DEPTH - 1}
							onEdit={() => onEdit(entry.item)}
							onAddInside={() => onAddInside(entry.item)}
							onDelete={() => onDelete(entry.item)}
							onMove={(move) => handleMove(entry.item, move)}
						/>
					))}
				</ul>
			</SortableContext>
			<DragOverlay dropAnimation={dropAnimation} modifiers={[lockToVerticalAxis]}>
				{activeEntry ? (
					<div
						aria-hidden="true"
						className="@container/menu-items cursor-grabbing overflow-hidden rounded-xl bg-kumo-base shadow-lg ring ring-kumo-line"
					>
						<div className={ROW_CLASS}>
							<span className="grid size-7 shrink-0 place-items-center text-kumo-default">
								<DotsSixVertical size={16} weight="bold" />
							</span>
							<MenuItemRowBody item={activeEntry.item} depth={liftedDepth} locale={locale} />
						</div>
						{activeChildren.map((child) => (
							<div key={child.id} className={cn(ROW_CLASS, "border-t border-kumo-line")}>
								<span className="size-7 shrink-0" />
								<MenuItemRowBody
									item={child.item}
									depth={liftedDepth + child.depth - activeEntry.depth}
									locale={locale}
								/>
							</div>
						))}
					</div>
				) : null}
			</DragOverlay>
			<p className="sr-only" aria-live="polite">
				{moveMessage}
			</p>
		</DndContext>
	);
}

function SortableMenuRow({
	entry,
	depth,
	canDrop,
	locale,
	moves,
	canAddInside,
	onEdit,
	onAddInside,
	onDelete,
	onMove,
}: {
	entry: FlatMenuItem;
	depth: number;
	canDrop: boolean;
	locale?: string;
	moves: Record<MenuMove, boolean>;
	canAddInside: boolean;
	onEdit: () => void;
	onAddInside: () => void;
	onDelete: () => void;
	onMove: (move: MenuMove) => void;
}) {
	const { t } = useLingui();
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: entry.id,
		transition: { duration: 200, easing: EASE_OUT },
		attributes: { roleDescription: t`sortable` },
	});
	const label = entry.item.label;

	return (
		<li
			ref={setNodeRef}
			data-menu-item-id={entry.id}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className="relative motion-reduce:transition-none"
		>
			<div
				className={cn(
					ROW_CLASS,
					"group/row",
					isDragging
						? "[&>*]:opacity-0"
						: "[@media(hover:hover)]:hover:bg-[color-mix(in_srgb,var(--color-kumo-tint)_40%,var(--color-kumo-base))]",
				)}
			>
				<Button
					ref={setActivatorNodeRef}
					variant="ghost"
					size="sm"
					shape="square"
					{...attributes}
					{...listeners}
					data-drag-handle=""
					aria-label={t`Move ${label}`}
					className="relative z-10 size-7 shrink-0 cursor-grab touch-none text-kumo-subtle opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-kumo-default"
					icon={<DotsSixVertical size={16} weight="bold" aria-hidden="true" />}
				/>
				<MenuItemRowBody
					item={entry.item}
					depth={depth}
					locale={locale}
					onEdit={onEdit}
					actions={
						<RowActionsMenu label={t`Actions for ${label}`}>
							<DropdownMenu.Item
								icon={<PencilSimple className="size-4" aria-hidden="true" />}
								onClick={onEdit}
							>
								{t`Edit`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<Plus className="size-4" aria-hidden="true" />}
								disabled={!canAddInside}
								onClick={onAddInside}
							>
								{t`Add item inside`}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								icon={<ArrowUp className="size-4" aria-hidden="true" />}
								disabled={!moves.up}
								onClick={() => onMove("up")}
							>
								{t`Move up`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<ArrowDown className="size-4" aria-hidden="true" />}
								disabled={!moves.down}
								onClick={() => onMove("down")}
							>
								{t`Move down`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<TextIndent className="size-4 rtl:-scale-x-100" aria-hidden="true" />}
								disabled={!moves.indent}
								onClick={() => onMove("indent")}
							>
								{t`Indent`}
							</DropdownMenu.Item>
							<DropdownMenu.Item
								icon={<TextOutdent className="size-4 rtl:-scale-x-100" aria-hidden="true" />}
								disabled={!moves.outdent}
								onClick={() => onMove("outdent")}
							>
								{t`Outdent`}
							</DropdownMenu.Item>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								variant="danger"
								icon={<Trash className="size-4" aria-hidden="true" />}
								onClick={onDelete}
							>
								{t`Delete`}
							</DropdownMenu.Item>
						</RowActionsMenu>
					}
				/>
			</div>
			{isDragging && canDrop && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-y-1.5 end-1.5 rounded-lg bg-kumo-tint outline-2 -outline-offset-2 outline-dashed outline-kumo-brand"
					style={{ insetInlineStart: HANDLE_COLUMN - 8 + depth * INDENT_WIDTH }}
				/>
			)}
		</li>
	);
}
