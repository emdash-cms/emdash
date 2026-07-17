import { Button, DropdownMenu, Text } from "@cloudflare/kumo";
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
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
import {
	ArrowDown,
	ArrowUp,
	DotsSixVertical,
	DotsThreeVertical,
	Layout,
	SidebarSimple,
} from "@phosphor-icons/react";
import * as React from "react";

import {
	moveContentEditorPanel,
	parseContentEditorPanelLayout,
	placeContentEditorPanel,
	reorderContentEditorPanel,
	resolveContentEditorPanelLayout,
	type ContentEditorPanelLayout,
	type ContentEditorPanelPlacement,
} from "../lib/admin-editor-panel-layout.js";
import {
	selectContentEditorPanels,
	type ContentEditorDraftState,
	type ContentEditorNativeSlot,
	type ContentEditorPanelActions,
	type ContentEditorPanelContext,
	type ContentEditorPanelExtension,
} from "../lib/admin-extensions.js";
import type { ContentItem } from "../lib/api";
import { useDisabledPluginIds } from "../lib/api/manifest.js";
import { usePluginAdmins } from "../lib/plugin-context.js";
import { AdminExtensionBoundary } from "./AdminExtensionBoundary.js";

const STORAGE_PREFIX = "emdash:content-editor-panels:v1";

interface ExtensionPanelHostContext {
	panels: readonly ContentEditorPanelExtension[];
	panelsById: ReadonlyMap<string, ContentEditorPanelExtension>;
	layout: ContentEditorPanelLayout;
	panelContext: ContentEditorPanelContext;
	move(id: string, direction: "up" | "down"): void;
	reorder(id: string, overId: string): void;
	place(id: string, placement: ContentEditorPanelPlacement): void;
}

const ExtensionPanelContext = React.createContext<ExtensionPanelHostContext | null>(null);

export interface ContentEditorExtensionPanelsProviderProps {
	children: React.ReactNode;
	collection: string;
	entry: ContentItem | null;
	locale?: string;
	userId?: string;
	userRole: number;
	draft: ContentEditorDraftState;
	actions: ContentEditorPanelActions;
}

function readStoredLayout(storageKey: string | null): ContentEditorPanelLayout | null {
	if (!storageKey || typeof window === "undefined") return null;
	try {
		return parseContentEditorPanelLayout(window.localStorage.getItem(storageKey));
	} catch {
		return null;
	}
}

function writeStoredLayout(storageKey: string | null, layout: ContentEditorPanelLayout): void {
	if (!storageKey || typeof window === "undefined") return;
	try {
		window.localStorage.setItem(storageKey, JSON.stringify(layout));
	} catch {
		// Browser storage is an enhancement; the in-memory layout still works.
	}
}

export function ContentEditorExtensionPanelsProvider({
	children,
	collection,
	entry,
	locale,
	userId,
	userRole,
	draft,
	actions,
}: ContentEditorExtensionPanelsProviderProps) {
	const pluginAdmins = usePluginAdmins();
	const disabledPluginIds = useDisabledPluginIds();
	const panels = React.useMemo(
		() => selectContentEditorPanels(pluginAdmins, { collection, userRole, disabledPluginIds }),
		[pluginAdmins, collection, userRole, disabledPluginIds],
	);
	const movablePanels = React.useMemo(
		() => panels.filter((panel) => (panel.slot ?? "panel") === "panel"),
		[panels],
	);
	const storageKey = userId
		? `${STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(collection)}`
		: null;
	const [storedLayout, setStoredLayout] = React.useState<ContentEditorPanelLayout | null>(() =>
		readStoredLayout(storageKey),
	);

	React.useEffect(() => {
		setStoredLayout(readStoredLayout(storageKey));
	}, [storageKey]);

	const layout = React.useMemo(
		() => resolveContentEditorPanelLayout(movablePanels, storedLayout),
		[movablePanels, storedLayout],
	);
	const panelsById = React.useMemo(
		() => new Map(panels.map((panel) => [panel.id, panel])),
		[panels],
	);
	const panelContext = React.useMemo<ContentEditorPanelContext>(
		() => ({ collection, entry, locale, draft, actions }),
		[collection, entry, locale, draft, actions],
	);

	const updateLayout = React.useCallback(
		(recipe: (current: ContentEditorPanelLayout) => ContentEditorPanelLayout) => {
			setStoredLayout((current) => {
				const next = recipe(resolveContentEditorPanelLayout(movablePanels, current));
				writeStoredLayout(storageKey, next);
				return next;
			});
		},
		[movablePanels, storageKey],
	);
	const move = React.useCallback(
		(id: string, direction: "up" | "down") => {
			updateLayout((current) => moveContentEditorPanel(current, id, direction));
		},
		[updateLayout],
	);
	const place = React.useCallback(
		(id: string, placement: ContentEditorPanelPlacement) => {
			updateLayout((current) => placeContentEditorPanel(current, id, placement));
		},
		[updateLayout],
	);
	const reorder = React.useCallback(
		(id: string, overId: string) => {
			updateLayout((current) => reorderContentEditorPanel(current, id, overId));
		},
		[updateLayout],
	);

	const value = React.useMemo<ExtensionPanelHostContext>(
		() => ({ panels, panelsById, layout, panelContext, move, reorder, place }),
		[panels, panelsById, layout, panelContext, move, reorder, place],
	);
	return <ExtensionPanelContext.Provider value={value}>{children}</ExtensionPanelContext.Provider>;
}

export function ContentEditorExtensionPanels({
	placement,
}: {
	placement: ContentEditorPanelPlacement;
}) {
	const host = React.useContext(ExtensionPanelContext);
	if (!host) return null;

	const ids = host.layout[placement];
	if (ids.length === 0) return null;

	return <SortableContentEditorExtensionPanels host={host} ids={ids} placement={placement} />;
}

function SortableContentEditorExtensionPanels({
	host,
	ids,
	placement,
}: {
	host: ExtensionPanelHostContext;
	ids: readonly string[];
	placement: ContentEditorPanelPlacement;
}) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const onDragEnd = React.useCallback(
		(event: DragEndEvent) => {
			if (!event.over || event.active.id === event.over.id) return;
			host.reorder(String(event.active.id), String(event.over.id));
		},
		[host],
	);

	return (
		<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
			<SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
				{ids.map((id, index) => {
					const extensionPanel = host.panelsById.get(id);
					if (!extensionPanel) return null;
					return (
						<SortableExtensionPanel
							key={`${extensionPanel.id}:${host.panelContext.entry?.id ?? "new"}`}
							extensionPanel={extensionPanel}
							index={index}
							ids={ids}
							placement={placement}
							host={host}
						/>
					);
				})}
			</SortableContext>
		</DndContext>
	);
}

export function ContentEditorExtensionSlot({
	name,
	fallback,
}: {
	name: ContentEditorNativeSlot;
	fallback: React.ReactNode;
}) {
	const host = React.useContext(ExtensionPanelContext);
	const { t } = useLingui();
	if (!host) return fallback;

	const contributions = host.panels.filter((panel) => panel.slot === name);
	const replacement = contributions.find((panel) => panel.mode === "replace");
	const appended = contributions.filter((panel) => panel.mode !== "replace");
	const slotBody = replacement ? (
		<AdminExtensionBoundary
			key={`${replacement.id}:${host.panelContext.entry?.id ?? "new"}`}
			variant="panel"
			label={typeof replacement.title === "string" ? replacement.title : t(replacement.title)}
			fallback={fallback}
		>
			{React.createElement(replacement.panel, host.panelContext)}
		</AdminExtensionBoundary>
	) : (
		fallback
	);

	return (
		<>
			{slotBody}
			{appended.map((extensionPanel) => {
				const Panel = extensionPanel.panel;
				const title =
					typeof extensionPanel.title === "string" ? extensionPanel.title : t(extensionPanel.title);
				return (
					<AdminExtensionBoundary
						key={`${extensionPanel.id}:${host.panelContext.entry?.id ?? "new"}`}
						variant="panel"
						label={title}
					>
						<Panel {...host.panelContext} />
					</AdminExtensionBoundary>
				);
			})}
		</>
	);
}

function SortableExtensionPanel({
	extensionPanel,
	index,
	ids,
	placement,
	host,
}: {
	extensionPanel: ContentEditorPanelExtension;
	index: number;
	ids: readonly string[];
	placement: ContentEditorPanelPlacement;
	host: ExtensionPanelHostContext;
}) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: extensionPanel.id,
	});
	const Panel = extensionPanel.panel;
	const title =
		typeof extensionPanel.title === "string" ? extensionPanel.title : t(extensionPanel.title);
	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
		zIndex: isDragging ? 10 : undefined,
	};
	const controls = (
		<div className="flex shrink-0 items-center gap-1">
			<button
				type="button"
				{...attributes}
				{...listeners}
				className="grid size-8 cursor-grab place-items-center rounded-md text-kumo-subtle hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-accent active:cursor-grabbing"
				aria-label={t`Drag to reorder ${title}`}
				title={t`Drag to reorder ${title}`}
			>
				<DotsSixVertical size={18} aria-hidden="true" />
			</button>
			<DropdownMenu>
				<DropdownMenu.Trigger
					render={(props) => (
						<Button
							{...props}
							type="button"
							shape="square"
							size="sm"
							variant="ghost"
							icon={<DotsThreeVertical />}
							aria-label={t`Arrange ${title}`}
							title={t`Arrange ${title}`}
						/>
					)}
				/>
				<DropdownMenu.Content>
					<DropdownMenu.Item
						icon={<ArrowUp />}
						disabled={index === 0}
						onClick={() => host.move(extensionPanel.id, "up")}
					>
						{t`Move up`}
					</DropdownMenu.Item>
					<DropdownMenu.Item
						icon={<ArrowDown />}
						disabled={index === ids.length - 1}
						onClick={() => host.move(extensionPanel.id, "down")}
					>
						{t`Move down`}
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						icon={placement === "main" ? <SidebarSimple /> : <Layout />}
						onClick={() => host.place(extensionPanel.id, placement === "main" ? "sidebar" : "main")}
					>
						{placement === "main" ? t`Move to settings sidebar` : t`Move to main editor`}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu>
		</div>
	);

	if (placement === "sidebar") {
		return (
			<section
				ref={setNodeRef}
				style={style}
				className={`min-w-0 border-t bg-kumo-base p-4 ${isDragging ? "opacity-60 shadow-lg" : ""}`}
			>
				<div className="mb-4 flex min-w-0 items-center justify-between gap-2">
					<Text bold as="h3" DANGEROUS_className="min-w-0 break-words">
						{title}
					</Text>
					{controls}
				</div>
				<AdminExtensionBoundary variant="panel" label={title}>
					<Panel {...host.panelContext} />
				</AdminExtensionBoundary>
			</section>
		);
	}

	return (
		<section
			ref={setNodeRef}
			style={style}
			className={`min-w-0 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base ${isDragging ? "opacity-60 shadow-lg" : ""}`}
		>
			<header className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
				<Text bold as="h2" DANGEROUS_className="min-w-0 break-words">
					{title}
				</Text>
				{controls}
			</header>
			<div className="min-w-0 p-4">
				<AdminExtensionBoundary variant="panel" label={title}>
					<Panel {...host.panelContext} />
				</AdminExtensionBoundary>
			</div>
		</section>
	);
}
