/**
 * Widgets page component
 *
 * Manage widget areas and widgets with drag-and-drop support.
 * Available widgets can be dragged from the palette into widget areas.
 * Widgets within an area can be reordered via drag-and-drop.
 */

import {
	Button,
	Dialog,
	Input,
	Label,
	LayerCard,
	Popover,
	Select,
	Switch,
	Toast,
} from "@cloudflare/kumo";
import {
	DndContext,
	DragOverlay,
	type CollisionDetection,
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	closestCenter,
	rectIntersection,
	useSensor,
	useSensors,
	useDraggable,
	useDroppable,
	PointerSensor,
} from "@dnd-kit/core";
import {
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Article,
	CalendarBlank,
	CaretDown,
	DotsSixVertical,
	Folder,
	Info,
	List,
	MagnifyingGlass,
	Newspaper,
	Plus,
	PuzzlePiece,
	SquaresFour,
	Tag,
	Trash,
	X,
} from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchManifest,
	fetchWidgetAreas,
	fetchWidgetComponents,
	fetchMenus,
	createWidgetArea,
	createWidget,
	updateWidget,
	deleteWidget,
	deleteWidgetArea,
	reorderWidgets,
	type WidgetArea,
	type Widget,
	type WidgetComponent,
	type CreateWidgetInput,
	type UpdateWidgetInput,
} from "../lib/api";
import { getPluginBlocks } from "../lib/pluginBlocks";
import { CaretNext } from "./ArrowIcons.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
import { GalleryDetailPanel } from "./editor/GalleryDetailPanel";
import type { GalleryAttributes } from "./editor/GalleryNode";
import { ImageDetailPanel, type ImageAttributes } from "./editor/ImageDetailPanel";
import {
	PortableTextEditor,
	type BlockSidebarPanel,
	type PluginBlockDef,
} from "./PortableTextEditor";

/** Palette item types that can be dragged into areas */
interface PaletteItemData {
	source: "palette";
	widgetInput: CreateWidgetInput;
	label: string;
	description?: string;
}

interface PaletteWidget {
	id: string;
	label: string;
	description?: string;
	widgetInput: CreateWidgetInput;
}

/** Identifies an existing widget being reordered */
interface ExistingWidgetData {
	source: "area";
	areaName: string;
}

type DragItemData = PaletteItemData | ExistingWidgetData;

function isPaletteItem(data: DragItemData): data is PaletteItemData {
	return data.source === "palette";
}

/** Built-in widget types available in the palette */
const BUILTIN_WIDGETS: Array<{
	id: string;
	label: MessageDescriptor;
	description: MessageDescriptor;
	input: CreateWidgetInput;
}> = [
	{
		id: "palette-content",
		label: msg`Content Block`,
		description: msg`Rich text content`,
		input: { type: "content" },
	},
	{
		id: "palette-menu",
		label: msg`Menu`,
		description: msg`Display a navigation menu`,
		input: { type: "menu" },
	},
];

/**
 * Localized labels/descriptions for built-in core widget components. The server
 * (packages/core/src/widgets/components.ts) ships these in English as stable
 * data; the admin maps them to translated strings client-side, the same way
 * error codes are localized. Plugin-provided components fall back to their
 * server-provided strings.
 */
interface CoreWidgetMeta {
	label: MessageDescriptor;
	description: MessageDescriptor;
	/** Prop-field labels keyed by prop key; `options` localizes select choices by option value. */
	props?: Record<string, { label: MessageDescriptor; options?: Record<string, MessageDescriptor> }>;
}

const CORE_WIDGET_META: Record<string, CoreWidgetMeta> = {
	"core:recent-posts": {
		label: msg`Recent Posts`,
		description: msg`Display a list of recent posts`,
		props: {
			count: { label: msg`Number of posts` },
			showThumbnails: { label: msg`Show thumbnails` },
			showDate: { label: msg`Show date` },
		},
	},
	"core:categories": {
		label: msg`Categories`,
		description: msg`Display category list`,
		props: {
			showCount: { label: msg`Show post count` },
			hierarchical: { label: msg`Show hierarchy` },
		},
	},
	"core:tags": {
		label: msg`Tags`,
		description: msg`Display tag cloud`,
		props: {
			showCount: { label: msg`Show count` },
			limit: { label: msg`Maximum tags` },
		},
	},
	"core:search": {
		label: msg`Search`,
		description: msg`Search form`,
		props: {
			placeholder: { label: msg`Placeholder text` },
		},
	},
	"core:archives": {
		label: msg`Archives`,
		description: msg`Monthly/yearly archives`,
		props: {
			type: {
				label: msg`Group by`,
				options: { monthly: msg`Monthly`, yearly: msg`Yearly` },
			},
			limit: { label: msg`Limit` },
		},
	},
};

const CORE_WIDGET_ICONS: Record<string, React.ElementType> = {
	"core:recent-posts": Newspaper,
	"core:categories": Folder,
	"core:tags": Tag,
	"core:search": MagnifyingGlass,
	"core:archives": CalendarBlank,
};

function WidgetIcon({ type, componentId }: Pick<CreateWidgetInput, "type" | "componentId">) {
	const Icon =
		type === "content"
			? Article
			: type === "menu"
				? List
				: (CORE_WIDGET_ICONS[componentId ?? ""] ?? PuzzlePiece);
	return <Icon className="size-5" aria-hidden="true" />;
}

export function Widgets() {
	const { i18n, t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isCreateAreaOpen, setIsCreateAreaOpen] = React.useState(false);
	const [createAreaError, setCreateAreaError] = React.useState<string | null>(null);
	const [selectedWidget, setSelectedWidget] = React.useState<PaletteItemData | null>(null);
	const [isAddWidgetOpen, setIsAddWidgetOpen] = React.useState(false);
	const [selectedAreaName, setSelectedAreaName] = React.useState("");
	const [widgetSearch, setWidgetSearch] = React.useState("");
	const [isWidgetSearchOpen, setIsWidgetSearchOpen] = React.useState(false);
	const [activeId, setActiveId] = React.useState<string | null>(null);
	const [activeDragData, setActiveDragData] = React.useState<DragItemData | null>(null);
	const [expandedWidgets, setExpandedWidgets] = React.useState<Set<string>>(new Set());
	const [blockSidebarPanel, setBlockSidebarPanel] = React.useState<BlockSidebarPanel | null>(null);
	// Track palette drag source across the full drag lifecycle (including drop animation)
	const draggingFromPaletteRef = React.useRef(false);

	const handleBlockSidebarOpen = React.useCallback((panel: BlockSidebarPanel) => {
		setBlockSidebarPanel((prev) => {
			// Close any existing panel before opening a new one so only one is ever active
			prev?.onClose();
			return panel;
		});
	}, []);

	const handleBlockSidebarClose = React.useCallback(() => {
		setBlockSidebarPanel((prev) => {
			prev?.onClose();
			return null;
		});
	}, []);

	const { data: areas = [], isLoading } = useQuery({
		queryKey: ["widget-areas"],
		queryFn: fetchWidgetAreas,
	});

	const { data: components = [] } = useQuery({
		queryKey: ["widget-components"],
		queryFn: fetchWidgetComponents,
	});

	const paletteWidgets: PaletteWidget[] = [
		...BUILTIN_WIDGETS.map((item) => {
			const label = t(item.label);
			return {
				id: item.id,
				label,
				description: t(item.description),
				widgetInput: { ...item.input, title: label },
			};
		}),
		...components.map((component) => {
			const meta = CORE_WIDGET_META[component.id];
			const label = meta ? t(meta.label) : component.label;
			return {
				id: `palette-comp-${component.id}`,
				label,
				description: meta ? t(meta.description) : component.description,
				widgetInput: { type: "component" as const, title: label, componentId: component.id },
			};
		}),
	];
	const normalizeSearch = (value: string) => value.normalize("NFC").toLocaleLowerCase(i18n.locale);
	const searchTerm = normalizeSearch(widgetSearch.trim());
	const visiblePaletteWidgets = searchTerm
		? paletteWidgets.filter(
				(widget) =>
					normalizeSearch(widget.label).includes(searchTerm) ||
					(widget.description && normalizeSearch(widget.description).includes(searchTerm)),
			)
		: paletteWidgets;

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
	});

	const pluginBlocks = React.useMemo(() => (manifest ? getPluginBlocks(manifest) : []), [manifest]);

	const createAreaMutation = useMutation({
		mutationFn: createWidgetArea,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			setIsCreateAreaOpen(false);
			toastManager.add({ title: t`Widget area created` });
		},
		onError: (error: Error) => {
			setCreateAreaError(error.message);
		},
	});

	const createWidgetMutation = useMutation({
		mutationFn: ({ areaName, input }: { areaName: string; input: CreateWidgetInput }) =>
			createWidget(areaName, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			setIsAddWidgetOpen(false);
			toastManager.add({ title: t`Widget added` });
		},
	});

	const createDraggedWidgetMutation = useMutation({
		mutationFn: ({ areaName, input }: { areaName: string; input: CreateWidgetInput }) =>
			createWidget(areaName, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			toastManager.add({ title: t`Widget added` });
		},
		onError: (error: Error) => {
			toastManager.add({
				title: t`Error adding widget`,
				description: error.message,
				type: "error",
			});
		},
	});

	const handleSelectWidget = (widget: PaletteItemData) => {
		setSelectedWidget(widget);
		setSelectedAreaName(areas[0]?.name ?? "");
		createWidgetMutation.reset();
		setIsAddWidgetOpen(true);
	};

	const closeAddWidgetDialog = () => {
		if (createWidgetMutation.isPending) return;
		setIsAddWidgetOpen(false);
	};

	const handleAddWidget = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!selectedWidget || !selectedAreaName || createWidgetMutation.isPending) return;
		createWidgetMutation.mutate({ areaName: selectedAreaName, input: selectedWidget.widgetInput });
	};

	const handleCreateArea = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setCreateAreaError(null);
		const formData = new FormData(e.currentTarget);
		const nameVal = formData.get("name");
		const labelVal = formData.get("label");
		const descVal = formData.get("description");
		createAreaMutation.mutate({
			name: typeof nameVal === "string" ? nameVal : "",
			label: typeof labelVal === "string" ? labelVal : "",
			description: typeof descVal === "string" ? descVal : "",
		});
	};

	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	// Custom collision detection: palette items use rectIntersection (anywhere
	// over the area counts) and only match area:* droppables. Existing widgets
	// use closestCenter for precise reorder positioning.
	const collisionDetection: CollisionDetection = React.useCallback((args) => {
		const dragData = args.active.data.current as DragItemData | undefined;
		if (dragData && isPaletteItem(dragData)) {
			// Only consider area droppables, use generous rect intersection
			const areaContainers = args.droppableContainers.filter((c) =>
				String(c.id).startsWith("area:"),
			);
			return rectIntersection({ ...args, droppableContainers: areaContainers });
		}
		return closestCenter(args);
	}, []);

	const handleDragStart = (event: DragStartEvent) => {
		const id = String(event.active.id);
		const data = (event.active.data.current as DragItemData) ?? null;
		setActiveId(id);
		setActiveDragData(data);
		draggingFromPaletteRef.current = data !== null && isPaletteItem(data);
	};

	const reorderMutation = useMutation({
		mutationFn: ({ areaName, widgetIds }: { areaName: string; widgetIds: string[] }) =>
			reorderWidgets(areaName, widgetIds),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
		},
		onError: (error: Error) => {
			toastManager.add({
				title: t`Error reordering widgets`,
				description: error.message,
				type: "error",
			});
		},
	});

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		const dragData = active.data.current as DragItemData | undefined;

		setActiveId(null);
		setActiveDragData(null);

		if (!over || !dragData) return;

		// Case 1: Dragging from palette into an area
		if (isPaletteItem(dragData)) {
			const overId = String(over.id);
			// The drop target is a widget area (droppable id = "area:{name}")
			if (overId.startsWith("area:")) {
				const areaName = overId.slice(5);
				createDraggedWidgetMutation.mutate({
					areaName,
					input: dragData.widgetInput,
				});
			}
			return;
		}

		// Case 2: Reordering within an area
		if (active.id === over.id) return;

		const sourceArea = areas.find((area) => area.widgets?.some((w) => w.id === active.id));
		if (!sourceArea?.widgets) return;

		const oldIndex = sourceArea.widgets.findIndex((w) => w.id === active.id);
		const newIndex = sourceArea.widgets.findIndex((w) => w.id === over.id);
		if (oldIndex === -1 || newIndex === -1) return;

		const newWidgets = [...sourceArea.widgets];
		const [movedWidget] = newWidgets.splice(oldIndex, 1);
		if (!movedWidget) return;
		newWidgets.splice(newIndex, 0, movedWidget);

		reorderMutation.mutate({
			areaName: sourceArea.name,
			widgetIds: newWidgets.map((w) => w.id),
		});
	};

	const toggleWidget = (widgetId: string) => {
		setExpandedWidgets((prev) => {
			const next = new Set(prev);
			if (next.has(widgetId)) {
				next.delete(widgetId);
			} else {
				next.add(widgetId);
			}
			return next;
		});
	};

	// Build the palette label for the drag overlay
	const activePaletteLabel =
		activeDragData && isPaletteItem(activeDragData) ? activeDragData.label : null;
	// Find the existing widget being dragged for overlay
	const activeWidget =
		activeId && activeDragData && !isPaletteItem(activeDragData)
			? areas.flatMap((a) => a.widgets ?? []).find((w) => w.id === activeId)
			: null;

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-64">
				<div className="text-kumo-subtle">{t`Loading widgets...`}</div>
			</div>
		);
	}

	return (
		<>
			<DndContext
				sensors={sensors}
				collisionDetection={collisionDetection}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
			>
				<div className="space-y-8">
					<header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
						<div className="min-w-0">
							<h1 className="text-2xl font-semibold leading-tight">{t`Widgets`}</h1>
						</div>
						<Dialog.Root
							open={isCreateAreaOpen}
							onOpenChange={(open) => {
								setIsCreateAreaOpen(open);
								if (!open) setCreateAreaError(null);
							}}
						>
							<Dialog.Trigger
								render={(props) => (
									<Button {...props} variant="primary" icon={<Plus aria-hidden="true" />}>
										{t`Add widget area`}
									</Button>
								)}
							/>
							<Dialog className="p-6" size="lg">
								<div className="mb-5 flex items-start justify-between gap-4">
									<div>
										<Dialog.Title className="text-lg font-semibold">{t`Create widget area`}</Dialog.Title>
										<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
											{t`Give this area a name and a label for your editors.`}
										</Dialog.Description>
									</div>
									<Dialog.Close
										aria-label={t`Close`}
										render={(props) => (
											<Button
												{...props}
												variant="ghost"
												shape="square"
												aria-label={t`Close`}
												className="shrink-0"
											>
												<X className="size-4" aria-hidden="true" />
											</Button>
										)}
									/>
								</div>
								<form onSubmit={handleCreateArea} className="space-y-4">
									<Input
										label={t`Name`}
										name="name"
										required
										placeholder="sidebar"
										pattern="[a-z0-9\-]+"
									/>
									<Input label={t`Label`} name="label" required placeholder={t`Main Sidebar`} />
									<Input
										label={t`Description`}
										name="description"
										placeholder={t`Appears on posts and pages`}
									/>
									<DialogError
										message={createAreaError || getMutationError(createAreaMutation.error)}
									/>
									<div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
										<Button
											type="button"
											variant="secondary"
											onClick={() => setIsCreateAreaOpen(false)}
										>
											{t`Cancel`}
										</Button>
										<Button type="submit" variant="primary" disabled={createAreaMutation.isPending}>
											{t`Create`}
										</Button>
									</div>
								</form>
							</Dialog>
						</Dialog.Root>
					</header>

					<div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(15rem,17rem)_minmax(0,1fr)] xl:items-start">
						<section aria-labelledby="widget-library-heading" className="min-w-0">
							<div className="mb-3 flex min-h-9 items-center justify-between gap-2">
								<h2
									id="widget-library-heading"
									className={isWidgetSearchOpen ? "sr-only" : "text-lg font-semibold"}
								>
									{t`Available widgets`}
								</h2>
								{isWidgetSearchOpen && (
									<Input
										type="search"
										aria-label={t`Search widgets`}
										placeholder={t`Search widgets`}
										value={widgetSearch}
										onChange={(event) => setWidgetSearch(event.target.value)}
										className="min-w-0 flex-1"
										autoFocus
									/>
								)}
								{(paletteWidgets.length > 8 || isWidgetSearchOpen) && (
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										className="shrink-0"
										aria-label={isWidgetSearchOpen ? t`Close widget search` : t`Search widgets`}
										onClick={() => {
											setIsWidgetSearchOpen(!isWidgetSearchOpen);
											setWidgetSearch("");
										}}
									>
										{isWidgetSearchOpen ? (
											<X className="size-4" aria-hidden="true" />
										) : (
											<MagnifyingGlass className="size-4" aria-hidden="true" />
										)}
									</Button>
								)}
							</div>
							{isWidgetSearchOpen && (
								<span role="status" className="sr-only">
									{searchTerm
										? plural(visiblePaletteWidgets.length, {
												one: "# matching widget",
												other: "# matching widgets",
											})
										: ""}
								</span>
							)}
							<div
								className={`grid gap-2 sm:grid-cols-2 xl:grid-cols-1 ${paletteWidgets.length > 8 ? "max-h-[50dvh] overflow-y-auto pe-1 xl:max-h-[min(65dvh,42rem)]" : ""}`}
							>
								{visiblePaletteWidgets.map((item) => (
									<DraggablePaletteItem
										key={item.id}
										{...item}
										canAdd={areas.length > 0}
										onAdd={handleSelectWidget}
									/>
								))}
								{visiblePaletteWidgets.length === 0 && (
									<p className="py-8 text-center text-sm text-kumo-subtle">{t`No matching widgets`}</p>
								)}
							</div>
						</section>

						<section aria-labelledby="widget-areas-heading" className="min-w-0">
							<div className="mb-3 flex min-h-9 items-center">
								<h2 id="widget-areas-heading" className="text-lg font-semibold">
									{t`Widget areas`}
								</h2>
							</div>
							<div className="space-y-4">
								{areas.length === 0 ? (
									<LayerCard className="flex flex-col items-center gap-3 px-6 py-12 text-center">
										<SquaresFour size={32} className="text-kumo-subtle" aria-hidden="true" />
										<div className="space-y-1">
											<p className="font-medium">{t`No widget areas yet`}</p>
											<p className="text-sm text-kumo-subtle">{t`Create one to place widgets on your site.`}</p>
										</div>
										<Button
											variant="secondary"
											icon={<Plus aria-hidden="true" />}
											onClick={() => setIsCreateAreaOpen(true)}
										>
											{t`Add widget area`}
										</Button>
									</LayerCard>
								) : (
									areas.map((area) => (
										<WidgetAreaPanel
											key={area.id}
											area={area}
											expandedWidgets={expandedWidgets}
											onToggleWidget={toggleWidget}
											isDraggingPalette={activeDragData !== null && isPaletteItem(activeDragData)}
											components={components}
											pluginBlocks={pluginBlocks}
											onBlockSidebarOpen={handleBlockSidebarOpen}
											onBlockSidebarClose={handleBlockSidebarClose}
										/>
									))
								)}
							</div>
						</section>
					</div>
				</div>

				<Dialog.Root
					open={isAddWidgetOpen}
					onOpenChange={(open) => {
						if (!open) closeAddWidgetDialog();
					}}
					disablePointerDismissal={createWidgetMutation.isPending}
				>
					<Dialog className="p-6" size="base">
						<div className="mb-5 flex items-start justify-between gap-4">
							<div className="flex min-w-0 items-start gap-3">
								<div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-kumo-tint">
									{selectedWidget && <WidgetIcon {...selectedWidget.widgetInput} />}
								</div>
								<div>
									<Dialog.Title className="text-lg font-semibold">
										{selectedWidget ? t`Add ${selectedWidget.label} widget` : t`Add widget`}
									</Dialog.Title>
									<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
										{selectedWidget?.description ?? t`Choose an area for this widget.`}
									</Dialog.Description>
								</div>
							</div>
							<Dialog.Close
								aria-label={t`Close`}
								render={(props) => (
									<Button
										{...props}
										variant="ghost"
										shape="square"
										aria-label={t`Close`}
										disabled={createWidgetMutation.isPending}
										className="shrink-0"
									>
										<X className="size-4" aria-hidden="true" />
									</Button>
								)}
							/>
						</div>
						<form onSubmit={handleAddWidget} className="space-y-4">
							<Select
								label={t`Widget area`}
								className="w-full"
								value={selectedAreaName}
								onValueChange={(value) => setSelectedAreaName(value ?? "")}
								items={Object.fromEntries(areas.map((area) => [area.name, area.label]))}
								disabled={createWidgetMutation.isPending}
							/>
							<DialogError message={getMutationError(createWidgetMutation.error)} />
							<div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
								<Button
									type="button"
									variant="secondary"
									disabled={createWidgetMutation.isPending}
									onClick={closeAddWidgetDialog}
								>
									{t`Cancel`}
								</Button>
								<Button
									type="submit"
									variant="primary"
									disabled={!selectedWidget || !selectedAreaName || createWidgetMutation.isPending}
								>
									{createWidgetMutation.isPending ? t`Adding...` : t`Add widget`}
								</Button>
							</div>
						</form>
					</Dialog>
				</Dialog.Root>

				{/* Drag overlay — no drop animation for palette items (source stays in place).
			    Use ref because state is cleared in handleDragEnd before animation runs. */}
				<DragOverlay dropAnimation={draggingFromPaletteRef.current ? null : undefined}>
					{activePaletteLabel ? (
						<LayerCard className="px-4 py-3 shadow-md">
							<span className="text-sm font-medium">{activePaletteLabel}</span>
						</LayerCard>
					) : activeWidget ? (
						<LayerCard className="px-4 py-3 shadow-md">
							<div className="flex items-center gap-2">
								<WidgetIcon {...activeWidget} />
								<span className="text-sm font-medium">
									{activeWidget.title || t`Untitled widget`}
								</span>
							</div>
						</LayerCard>
					) : null}
				</DragOverlay>

				{/* A single block-sidebar panel for the whole page — ensures only one is ever
			    open at a time, preventing stacked fixed overlays and duplicated window listeners. */}
				{blockSidebarPanel?.type === "image" && (
					<ImageDetailPanel
						attributes={blockSidebarPanel.attrs as unknown as ImageAttributes}
						onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
						onReplace={(attrs) =>
							blockSidebarPanel.onReplace(attrs as unknown as Record<string, unknown>)
						}
						onDelete={() => {
							blockSidebarPanel.onDelete();
							setBlockSidebarPanel(null);
						}}
						onClose={handleBlockSidebarClose}
					/>
				)}
			</DndContext>
			{blockSidebarPanel?.type === "gallery" && (
				<GalleryDetailPanel
					attributes={blockSidebarPanel.attrs as unknown as GalleryAttributes}
					onUpdate={(attrs) => blockSidebarPanel.onUpdate(attrs)}
					onDelete={() => {
						blockSidebarPanel.onDelete();
						setBlockSidebarPanel(null);
					}}
					onClose={handleBlockSidebarClose}
				/>
			)}
		</>
	);
}

/** A draggable item in the available widgets palette */
function DraggablePaletteItem({
	id,
	label,
	description,
	widgetInput,
	canAdd,
	onAdd,
}: {
	id: string;
	label: string;
	description?: string;
	widgetInput: CreateWidgetInput;
	canAdd: boolean;
	onAdd: (widget: PaletteItemData) => void;
}) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
		id,
		data: {
			source: "palette",
			widgetInput,
			label,
			description,
		} satisfies PaletteItemData,
	});

	return (
		<LayerCard
			ref={setNodeRef}
			className={`group flex min-w-0 items-center gap-2 p-3 hover:bg-kumo-tint focus-within:bg-kumo-tint ${isDragging ? "opacity-40" : ""}`}
		>
			<Button
				ref={setActivatorNodeRef}
				{...attributes}
				{...listeners}
				variant="ghost"
				shape="square"
				size="sm"
				className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
				aria-label={t`Drag ${label} widget`}
			>
				<DotsSixVertical className="size-4 text-kumo-subtle" aria-hidden="true" />
			</Button>
			<Popover>
				<Popover.Trigger
					render={
						<Button
							variant="ghost"
							shape="square"
							className="shrink-0 rounded-md bg-kumo-tint"
							aria-label={t`About ${label} widget`}
						>
							<WidgetIcon {...widgetInput} />
						</Button>
					}
				/>
				<Popover.Content side="bottom" align="start" className="w-64 max-w-[calc(100vw-2rem)] p-3">
					<Popover.Title dir="auto" className="text-sm font-medium">
						{label}
					</Popover.Title>
					{description && (
						<Popover.Description dir="auto" className="mt-1 text-sm text-kumo-subtle">
							{description}
						</Popover.Description>
					)}
				</Popover.Content>
			</Popover>
			<div className="min-w-0 flex-1">
				<span dir="auto" className="block truncate text-sm font-medium">
					{label}
				</span>
			</div>
			<Button
				variant="ghost"
				shape="square"
				size="sm"
				className="shrink-0"
				aria-label={t`Add ${label} widget`}
				disabled={!canAdd}
				onClick={() => onAdd({ source: "palette", widgetInput, label, description })}
			>
				<Plus className="size-4" aria-hidden="true" />
			</Button>
		</LayerCard>
	);
}

function WidgetAreaPanel({
	area,
	expandedWidgets,
	onToggleWidget,
	isDraggingPalette,
	components,
	pluginBlocks,
	onBlockSidebarOpen,
	onBlockSidebarClose,
}: {
	area: WidgetArea;
	expandedWidgets: Set<string>;
	onToggleWidget: (id: string) => void;
	isDraggingPalette: boolean;
	components: WidgetComponent[];
	pluginBlocks: PluginBlockDef[];
	onBlockSidebarOpen: (panel: BlockSidebarPanel) => void;
	onBlockSidebarClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [deleteAreaName, setDeleteAreaName] = React.useState<string | null>(null);

	// Make the area a droppable target for palette items
	const { setNodeRef: setDropRef, isOver } = useDroppable({
		id: `area:${area.name}`,
	});

	const deleteAreaMutation = useMutation({
		mutationFn: deleteWidgetArea,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			setDeleteAreaName(null);
			toastManager.add({ title: t`Widget area deleted` });
		},
	});

	const hasWidgets = area.widgets && area.widgets.length > 0;

	return (
		<LayerCard
			className={`min-w-0 ${isOver ? "outline-2 outline-dashed outline-offset-2 outline-kumo-brand" : ""}`}
		>
			<LayerCard.Secondary className="my-0 min-h-14 justify-between gap-3 px-4 py-3 text-kumo-default">
				<div className="flex min-w-0 items-center gap-1">
					<h3 dir="auto" className="min-w-0 break-words text-lg font-semibold">
						{area.label}
					</h3>
					{area.description && (
						<Popover>
							<Popover.Trigger
								render={
									<Button
										variant="ghost"
										shape="square"
										size="sm"
										className="shrink-0"
										aria-label={t`About ${area.label} widget area`}
									>
										<Info className="size-4 text-kumo-subtle" aria-hidden="true" />
									</Button>
								}
							/>
							<Popover.Content
								side="bottom"
								align="start"
								className="w-64 max-w-[calc(100vw-2rem)] p-3"
							>
								<Popover.Title dir="auto" className="text-sm font-medium">
									{area.label}
								</Popover.Title>
								<Popover.Description dir="auto" className="mt-1 text-sm text-kumo-subtle">
									{area.description}
								</Popover.Description>
							</Popover.Content>
						</Popover>
					)}
				</div>
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					className="shrink-0"
					onClick={() => setDeleteAreaName(area.name)}
					aria-label={t`Delete ${area.label} widget area`}
				>
					<Trash className="size-4" aria-hidden="true" />
				</Button>
			</LayerCard.Secondary>

			<LayerCard.Primary className="p-0">
				<div ref={setDropRef} className="min-h-28 space-y-2 rounded-lg bg-kumo-tint/40 p-3 sm:p-4">
					{hasWidgets ? (
						<SortableContext
							items={area.widgets!.map((w) => w.id)}
							strategy={verticalListSortingStrategy}
						>
							{area.widgets!.map((widget) => (
								<WidgetItem
									key={widget.id}
									widget={widget}
									areaName={area.name}
									isExpanded={expandedWidgets.has(widget.id)}
									onToggle={() => onToggleWidget(widget.id)}
									components={components}
									pluginBlocks={pluginBlocks}
									onBlockSidebarOpen={onBlockSidebarOpen}
									onBlockSidebarClose={onBlockSidebarClose}
								/>
							))}
						</SortableContext>
					) : null}
					{isDraggingPalette && (
						<div
							className={`rounded-md border-2 border-dashed px-4 py-5 text-center text-sm ${
								isOver
									? "border-kumo-brand bg-kumo-brand/5 text-kumo-link"
									: "border-kumo-line text-kumo-subtle"
							}`}
						>
							{isOver ? t`Drop to add widget` : t`Drag here to add`}
						</div>
					)}
					{!hasWidgets && !isDraggingPalette && (
						<div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-kumo-line px-4 py-7 text-center">
							<SquaresFour className="size-6 text-kumo-subtle" aria-hidden="true" />
							<p className="text-sm font-medium">{t`No widgets in this area`}</p>
							<p className="text-sm text-kumo-subtle">
								{t`Add one from the library or drag it here.`}
							</p>
						</div>
					)}
				</div>
			</LayerCard.Primary>

			<ConfirmDialog
				open={deleteAreaName === area.name}
				onClose={() => {
					setDeleteAreaName(null);
					deleteAreaMutation.reset();
				}}
				role="alertdialog"
				preventCloseWhilePending
				title={t`Delete ${area.label} widget area?`}
				description={t`This will delete the widget area and all its widgets. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteAreaMutation.isPending}
				error={deleteAreaMutation.error}
				onConfirm={() => deleteAreaMutation.mutate(area.name)}
			/>
		</LayerCard>
	);
}

function WidgetItem({
	widget,
	areaName,
	isExpanded,
	onToggle,
	components,
	pluginBlocks,
	onBlockSidebarOpen,
	onBlockSidebarClose,
}: {
	widget: Widget;
	areaName: string;
	isExpanded: boolean;
	onToggle: () => void;
	components: WidgetComponent[];
	pluginBlocks: PluginBlockDef[];
	onBlockSidebarOpen: (panel: BlockSidebarPanel) => void;
	onBlockSidebarClose: () => void;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: widget.id,
		data: {
			source: "area",
			areaName,
		} satisfies ExistingWidgetData,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	const deleteMutation = useMutation({
		mutationFn: () => deleteWidget(areaName, widget.id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			setIsDeleteOpen(false);
			toastManager.add({ title: t`Widget deleted` });
		},
	});

	const updateMutation = useMutation({
		mutationFn: (input: UpdateWidgetInput) => updateWidget(areaName, widget.id, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			toastManager.add({ title: t`Widget updated` });
		},
		onError: (error: Error) => {
			toastManager.add({
				title: t`Error updating widget`,
				description: error.message,
				type: "error",
			});
		},
	});

	const widgetTitle = widget.title || t`Untitled widget`;

	return (
		<>
			<div
				ref={setNodeRef}
				style={style}
				className={`min-w-0 rounded-md bg-kumo-base p-3 ring-1 ring-kumo-line ${isDragging ? "opacity-40" : ""}`}
			>
				<div className="flex min-w-0 items-center gap-1">
					<Button
						ref={setActivatorNodeRef}
						{...attributes}
						{...listeners}
						variant="ghost"
						shape="square"
						size="sm"
						className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
						aria-label={t`Drag to reorder ${widget.title ?? t`widget`}`}
					>
						<DotsSixVertical className="size-4 text-kumo-subtle" aria-hidden="true" />
					</Button>
					<div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-kumo-tint">
						<WidgetIcon {...widget} />
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="h-auto min-h-9 min-w-0 flex-1 justify-between gap-2 text-start text-sm"
						onClick={onToggle}
						aria-expanded={isExpanded}
						aria-label={
							isExpanded
								? t`Close settings for ${widgetTitle}`
								: t`Edit settings for ${widgetTitle}`
						}
					>
						<span dir="auto" className="min-w-0 truncate font-medium">
							{widgetTitle}
						</span>
						{isExpanded ? (
							<CaretDown className="size-4 shrink-0" aria-hidden="true" />
						) : (
							<CaretNext className="size-4 shrink-0" aria-hidden="true" />
						)}
					</Button>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						className="shrink-0"
						onClick={() => setIsDeleteOpen(true)}
						aria-label={t`Delete ${widget.title ?? t`widget`}`}
					>
						<Trash className="size-4" aria-hidden="true" />
					</Button>
				</div>

				{isExpanded && (
					<WidgetEditor
						widget={widget}
						components={components}
						pluginBlocks={pluginBlocks}
						onSave={(input) => updateMutation.mutate(input)}
						isSaving={updateMutation.isPending}
						onBlockSidebarOpen={onBlockSidebarOpen}
						onBlockSidebarClose={onBlockSidebarClose}
					/>
				)}
			</div>
			<ConfirmDialog
				open={isDeleteOpen}
				onClose={() => {
					setIsDeleteOpen(false);
					deleteMutation.reset();
				}}
				role="alertdialog"
				preventCloseWhilePending
				title={t`Delete ${widgetTitle}?`}
				description={t`This widget will be removed from its area. This action cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteMutation.mutate()}
			/>
		</>
	);
}

/** Inline editor form for a widget, rendered when the widget is expanded */
function WidgetEditor({
	widget,
	components,
	pluginBlocks,
	onSave,
	isSaving,
	onBlockSidebarOpen,
	onBlockSidebarClose,
}: {
	widget: Widget;
	components: WidgetComponent[];
	pluginBlocks: PluginBlockDef[];
	onSave: (input: UpdateWidgetInput) => void;
	isSaving: boolean;
	onBlockSidebarOpen: (panel: BlockSidebarPanel) => void;
	onBlockSidebarClose: () => void;
}) {
	const { t } = useLingui();
	const [title, setTitle] = React.useState(widget.title ?? "");
	const [content, setContent] = React.useState<unknown[]>(
		Array.isArray(widget.content) ? widget.content : [],
	);
	const [menuName, setMenuName] = React.useState(widget.menuName ?? "");
	const [componentId, setComponentId] = React.useState(widget.componentId ?? "");
	const [componentProps, setComponentProps] = React.useState<Record<string, unknown>>(
		widget.componentProps ?? {},
	);

	const { data: menus = [] } = useQuery({
		queryKey: ["menus"],
		queryFn: () => fetchMenus(),
		enabled: widget.type === "menu",
	});

	const selectedComponent = components.find((c) => c.id === componentId);

	const handleSave = () => {
		const input: UpdateWidgetInput = { title };
		if (widget.type === "content") {
			input.content = content;
		} else if (widget.type === "menu") {
			input.menuName = menuName;
		} else if (widget.type === "component") {
			input.componentId = componentId;
			input.componentProps = componentProps;
		}
		onSave(input);
	};

	return (
		<div className="mt-3 space-y-4 border-t border-kumo-line px-2 pt-4 pb-2">
			<Input
				label={t`Title`}
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder={t`Widget title`}
			/>

			{widget.type === "content" && (
				<div>
					<Label className="text-sm font-medium mb-2 block">{t`Content`}</Label>
					<PortableTextEditor
						value={content as Parameters<typeof PortableTextEditor>[0]["value"]}
						onChange={(value) => setContent(value)}
						minimal
						placeholder={t`Write widget content...`}
						pluginBlocks={pluginBlocks}
						onBlockSidebarOpen={onBlockSidebarOpen}
						onBlockSidebarClose={onBlockSidebarClose}
					/>
				</div>
			)}

			{widget.type === "menu" && (
				<Select
					label={t`Menu`}
					value={menuName}
					onValueChange={(v) => setMenuName(v ?? "")}
					items={Object.fromEntries(menus.map((m) => [m.name, m.label || m.name]))}
				>
					<Select.Option value="">{t`Select a menu...`}</Select.Option>
					{menus.map((m) => (
						<Select.Option key={m.name} value={m.name}>
							{m.label || m.name}
						</Select.Option>
					))}
				</Select>
			)}

			{widget.type === "component" && (
				<>
					<Select
						label={t`Component`}
						value={componentId}
						onValueChange={(v) => {
							setComponentId(v ?? "");
							// Reset props when component changes
							if (v !== componentId) {
								const comp = components.find((c) => c.id === v);
								if (comp) {
									const defaults: Record<string, unknown> = {};
									for (const [key, def] of Object.entries(comp.props)) {
										defaults[key] = def.default ?? "";
									}
									setComponentProps(defaults);
								} else {
									setComponentProps({});
								}
							}
						}}
						items={Object.fromEntries(
							components.map((c) => {
								const meta = CORE_WIDGET_META[c.id];
								return [c.id, meta ? t(meta.label) : c.label];
							}),
						)}
					>
						<Select.Option value="">{t`Select a component...`}</Select.Option>
						{components.map((c) => {
							const meta = CORE_WIDGET_META[c.id];
							return (
								<Select.Option key={c.id} value={c.id}>
									{meta ? t(meta.label) : c.label}
								</Select.Option>
							);
						})}
					</Select>

					{selectedComponent &&
						Object.entries(selectedComponent.props).map(([key, def]) => (
							<ComponentPropField
								key={key}
								componentId={selectedComponent.id}
								propKey={key}
								def={def}
								value={componentProps[key] ?? def.default ?? ""}
								onChange={(v) => setComponentProps((prev) => ({ ...prev, [key]: v }))}
							/>
						))}
				</>
			)}

			<div className="flex justify-end">
				<Button size="sm" variant="primary" onClick={handleSave} disabled={isSaving}>
					{isSaving ? t`Saving...` : t`Save`}
				</Button>
			</div>
		</div>
	);
}

/** Renders a single prop field for a component widget based on PropDef type */
function ComponentPropField({
	componentId,
	propKey,
	def,
	value,
	onChange,
}: {
	componentId: string;
	propKey: string;
	def: WidgetComponent["props"][string];
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	const { t } = useLingui();
	// Localize built-in core widget prop labels/options; fall back to the
	// server-provided string for plugin-registered components.
	const propMeta = CORE_WIDGET_META[componentId]?.props?.[propKey];
	const label = propMeta ? t(propMeta.label) : def.label;
	const optionLabel = (optValue: string, fallback: string) => {
		const descriptor = propMeta?.options?.[optValue];
		return descriptor ? t(descriptor) : fallback;
	};
	switch (def.type) {
		case "string":
			return (
				<Input
					label={label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		case "number":
			return (
				<Input
					label={label}
					type="number"
					value={typeof value === "number" ? value : ""}
					onChange={(e) => onChange(Number(e.target.value))}
				/>
			);
		case "boolean":
			return <Switch label={label} checked={Boolean(value)} onCheckedChange={onChange} />;
		case "select": {
			const items: Record<string, string> = {};
			for (const opt of def.options ?? []) {
				items[opt.value] = optionLabel(opt.value, opt.label);
			}
			return (
				<Select
					label={label}
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => onChange(v ?? "")}
					items={items}
				>
					{def.options?.map((opt) => (
						<Select.Option key={opt.value} value={opt.value}>
							{optionLabel(opt.value, opt.label)}
						</Select.Option>
					))}
				</Select>
			);
		}
		default:
			return (
				<Input
					label={label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
	}
}
