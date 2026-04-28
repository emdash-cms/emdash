/**
 * Widgets page component
 *
 * Manage widget areas and widgets with drag-and-drop support.
 * Available widgets can be dragged from the palette into widget areas.
 * Widgets within an area can be reordered via drag-and-drop.
 */

import { Button, Dialog, Input, Label, Select, Switch, Toast } from "@cloudflare/kumo";
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
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Plus, DotsSixVertical, Trash, CaretDown } from "@phosphor-icons/react";

import { CaretNext } from "./ArrowIcons.js";
import { X } from "@phosphor-icons/react";
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
import { ConfirmDialog } from "./ConfirmDialog.js";
import { DialogError, getMutationError } from "./DialogError.js";
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

export function Widgets() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const [isCreateAreaOpen, setIsCreateAreaOpen] = React.useState(false);
	const [createAreaError, setCreateAreaError] = React.useState<string | null>(null);
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
			toastManager.add({ title: "Widget area created" });
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
			toastManager.add({ title: "Widget added" });
		},
		onError: (error: Error) => {
			toastManager.add({
				title: "Error adding widget",
				description: error.message,
				type: "error",
			});
		},
	});

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
				title: "Error reordering widgets",
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
				createWidgetMutation.mutate({
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
				<div className="text-kumo-subtle">Loading widgets...</div>
			</div>
		);
	}

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={collisionDetection}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<div>
						<h1 className="text-3xl font-bold">Widgets</h1>
						<p className="text-kumo-subtle">Manage content widgets in your widget areas</p>
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
								<Button {...props} icon={<Plus />}>
									Add Widget Area
								</Button>
							)}
						/>
						<Dialog className="p-6" size="lg">
							<div className="flex items-start justify-between gap-4 mb-4">
								<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
									Create Widget Area
								</Dialog.Title>
								<Dialog.Close
									aria-label="Close"
									render={(props) => (
										<Button
											{...props}
											variant="ghost"
											shape="square"
											aria-label="Close"
											className="absolute end-4 top-4"
										>
											<X className="h-4 w-4" />
											<span className="sr-only">Close</span>
										</Button>
									)}
								/>
							</div>
							<form onSubmit={handleCreateArea} className="space-y-4">
								<Input
									label="Name"
									name="name"
									required
									placeholder="sidebar"
									pattern="[a-z0-9-]+"
								/>
								<Input label="Label" name="label" required placeholder="Main Sidebar" />
								<Input
									label="Description"
									name="description"
									placeholder="Appears on posts and pages"
								/>
								<DialogError
									message={createAreaError || getMutationError(createAreaMutation.error)}
								/>
								<div className="flex justify-end gap-2">
									<Button
										type="button"
										variant="outline"
										onClick={() => setIsCreateAreaOpen(false)}
									>
										Cancel
									</Button>
									<Button type="submit" disabled={createAreaMutation.isPending}>
										Create
									</Button>
								</div>
							</form>
						</Dialog>
					</Dialog.Root>
				</div>

				<div className="grid grid-cols-12 gap-6">
					{/* Available Widgets (draggable palette) */}
					<div className="col-span-4">
						<div className="rounded-lg border bg-kumo-base p-6 space-y-4">
							<h2 className="text-xl font-semibold">Available Widgets</h2>
							<p className="text-sm text-kumo-subtle">Drag widgets into an area to add them</p>
							<div className="space-y-2">
								{BUILTIN_WIDGETS.map((item) => (
									<DraggablePaletteItem
										key={item.id}
										id={item.id}
										label={t(item.label)}
										description={t(item.description)}
										widgetInput={{ ...item.input, title: t(item.label) }}
									/>
								))}
								{components.map((comp) => (
									<DraggablePaletteItem
										key={`palette-comp-${comp.id}`}
										id={`palette-comp-${comp.id}`}
										label={comp.label}
										description={comp.description}
										widgetInput={{
											type: "component",
											title: comp.label,
											componentId: comp.id,
										}}
									/>
								))}
							</div>
						</div>
					</div>

					{/* Widget Areas (droppable + sortable) */}
					<div className="col-span-8 space-y-4">
						{areas.length === 0 ? (
							<div className="rounded-lg border bg-kumo-base p-12 text-center">
								<p className="text-kumo-subtle">No widget areas yet. Create one to get started.</p>
							</div>
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
				</div>
			</div>

			{/* Drag overlay — no drop animation for palette items (source stays in place).
			    Use ref because state is cleared in handleDragEnd before animation runs. */}
			<DragOverlay dropAnimation={draggingFromPaletteRef.current ? null : undefined}>
				{activePaletteLabel ? (
					<div className="rounded border bg-kumo-base p-3 shadow-lg opacity-90">
						<div className="font-medium">{activePaletteLabel}</div>
					</div>
				) : activeWidget ? (
					<div className="rounded border bg-kumo-base p-3 shadow-lg opacity-90">
						<div className="flex items-center gap-2">
							<DotsSixVertical className="h-4 w-4 text-kumo-subtle" />
							<span className="font-medium">{activeWidget.title || "Untitled Widget"}</span>
							<span className="text-xs text-kumo-subtle">({activeWidget.type})</span>
						</div>
					</div>
				) : null}
			</DragOverlay>

			{/* A single block-sidebar panel for the whole page — ensures only one is ever
			    open at a time, preventing stacked fixed overlays and duplicated window listeners. */}
			{blockSidebarPanel?.type === "image" && (
				<ImageDetailPanel
					attributes={blockSidebarPanel.attrs as unknown as ImageAttributes}
					onUpdate={(attrs) =>
						blockSidebarPanel.onUpdate(attrs as unknown as Record<string, unknown>)
					}
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
	);
}

/** A draggable item in the available widgets palette */
function DraggablePaletteItem({
	id,
	label,
	description,
	widgetInput,
}: {
	id: string;
	label: string;
	description?: string;
	widgetInput: CreateWidgetInput;
}) {
	const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
		id,
		data: {
			source: "palette",
			widgetInput,
			label,
		} satisfies PaletteItemData,
	});

	return (
		<div
			ref={setNodeRef}
			{...attributes}
			{...listeners}
			className={`p-3 rounded border cursor-grab active:cursor-grabbing select-none ${
				isDragging ? "opacity-50" : "hover:bg-kumo-tint"
			}`}
		>
			<div className="font-medium">{label}</div>
			{description && <div className="text-sm text-kumo-subtle">{description}</div>}
		</div>
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
			toastManager.add({ title: "Widget area deleted" });
		},
	});

	const hasWidgets = area.widgets && area.widgets.length > 0;

	return (
		<div
			className={`rounded-lg border bg-kumo-base transition-colors ${isOver ? "ring-2 ring-kumo-brand" : ""}`}
		>
			<div className="p-4 border-b flex items-center justify-between">
				<div>
					<h3 className="text-lg font-semibold">{area.label}</h3>
					{area.description && <p className="text-sm text-kumo-subtle">{area.description}</p>}
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setDeleteAreaName(area.name)}
					aria-label={`Delete ${area.label} widget area`}
				>
					<Trash className="h-4 w-4" />
				</Button>
			</div>

			<div ref={setDropRef} className="p-4 space-y-2 min-h-[80px]">
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
				{/* Drop zone hint — shown when dragging a palette item */}
				{isDraggingPalette && (
					<div
						className={`text-center py-4 rounded border-2 border-dashed transition-colors ${
							isOver
								? "border-kumo-brand bg-kumo-brand/5 text-kumo-brand"
								: "border-kumo-subtle/30 text-kumo-subtle"
						}`}
					>
						{isOver ? "Drop to add widget" : "Drag here to add"}
					</div>
				)}
				{!hasWidgets && !isDraggingPalette && (
					<div className="text-center py-8 text-kumo-subtle">Drag widgets here to add them</div>
				)}
			</div>

			<ConfirmDialog
				open={deleteAreaName === area.name}
				onClose={() => {
					setDeleteAreaName(null);
					deleteAreaMutation.reset();
				}}
				title="Delete Widget Area?"
				description="This will delete the widget area and all its widgets. This action cannot be undone."
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={deleteAreaMutation.isPending}
				error={deleteAreaMutation.error}
				onConfirm={() => deleteAreaMutation.mutate(area.name)}
			/>
		</div>
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
	const queryClient = useQueryClient();
	const toastManager = Toast.useToastManager();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
			toastManager.add({ title: "Widget deleted" });
		},
		onError: (error: Error) => {
			toastManager.add({
				title: "Error",
				description: error.message,
				type: "error",
			});
		},
	});

	const updateMutation = useMutation({
		mutationFn: (input: UpdateWidgetInput) => updateWidget(areaName, widget.id, input),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["widget-areas"] });
			toastManager.add({ title: "Widget updated" });
		},
		onError: (error: Error) => {
			toastManager.add({
				title: "Error updating widget",
				description: error.message,
				type: "error",
			});
		},
	});

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={`rounded border bg-kumo-base p-3 ${isDragging ? "opacity-50" : ""}`}
		>
			<div className="flex items-center gap-2">
				<button
					{...attributes}
					{...listeners}
					className="cursor-grab active:cursor-grabbing"
					aria-label={`Drag to reorder ${widget.title || "widget"}`}
				>
					<DotsSixVertical className="h-4 w-4 text-kumo-subtle" />
				</button>
				<button onClick={onToggle} className="flex-1 text-start" aria-expanded={isExpanded}>
					<div className="flex items-center gap-2">
						{isExpanded ? (
							<CaretDown className="h-4 w-4" />
						) : (
							<CaretNext className="h-4 w-4" />
						)}
						<span className="font-medium">{widget.title || "Untitled Widget"}</span>
						<span className="text-xs text-kumo-subtle">({widget.type})</span>
					</div>
				</button>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => deleteMutation.mutate()}
					aria-label={`Delete ${widget.title || "widget"}`}
				>
					<Trash className="h-4 w-4" />
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
		queryFn: fetchMenus,
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
		<div className="mt-3 p-3 bg-kumo-tint rounded space-y-4">
			<Input
				label="Title"
				value={title}
				onChange={(e) => setTitle(e.target.value)}
				placeholder="Widget title"
			/>

			{widget.type === "content" && (
				<div>
					<Label className="text-sm font-medium mb-2 block">Content</Label>
					<PortableTextEditor
						value={content as Parameters<typeof PortableTextEditor>[0]["value"]}
						onChange={(value) => setContent(value as unknown[])}
						minimal
						placeholder="Write widget content..."
						pluginBlocks={pluginBlocks}
						onBlockSidebarOpen={onBlockSidebarOpen}
						onBlockSidebarClose={onBlockSidebarClose}
					/>
				</div>
			)}

			{widget.type === "menu" && (
				<Select
					label="Menu"
					value={menuName}
					onValueChange={(v) => setMenuName(v ?? "")}
					items={Object.fromEntries(menus.map((m) => [m.name, m.label || m.name]))}
				>
					<Select.Option value="">Select a menu...</Select.Option>
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
						label="Component"
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
						items={Object.fromEntries(components.map((c) => [c.id, c.label]))}
					>
						<Select.Option value="">Select a component...</Select.Option>
						{components.map((c) => (
							<Select.Option key={c.id} value={c.id}>
								{c.label}
							</Select.Option>
						))}
					</Select>

					{selectedComponent &&
						Object.entries(selectedComponent.props).map(([key, def]) => (
							<ComponentPropField
								key={key}
								propKey={key}
								def={def}
								value={componentProps[key] ?? def.default ?? ""}
								onChange={(v) => setComponentProps((prev) => ({ ...prev, [key]: v }))}
							/>
						))}
				</>
			)}

			<div className="flex justify-end">
				<Button size="sm" onClick={handleSave} disabled={isSaving}>
					{isSaving ? "Saving..." : "Save"}
				</Button>
			</div>
		</div>
	);
}

/** Renders a single prop field for a component widget based on PropDef type */
function ComponentPropField({
	def,
	value,
	onChange,
}: {
	propKey: string;
	def: WidgetComponent["props"][string];
	value: unknown;
	onChange: (value: unknown) => void;
}) {
	switch (def.type) {
		case "string":
			return (
				<Input
					label={def.label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		case "number":
			return (
				<Input
					label={def.label}
					type="number"
					value={typeof value === "number" ? value : ""}
					onChange={(e) => onChange(Number(e.target.value))}
				/>
			);
		case "boolean":
			return <Switch label={def.label} checked={Boolean(value)} onCheckedChange={onChange} />;
		case "select": {
			const items: Record<string, string> = {};
			for (const opt of def.options ?? []) {
				items[opt.value] = opt.label;
			}
			return (
				<Select
					label={def.label}
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => onChange(v ?? "")}
					items={items}
				>
					{def.options?.map((opt) => (
						<Select.Option key={opt.value} value={opt.value}>
							{opt.label}
						</Select.Option>
					))}
				</Select>
			);
		}
		default:
			return (
				<Input
					label={def.label}
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
	}
}
