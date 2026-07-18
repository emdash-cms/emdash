import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	MeasuringStrategy,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	sortableKeyboardCoordinates,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import { DotsSixVertical } from "@phosphor-icons/react";
import * as React from "react";

import {
	parseContentSettingsLayout,
	reorderContentSettingsLayout,
	resolveContentSettingsLayout,
	type ContentSettingsLayout,
	type ContentSettingsSectionId,
} from "../lib/content-settings-layout.js";
import { cn } from "../lib/utils.js";

const STORAGE_PREFIX = "emdash:content-settings-layout:v1";

export interface SortableContentSettingsSectionProps {
	id: ContentSettingsSectionId;
	label: string;
	/** Leaves room for an existing disclosure chevron at the inline end. */
	disclosure?: boolean;
	children: React.ReactNode;
	/** Internal state supplied by the sortable group while any section is moving. */
	isSorting?: boolean;
}

interface SortableContentSettingsSectionsProps {
	collection: string;
	userId?: string;
	children: React.ReactNode;
}

function readStoredLayout(storageKey: string | null): ContentSettingsLayout | null {
	if (!storageKey || typeof window === "undefined") return null;
	try {
		return parseContentSettingsLayout(window.localStorage.getItem(storageKey));
	} catch {
		return null;
	}
}

function writeStoredLayout(storageKey: string | null, layout: ContentSettingsLayout): void {
	if (!storageKey || typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey, JSON.stringify(layout));
	} catch {
		// Browser storage is optional; the reordered in-memory layout still works.
	}
}

export function SortableContentSettingsSections({
	collection,
	userId,
	children,
}: SortableContentSettingsSectionsProps) {
	const storageKey = userId
		? `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(collection)}`
		: null;
	// Keep the server and first client render identical. Browser preferences
	// are restored after hydration so a saved order cannot cause a mismatch.
	const [storedLayout, setStoredLayout] = React.useState<ContentSettingsLayout | null>(null);
	const [activeId, setActiveId] = React.useState<ContentSettingsSectionId | null>(null);

	React.useEffect(() => {
		setStoredLayout(readStoredLayout(storageKey));
	}, [storageKey]);

	const layout = React.useMemo(() => resolveContentSettingsLayout(storedLayout), [storedLayout]);
	const sectionsById = React.useMemo(() => {
		const sections = React.Children.toArray(children).filter(
			(child): child is React.ReactElement<SortableContentSettingsSectionProps> =>
				React.isValidElement<SortableContentSettingsSectionProps>(child),
		);
		return new Map(sections.map((section) => [section.props.id, section]));
	}, [children]);
	const visibleIds = React.useMemo(
		() => layout.order.filter((id) => sectionsById.has(id)),
		[layout.order, sectionsById],
	);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const handleDragStart = React.useCallback((event: DragStartEvent) => {
		setActiveId(String(event.active.id) as ContentSettingsSectionId);
	}, []);

	const handleDragEnd = React.useCallback(
		(event: DragEndEvent) => {
			setActiveId(null);
			if (event.over && event.active.id !== event.over.id) {
				const movedId = String(event.active.id) as ContentSettingsSectionId;
				const overId = String(event.over.id) as ContentSettingsSectionId;
				setStoredLayout((current) => {
					const next = reorderContentSettingsLayout(
						resolveContentSettingsLayout(current),
						movedId,
						overId,
					);
					writeStoredLayout(storageKey, next);
					return next;
				});
			}
		},
		[storageKey],
	);

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCenter}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragCancel={() => setActiveId(null)}
			onDragEnd={handleDragEnd}
		>
			<SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
				{visibleIds.map((id) => {
					const section = sectionsById.get(id);
					return section
						? React.cloneElement(section, { key: id, isSorting: activeId !== null })
						: null;
				})}
			</SortableContext>
		</DndContext>
	);
}

export function SortableContentSettingsSection({
	id,
	label,
	disclosure = false,
	children,
	isSorting = false,
}: SortableContentSettingsSectionProps) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});
	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 10 : undefined,
	};

	return (
		<section
			ref={setNodeRef}
			style={style}
			data-sorting={isSorting ? "true" : "false"}
			className={cn(
				"relative min-w-0 border-t bg-kumo-base first:border-t-0",
				isSorting &&
					"[&>*:not([data-sortable-heading]):not([data-sortable-handle])]:hidden",
				isDragging && "bg-kumo-tint opacity-60",
			)}
		>
			{isSorting && (
				<div
					data-sortable-heading
					className="flex items-center px-4 pe-12"
					style={{ minHeight: 48 }}
				>
					<span className="text-[15px] font-semibold">{label}</span>
				</div>
			)}
			{children}
			<button
				type="button"
				data-sortable-handle
				{...attributes}
				{...listeners}
				className={cn(
					"absolute z-10 grid size-7 touch-none cursor-grab place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-accent active:cursor-grabbing",
					isSorting ? "end-3 top-1/2 -translate-y-1/2" : "top-3",
					!isSorting && (disclosure ? "end-10" : "end-3"),
				)}
				aria-label={t`Drag to reorder ${label}`}
				title={t`Drag to reorder ${label}`}
			>
				<DotsSixVertical size={16} aria-hidden="true" />
			</button>
		</section>
	);
}
