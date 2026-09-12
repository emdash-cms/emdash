import {
	closestCenter,
	type CollisionDetection,
	DndContext,
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	MeasuringStrategy,
	type Modifier,
	PointerSensor,
	pointerWithin,
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
const COLLAPSED_SECTION_HEIGHT = 48;
const SECTION_ANIMATION_DURATION = 180;
const SECTION_ANIMATION_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

type SortAnimationPhase = "preparing" | "collapsed" | "expanding";

interface SortAnimationState {
	phase: SortAnimationPhase;
	heights: Map<ContentSettingsSectionId, number>;
	anchorOffset: number;
}

const restrictToVerticalAxis: Modifier = ({ transform }) => ({
	...transform,
	x: 0,
});

const sectionCollisionDetection: CollisionDetection = (args) => {
	const pointerCollisions = pointerWithin(args);
	return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

export interface SortableContentSettingsSectionProps {
	id: ContentSettingsSectionId;
	label: string;
	/** Leaves room for an existing disclosure chevron at the inline end. */
	disclosure?: boolean;
	children: React.ReactNode;
	/** Internal state supplied by the sortable group while any section is moving. */
	isSorting?: boolean;
	sortAnimationPhase?: SortAnimationPhase;
	expandedHeight?: number;
	registerNode?: (id: ContentSettingsSectionId, node: HTMLElement | null) => void;
}

interface SortableContentSettingsSectionsProps {
	collection: string;
	userId?: string;
	onSortingChange?: (isSorting: boolean) => void;
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
	onSortingChange,
	children,
}: SortableContentSettingsSectionsProps) {
	const storageKey = userId
		? `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(collection)}`
		: null;
	// Keep the server and first client render identical. Browser preferences
	// are restored after hydration so a saved order cannot cause a mismatch.
	const [storedLayout, setStoredLayout] = React.useState<ContentSettingsLayout | null>(null);
	const [sortAnimation, setSortAnimation] = React.useState<SortAnimationState | null>(null);
	const sectionNodesRef = React.useRef(new Map<ContentSettingsSectionId, HTMLElement>());
	const listRef = React.useRef<HTMLDivElement>(null);
	const animationFrameRef = React.useRef<number | null>(null);
	const finishTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	React.useEffect(() => {
		setStoredLayout(readStoredLayout(storageKey));
	}, [storageKey]);

	const sectionsById = React.useMemo(() => {
		const sections = React.Children.toArray(children).filter(
			(child): child is React.ReactElement<SortableContentSettingsSectionProps> =>
				React.isValidElement<SortableContentSettingsSectionProps>(child),
		);
		return new Map(sections.map((section) => [section.props.id, section]));
	}, [children]);
	const sectionIds = React.useMemo(() => [...sectionsById.keys()], [sectionsById]);
	const layout = React.useMemo(
		() => resolveContentSettingsLayout(storedLayout, sectionIds),
		[sectionIds, storedLayout],
	);
	const visibleIds = React.useMemo(
		() => layout.order.filter((id) => sectionsById.has(id)),
		[layout.order, sectionsById],
	);
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const registerNode = React.useCallback(
		(id: ContentSettingsSectionId, node: HTMLElement | null) => {
			if (node) sectionNodesRef.current.set(id, node);
			else sectionNodesRef.current.delete(id);
		},
		[],
	);
	const finishExpansion = React.useCallback(() => {
		if (finishTimerRef.current !== null) {
			clearTimeout(finishTimerRef.current);
			finishTimerRef.current = null;
		}
		setSortAnimation(null);
		onSortingChange?.(false);
	}, [onSortingChange]);
	const beginExpansion = React.useCallback(() => {
		setSortAnimation((current) =>
			current
				? {
						...current,
						phase: "expanding",
					}
				: null,
		);
		if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
		finishTimerRef.current = setTimeout(finishExpansion, SECTION_ANIMATION_DURATION + 50);
	}, [finishExpansion]);

	React.useLayoutEffect(() => {
		if (sortAnimation?.phase !== "preparing") return;
		void listRef.current?.offsetHeight;
		animationFrameRef.current = window.requestAnimationFrame(() => {
			setSortAnimation((current) =>
				current?.phase === "preparing" ? { ...current, phase: "collapsed" } : current,
			);
		});
		return () => {
			if (animationFrameRef.current !== null) {
				window.cancelAnimationFrame(animationFrameRef.current);
				animationFrameRef.current = null;
			}
		};
	}, [sortAnimation?.phase]);

	React.useEffect(
		() => () => {
			if (animationFrameRef.current !== null) {
				window.cancelAnimationFrame(animationFrameRef.current);
			}
			if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
		},
		[],
	);

	const handleDragStart = React.useCallback(
		(event: DragStartEvent) => {
			const movedId = String(event.active.id);
			const heights = new Map<ContentSettingsSectionId, number>();
			for (const id of visibleIds) {
				const node = sectionNodesRef.current.get(id);
				const height = node?.getBoundingClientRect().height ?? COLLAPSED_SECTION_HEIGHT;
				heights.set(id, Math.max(height, COLLAPSED_SECTION_HEIGHT));
			}
			const activeIndex = visibleIds.indexOf(movedId);
			const anchorOffset = visibleIds
				.slice(0, Math.max(activeIndex, 0))
				.reduce(
					(total, id) =>
						total + (heights.get(id) ?? COLLAPSED_SECTION_HEIGHT) - COLLAPSED_SECTION_HEIGHT,
					0,
				);

			setSortAnimation({ phase: "preparing", heights, anchorOffset });
			onSortingChange?.(true);
		},
		[onSortingChange, visibleIds],
	);
	const handleDragCancel = React.useCallback(() => {
		beginExpansion();
	}, [beginExpansion]);

	const handleDragEnd = React.useCallback(
		(event: DragEndEvent) => {
			if (event.over && event.active.id !== event.over.id) {
				const movedId = String(event.active.id);
				const overId = String(event.over.id);
				setStoredLayout((current) => {
					const next = reorderContentSettingsLayout(
						resolveContentSettingsLayout(current, sectionIds),
						movedId,
						overId,
					);
					writeStoredLayout(storageKey, next);
					return next;
				});
			}
			beginExpansion();
		},
		[beginExpansion, sectionIds, storageKey],
	);
	const listAnchorOffset = sortAnimation?.phase === "collapsed" ? sortAnimation.anchorOffset : 0;
	const listStyle = {
		"--sort-anchor-offset": `${listAnchorOffset}px`,
		transform: "translate3d(0, var(--sort-anchor-offset), 0)",
		transition:
			sortAnimation && sortAnimation.phase !== "preparing"
				? `transform ${SECTION_ANIMATION_DURATION}ms ${SECTION_ANIMATION_EASING}`
				: "none",
	} as React.CSSProperties;
	const handleTransitionEnd = React.useCallback(
		(event: React.TransitionEvent<HTMLDivElement>) => {
			if (
				sortAnimation?.phase === "expanding" &&
				(event.propertyName === "transform" || event.propertyName === "height")
			) {
				finishExpansion();
			}
		},
		[finishExpansion, sortAnimation?.phase],
	);

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={sectionCollisionDetection}
			modifiers={[restrictToVerticalAxis]}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragCancel={handleDragCancel}
			onDragEnd={handleDragEnd}
		>
			<div
				ref={listRef}
				data-sortable-sections
				style={listStyle}
				onTransitionEnd={handleTransitionEnd}
				className="motion-reduce:transition-none"
			>
				<SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
					{visibleIds.map((id) => {
						const section = sectionsById.get(id);
						return section
							? React.cloneElement(section, {
									key: id,
									isSorting: sortAnimation !== null,
									sortAnimationPhase: sortAnimation?.phase,
									expandedHeight: sortAnimation?.heights.get(id),
									registerNode,
								})
							: null;
					})}
				</SortableContext>
			</div>
		</DndContext>
	);
}

export function SortableContentSettingsSection({
	id,
	label,
	disclosure = false,
	children,
	isSorting = false,
	sortAnimationPhase,
	expandedHeight,
	registerNode,
}: SortableContentSettingsSectionProps) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id,
	});
	const setSectionNodeRef = React.useCallback(
		(node: HTMLElement | null) => {
			setNodeRef(node);
			registerNode?.(id, node);
		},
		[id, registerNode, setNodeRef],
	);
	const sectionHeight =
		sortAnimationPhase === "collapsed" ? COLLAPSED_SECTION_HEIGHT : expandedHeight;
	const style: React.CSSProperties = {
		transform: transform
			? CSS.Transform.toString({ ...transform, x: 0, scaleX: 1, scaleY: 1 })
			: undefined,
		transition: [
			transition,
			isSorting && sortAnimationPhase !== "preparing"
				? `height ${SECTION_ANIMATION_DURATION}ms ${SECTION_ANIMATION_EASING}`
				: null,
		]
			.filter(Boolean)
			.join(", "),
		zIndex: isDragging ? 10 : undefined,
		inlineSize: "100%",
		height: isSorting && sectionHeight ? sectionHeight : undefined,
	};

	return (
		<section
			ref={setSectionNodeRef}
			style={style}
			data-sortable-section={id}
			data-sorting={isSorting ? "true" : "false"}
			data-sort-animation={sortAnimationPhase}
			data-disclosure={disclosure ? "true" : "false"}
			className={cn(
				"relative min-w-0 border-t bg-kumo-base first:border-t-0",
				isSorting &&
					"overflow-hidden [&>*:not([data-sortable-heading]):not([data-sortable-handle])]:invisible [&>*:not([data-sortable-heading]):not([data-sortable-handle])]:pointer-events-none",
				isDragging && "bg-kumo-tint opacity-60",
				"motion-reduce:transition-none",
			)}
		>
			{isSorting && (
				<div
					data-sortable-heading
					aria-hidden="true"
					className="absolute inset-x-0 top-0 flex h-12 items-center px-4 pe-12"
					style={{ minHeight: 48 }}
				>
					<span className="text-[15px] font-semibold">{label}</span>
				</div>
			)}
			{children}
			<button
				type="button"
				data-sortable-handle
				data-sorting={isSorting ? "true" : "false"}
				{...attributes}
				{...listeners}
				className={cn(
					"absolute z-10 grid size-7 touch-none cursor-grab place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-accent active:cursor-grabbing",
					"end-5",
					isSorting ? "top-6 -translate-y-1/2" : disclosure ? "top-5" : "top-3",
				)}
				aria-label={t`Drag to reorder ${label}`}
				title={t`Drag to reorder ${label}`}
			>
				<DotsSixVertical size={16} aria-hidden="true" />
			</button>
		</section>
	);
}
