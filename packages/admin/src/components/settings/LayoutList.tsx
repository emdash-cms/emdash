import { Button, Switch, Tooltip } from "@cloudflare/kumo";
import {
	closestCenter,
	defaultDropAnimationSideEffects,
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type Announcements,
	type DragEndEvent,
	type DragStartEvent,
	type DropAnimation,
	type Modifier,
	type UniqueIdentifier,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowDown, ArrowUp, DotsSixVertical } from "@phosphor-icons/react";
import * as React from "react";

import type { ArrangedNavFolder, ArrangedRow } from "../../lib/admin-layout.js";
import { cn } from "../../lib/utils.js";
import { ADMIN_NAV_ICONS, resolveNavIcon } from "../admin-navigation-icons.js";
import { Kbd } from "../Kbd.js";
import { NavIcon } from "../Sidebar.js";

export interface LayoutRowItem {
	readonly id: string;
	readonly label: string;
	readonly icon?: React.ElementType;
	/** Secondary text at the inline end, such as the contributing plugin's name. */
	readonly meta?: string;
}

export type LayoutEntry<T extends LayoutRowItem> = ArrangedRow<T> | ArrangedNavFolder<T>;

interface LayoutListProps<T extends LayoutRowItem> {
	/** The list's accessible name. */
	label: string;
	entries: readonly LayoutEntry<T>[];
	disabled: boolean;
	onToggle: (id: string, visible: boolean) => void;
	/** `activeId` takes `overId`'s place among its siblings. */
	onMove: (activeId: string, overId: string) => void;
}

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

const ROW_CLASS =
	"group/row relative flex h-9 select-none items-center gap-2.5 rounded-lg px-2 pointer-coarse:h-11";

const dropAnimation: DropAnimation = {
	duration: 200,
	easing: EASE_OUT,
	sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
};

const restrictToList: Modifier = ({ transform, draggingNodeRect, containerNodeRect }) => {
	if (!draggingNodeRect || !containerNodeRect) return { ...transform, x: 0 };
	const minY = containerNodeRect.top - draggingNodeRect.top;
	const maxY = containerNodeRect.bottom - draggingNodeRect.bottom;
	return { ...transform, x: 0, y: Math.min(Math.max(transform.y, minY), maxY) };
};

function isFolder<T extends LayoutRowItem>(entry: LayoutEntry<T>): entry is ArrangedNavFolder<T> {
	return "items" in entry;
}

function entryLabel<T extends LayoutRowItem>(entry: LayoutEntry<T>): string {
	return isFolder(entry) ? entry.label : entry.item.label;
}

function useMediaQuery(query: string): boolean {
	const subscribe = React.useCallback(
		(onChange: () => void) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		[query],
	);
	return React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

type DragListeners = ReturnType<typeof useSortable>["listeners"];

const stopPropagation = (event: React.PointerEvent) => event.stopPropagation();

function RowBody<T extends LayoutRowItem>({
	entry,
	handle,
	toggle,
}: {
	entry: LayoutEntry<T>;
	handle: React.ReactNode;
	toggle: React.ReactNode;
}) {
	const icon = isFolder(entry)
		? resolveNavIcon(entry.iconName, ADMIN_NAV_ICONS.folder)
		: entry.item.icon;
	const meta = isFolder(entry) ? undefined : entry.item.meta;
	return (
		<>
			{icon && (
				<NavIcon
					icon={icon}
					isActive={false}
					className={cn(
						"size-4 shrink-0",
						entry.hidden ? "text-kumo-inactive" : "text-kumo-subtle",
					)}
				/>
			)}
			<span className={cn("min-w-0 flex-1 truncate text-base", entry.hidden && "text-kumo-subtle")}>
				{entryLabel(entry)}
			</span>
			{meta && <span className="hidden shrink-0 text-sm text-kumo-subtle sm:inline">{meta}</span>}
			<span className="grid size-6 shrink-0 place-items-center">{handle}</span>
			{/* A press on the switch must never start a drag. */}
			<span className="flex w-8 shrink-0 items-center" onPointerDown={stopPropagation}>
				{toggle}
			</span>
		</>
	);
}

function RowSwitch<T extends LayoutRowItem>({
	row,
	disabled,
	onToggle,
}: {
	row: ArrangedRow<T>;
	disabled: boolean;
	onToggle: (id: string, visible: boolean) => void;
}) {
	const { t } = useLingui();
	const label = row.item.label;
	if (!row.canHide) {
		return (
			<Switch
				size="sm"
				variant="neutral"
				checked
				disabled
				aria-label={t`${label} is always shown`}
				title={t`Always shown`}
			/>
		);
	}
	return (
		<Switch
			size="sm"
			variant="neutral"
			checked={!row.hidden}
			disabled={disabled}
			onCheckedChange={(checked) => onToggle(row.id, checked)}
			aria-label={t`Show ${label}`}
		/>
	);
}

interface EntryProps<T extends LayoutRowItem> {
	entry: LayoutEntry<T>;
	disabled: boolean;
	onToggle: (id: string, visible: boolean) => void;
	onMove: (activeId: string, overId: string) => void;
}

function EntryItem<T extends LayoutRowItem>({
	entry,
	disabled,
	onToggle,
	onMove,
	nodeRef,
	style,
	placeholder = false,
	rowListeners,
	handle = null,
}: EntryProps<T> & {
	nodeRef?: (node: HTMLElement | null) => void;
	style?: React.CSSProperties;
	placeholder?: boolean;
	rowListeners?: DragListeners;
	handle?: React.ReactNode;
}) {
	return (
		<li
			ref={nodeRef}
			style={style}
			className={cn("grid gap-px rounded-lg", placeholder && "bg-kumo-tint [&>*]:invisible")}
		>
			<div
				{...rowListeners}
				className={cn(
					ROW_CLASS,
					rowListeners && "cursor-grab",
					!placeholder && "hover:bg-kumo-tint",
				)}
			>
				<RowBody
					entry={entry}
					handle={handle}
					toggle={
						isFolder(entry) ? null : (
							<RowSwitch row={entry} disabled={disabled} onToggle={onToggle} />
						)
					}
				/>
			</div>
			{isFolder(entry) && (
				<div className="ps-6.5">
					<LayoutList
						label={entry.label}
						entries={entry.items}
						disabled={disabled}
						onToggle={onToggle}
						onMove={onMove}
					/>
				</div>
			)}
		</li>
	);
}

function SortableEntry<T extends LayoutRowItem>({
	coarsePointer,
	reduceMotion,
	registerHandle,
	onStep,
	...props
}: EntryProps<T> & {
	coarsePointer: boolean;
	reduceMotion: boolean;
	registerHandle: (id: string, node: HTMLButtonElement | null) => void;
	onStep: (delta: -1 | 1) => void;
}) {
	const { t } = useLingui();
	const { entry, disabled } = props;
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
		disabled,
		transition: reduceMotion ? null : { duration: 200, easing: EASE_OUT },
		attributes: { roleDescription: t`sortable` },
	});
	const { onKeyDown, ...pointerListeners } = listeners ?? {};
	const handleRef = React.useCallback(
		(node: HTMLButtonElement | null) => {
			setActivatorNodeRef(node);
			registerHandle(entry.id, node);
		},
		[entry.id, registerHandle, setActivatorNodeRef],
	);
	const label = entryLabel(entry);

	return (
		<EntryItem
			{...props}
			nodeRef={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			placeholder={isDragging}
			rowListeners={coarsePointer || disabled ? undefined : pointerListeners}
			handle={
				<Tooltip
					side="top"
					content={
						<span className="flex items-center gap-1.5 whitespace-nowrap">
							<Trans>
								Drag, or press{" "}
								<Kbd>
									Alt <ArrowUp size={12} weight="bold" role="img" aria-label={t`Up arrow`} />
								</Kbd>{" "}
								<Kbd>
									Alt <ArrowDown size={12} weight="bold" role="img" aria-label={t`Down arrow`} />
								</Kbd>
							</Trans>
						</span>
					}
					render={
						<Button
							ref={handleRef}
							variant="ghost"
							size="sm"
							shape="square"
							{...attributes}
							{...(coarsePointer ? pointerListeners : {})}
							disabled={disabled}
							onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) => {
								if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
									event.preventDefault();
									onStep(event.key === "ArrowUp" ? -1 : 1);
									return;
								}
								onKeyDown?.(event);
							}}
							aria-label={t`Reorder ${label}`}
							className={cn(
								"size-6 cursor-grab touch-none text-kumo-subtle hover:text-kumo-default",
								!coarsePointer && "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
							)}
							icon={<DotsSixVertical size={16} weight="bold" aria-hidden="true" />}
						/>
					}
				/>
			}
		/>
	);
}

function OverlayEntry<T extends LayoutRowItem>({ entry }: { entry: LayoutEntry<T> }) {
	const handle = (
		<span className="grid size-6 place-items-center text-kumo-default">
			<DotsSixVertical size={16} weight="bold" aria-hidden="true" />
		</span>
	);
	const row = (
		<div className={ROW_CLASS}>
			<RowBody
				entry={entry}
				handle={handle}
				toggle={
					isFolder(entry) ? null : (
						<Switch size="sm" variant="neutral" checked={!entry.hidden} tabIndex={-1} />
					)
				}
			/>
		</div>
	);
	return (
		<div
			aria-hidden="true"
			className="grid cursor-grabbing gap-px rounded-lg bg-kumo-base shadow-lg ring ring-kumo-line"
		>
			{row}
			{isFolder(entry) && (
				<div className="grid gap-px ps-6.5">
					{entry.items.map((member) => (
						<div key={member.id} className={ROW_CLASS}>
							<RowBody
								entry={member}
								handle={null}
								toggle={
									<Switch size="sm" variant="neutral" checked={!member.hidden} tabIndex={-1} />
								}
							/>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * One sibling set as a reorderable list with its own `DndContext`, so a row
 * can't leave its group or folder. Fine pointers drag from anywhere on the
 * row; coarse pointers drag from the handle, so a swipe still scrolls.
 * Alt+ArrowUp and Alt+ArrowDown on a handle move the row one place at once.
 */
export function LayoutList<T extends LayoutRowItem>({
	label: listLabel,
	entries,
	disabled,
	onToggle,
	onMove,
}: LayoutListProps<T>) {
	const { t } = useLingui();
	const ids = React.useMemo(
		() => entries.filter((entry) => entry.canMove).map((entry) => entry.id),
		[entries],
	);
	const coarsePointer = useMediaQuery("(pointer: coarse)");
	const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
	const [activeId, setActiveId] = React.useState<string | null>(null);
	const [stepMessage, setStepMessage] = React.useState("");
	const handles = React.useRef(new Map<string, HTMLButtonElement>());
	const refocus = React.useRef<string | null>(null);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const registerHandle = React.useCallback((id: string, node: HTMLButtonElement | null) => {
		if (node) handles.current.set(id, node);
		else handles.current.delete(id);
	}, []);

	// React may re-insert the moved row's node, which drops its focus.
	React.useLayoutEffect(() => {
		if (!refocus.current) return;
		handles.current.get(refocus.current)?.focus();
		refocus.current = null;
	});

	const labelOf = React.useCallback(
		(id: UniqueIdentifier) => {
			const entry = entries.find((candidate) => candidate.id === String(id));
			return entry ? entryLabel(entry) : String(id);
		},
		[entries],
	);

	const count = entries.length;
	const positionOf = React.useCallback(
		(id: UniqueIdentifier) => entries.findIndex((entry) => entry.id === String(id)) + 1,
		[entries],
	);

	const accessibility = React.useMemo(() => {
		const announcements: Announcements = {
			onDragStart: ({ active }) => {
				const label = labelOf(active.id);
				const position = positionOf(active.id);
				return t`Picked up ${label}, position ${position} of ${count}.`;
			},
			onDragOver: ({ active, over }) => {
				if (!over || over.id === active.id) return undefined;
				const label = labelOf(active.id);
				const position = positionOf(over.id);
				return t`${label} moved to position ${position} of ${count}.`;
			},
			onDragEnd: ({ active, over }) => {
				const label = labelOf(active.id);
				if (!over) return t`Dropped ${label}.`;
				const position = positionOf(over.id);
				return t`Dropped ${label} at position ${position} of ${count}.`;
			},
			onDragCancel: ({ active }) => {
				const label = labelOf(active.id);
				const position = positionOf(active.id);
				return t`Cancelled. ${label} is back at position ${position} of ${count}.`;
			},
		};
		return {
			announcements,
			screenReaderInstructions: {
				draggable: t`To pick up an item, press Space or Enter. Use the up and down arrow keys to move it, then press Space or Enter to drop it, or Escape to cancel. Alt with the up or down arrow moves it one place right away.`,
			},
		};
	}, [count, positionOf, labelOf, t]);

	const step = (id: string, delta: -1 | 1) => {
		if (activeId !== null) return;
		const from = ids.indexOf(id);
		const to = from + delta;
		const overId = ids[to];
		if (from === -1 || overId === undefined) return;
		refocus.current = id;
		onMove(id, overId);
		const label = labelOf(id);
		const position = positionOf(overId);
		setStepMessage(t`${label} moved to position ${position} of ${count}.`);
	};

	const handleDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
	const handleDragEnd = (event: DragEndEvent) => {
		setActiveId(null);
		if (event.over && event.active.id !== event.over.id) {
			onMove(String(event.active.id), String(event.over.id));
		}
	};
	const activeEntry = activeId ? entries.find((entry) => entry.id === activeId) : undefined;

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			modifiers={[restrictToList]}
			accessibility={accessibility}
			onDragStart={handleDragStart}
			onDragCancel={() => setActiveId(null)}
			onDragEnd={handleDragEnd}
		>
			<SortableContext items={ids} strategy={verticalListSortingStrategy}>
				<ul aria-label={listLabel} className="grid gap-px">
					{entries.map((entry) =>
						entry.canMove ? (
							<SortableEntry
								key={entry.id}
								entry={entry}
								disabled={disabled}
								onToggle={onToggle}
								onMove={onMove}
								coarsePointer={coarsePointer}
								reduceMotion={reduceMotion}
								registerHandle={registerHandle}
								onStep={(delta) => step(entry.id, delta)}
							/>
						) : (
							<EntryItem
								key={entry.id}
								entry={entry}
								disabled={disabled}
								onToggle={onToggle}
								onMove={onMove}
							/>
						),
					)}
				</ul>
			</SortableContext>
			<DragOverlay dropAnimation={reduceMotion ? null : dropAnimation}>
				{activeEntry ? <OverlayEntry entry={activeEntry} /> : null}
			</DragOverlay>
			<p className="sr-only" aria-live="polite">
				{stepMessage}
			</p>
		</DndContext>
	);
}
