import { Button, DropdownMenu, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowUp,
	DotsThreeVertical,
	Layout,
	SidebarSimple,
} from "@phosphor-icons/react";
import * as React from "react";

import {
	moveContentEditorPanel,
	parseContentEditorPanelLayout,
	placeContentEditorPanel,
	resolveContentEditorPanelLayout,
	type ContentEditorPanelLayout,
	type ContentEditorPanelPlacement,
} from "../lib/admin-editor-panel-layout.js";
import {
	selectContentEditorPanels,
	type ContentEditorDraftState,
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
	panelsById: ReadonlyMap<string, ContentEditorPanelExtension>;
	layout: ContentEditorPanelLayout;
	panelContext: ContentEditorPanelContext;
	move(id: string, direction: "up" | "down"): void;
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
		() => resolveContentEditorPanelLayout(panels, storedLayout),
		[panels, storedLayout],
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
				const next = recipe(resolveContentEditorPanelLayout(panels, current));
				writeStoredLayout(storageKey, next);
				return next;
			});
		},
		[panels, storageKey],
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

	const value = React.useMemo<ExtensionPanelHostContext>(
		() => ({ panelsById, layout, panelContext, move, place }),
		[panelsById, layout, panelContext, move, place],
	);
	return <ExtensionPanelContext.Provider value={value}>{children}</ExtensionPanelContext.Provider>;
}

export function ContentEditorExtensionPanels({
	placement,
}: {
	placement: ContentEditorPanelPlacement;
}) {
	const host = React.useContext(ExtensionPanelContext);
	const { t } = useLingui();
	if (!host) return null;

	const ids = host.layout[placement];
	return ids.map((id, index) => {
		const extensionPanel = host.panelsById.get(id);
		if (!extensionPanel) return null;
		const Panel = extensionPanel.panel;
		const title =
			typeof extensionPanel.title === "string" ? extensionPanel.title : t(extensionPanel.title);
		const panelKey = `${extensionPanel.id}:${host.panelContext.entry?.id ?? "new"}`;
		const menu = (
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
						onClick={() => host.move(id, "up")}
					>
						{t`Move up`}
					</DropdownMenu.Item>
					<DropdownMenu.Item
						icon={<ArrowDown />}
						disabled={index === ids.length - 1}
						onClick={() => host.move(id, "down")}
					>
						{t`Move down`}
					</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						icon={placement === "main" ? <SidebarSimple /> : <Layout />}
						onClick={() => host.place(id, placement === "main" ? "sidebar" : "main")}
					>
						{placement === "main" ? t`Move to settings sidebar` : t`Move to main editor`}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu>
		);

		if (placement === "sidebar") {
			return (
				<section key={panelKey} className="min-w-0 border-t p-4">
					<div className="mb-4 flex min-w-0 items-center justify-between gap-2">
						<Text bold as="h3" DANGEROUS_className="min-w-0 break-words">
							{title}
						</Text>
						{menu}
					</div>
					<AdminExtensionBoundary variant="panel" label={title}>
						<Panel {...host.panelContext} />
					</AdminExtensionBoundary>
				</section>
			);
		}

		return (
			<section
				key={panelKey}
				className="min-w-0 overflow-hidden rounded-lg border border-kumo-line bg-kumo-base"
			>
				<header className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
					<Text bold as="h2" DANGEROUS_className="min-w-0 break-words">
						{title}
					</Text>
					{menu}
				</header>
				<div className="min-w-0 p-4">
					<AdminExtensionBoundary variant="panel" label={title}>
						<Panel {...host.panelContext} />
					</AdminExtensionBoundary>
				</div>
			</section>
		);
	});
}
