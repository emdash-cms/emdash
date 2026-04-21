/**
 * Admin Command Palette
 *
 * Quick navigation and search across the admin interface.
 * Opens with Cmd+K (Mac) or Ctrl+K (Windows/Linux).
 */

import { CommandPalette } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	SquaresFour,
	FileText,
	Image,
	Gear,
	PuzzlePiece,
	Upload,
	Database,
	List,
	GridFour,
	Users,
	Stack,
	MagnifyingGlass,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useHotkeys } from "react-hotkeys-hook";

import { apiFetch, type AdminManifest } from "../lib/api/client.js";
import { useCurrentUser } from "../lib/api/current-user";

/** Subset of manifest fields used by the palette (matches `Shell` props shape). */
type CommandPaletteManifest = {
	collections: Record<string, { label: string; labelSingular?: string }>;
	plugins: AdminManifest["plugins"];
};

// Role levels (matching @emdash-cms/auth)
const ROLE_ADMIN = 50;
const ROLE_EDITOR = 40;

// Regex for replacing route params like $collection with actual values
const ROUTE_PARAM_REGEX = /\$(\w+)/g;

// Debounce delay for content search (ms)
const SEARCH_DEBOUNCE_MS = 300;

// Detect macOS for keyboard shortcut display
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * Custom hook for debouncing a value
 */
function useDebouncedValue<T>(value: T, delay: number): T {
	const [debouncedValue, setDebouncedValue] = React.useState(value);

	React.useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedValue(value);
		}, delay);

		return () => {
			clearTimeout(timer);
		};
	}, [value, delay]);

	return debouncedValue;
}

interface SearchResult {
	id: string;
	collection: string;
	title: string;
	slug: string;
	status: string;
}

interface SearchResponse {
	items: SearchResult[];
	total: number;
}

interface NavItem {
	id: string;
	title: string | MessageDescriptor;
	to: string;
	params?: Record<string, string>;
	icon: React.ElementType;
	minRole?: number;
	keywords?: string[];
}

interface ResultGroup {
	id: string;
	label: MessageDescriptor;
	items: ResultItem[];
}

interface ResultItem {
	id: string;
	title: string;
	to: string;
	params?: Record<string, string>;
	icon?: React.ReactNode;
	description?: string;
	collection?: string;
}

interface AdminCommandPaletteProps {
	manifest: CommandPaletteManifest;
}

async function searchContent(query: string): Promise<SearchResponse> {
	if (!query || query.length < 2) {
		return { items: [], total: 0 };
	}
	const response = await apiFetch(`/_emdash/api/search?q=${encodeURIComponent(query)}&limit=10`);
	if (!response.ok) {
		return { items: [], total: 0 };
	}
	const body = (await response.json()) as { data: SearchResponse };
	return body.data;
}

function buildNavItems(manifest: CommandPaletteManifest, userRole: number): NavItem[] {
	const items: NavItem[] = [
		{
			id: "dashboard",
			title: msg`Dashboard`,
			to: "/",
			icon: SquaresFour,
			keywords: ["home", "overview"],
		},
	];

	// Add collection links
	for (const [name, config] of Object.entries(manifest.collections)) {
		items.push({
			id: `collection-${name}`,
			title: config.label,
			to: "/content/$collection",
			params: { collection: name },
			icon: FileText,
			keywords: ["content", name],
		});
	}

	// Add core admin links
	items.push(
		{
			id: "media",
			title: msg`Media Library`,
			to: "/media",
			icon: Image,
			keywords: ["images", "files", "uploads"],
		},
		{
			id: "menus",
			title: msg`Menus`,
			to: "/menus",
			icon: List,
			minRole: ROLE_EDITOR,
			keywords: ["navigation"],
		},
		{
			id: "widgets",
			title: msg`Widgets`,
			to: "/widgets",
			icon: GridFour,
			minRole: ROLE_EDITOR,
			keywords: ["sidebar", "footer"],
		},
		{
			id: "sections",
			title: msg`Sections`,
			to: "/sections",
			icon: Stack,
			minRole: ROLE_EDITOR,
			keywords: ["page builder", "blocks"],
		},
		{
			id: "content-types",
			title: msg`Content Types`,
			to: "/content-types",
			icon: Database,
			minRole: ROLE_ADMIN,
			keywords: ["schema", "collections"],
		},
		{
			id: "categories",
			title: msg`Categories`,
			to: "/taxonomies/$taxonomy",
			params: { taxonomy: "category" },
			icon: FileText,
			minRole: ROLE_EDITOR,
			keywords: ["taxonomy"],
		},
		{
			id: "tags",
			title: msg`Tags`,
			to: "/taxonomies/$taxonomy",
			params: { taxonomy: "tag" },
			icon: FileText,
			minRole: ROLE_EDITOR,
			keywords: ["taxonomy"],
		},
		{
			id: "users",
			title: msg`Users`,
			to: "/users",
			icon: Users,
			minRole: ROLE_ADMIN,
			keywords: ["accounts", "team"],
		},
		{
			id: "plugins",
			title: msg`Plugins`,
			to: "/plugins-manager",
			icon: PuzzlePiece,
			minRole: ROLE_ADMIN,
			keywords: ["extensions", "add-ons"],
		},
		{
			id: "import",
			title: msg`Import`,
			to: "/import/wordpress",
			icon: Upload,
			minRole: ROLE_ADMIN,
			keywords: ["wordpress", "migrate"],
		},
		{
			id: "settings",
			title: msg`Settings`,
			to: "/settings",
			icon: Gear,
			minRole: ROLE_ADMIN,
			keywords: ["configuration", "preferences"],
		},
		{
			id: "security",
			title: msg`Security Settings`,
			to: "/settings/security",
			icon: Gear,
			minRole: ROLE_ADMIN,
			keywords: ["passkeys", "authentication"],
		},
	);

	// Add plugin pages
	for (const [pluginId, config] of Object.entries(manifest.plugins)) {
		if (config.enabled === false) continue;
		if (config.adminPages && config.adminPages.length > 0) {
			for (const page of config.adminPages) {
				const label =
					page.label ||
					pluginId
						.split("-")
						.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
						.join(" ");

				items.push({
					id: `plugin-${pluginId}-${page.path}`,
					title: label,
					to: `/plugins/${pluginId}${page.path}`,
					icon: PuzzlePiece,
					keywords: ["plugin", pluginId],
				});
			}
		}
	}

	// Filter by role
	return items.filter((item) => !item.minRole || userRole >= item.minRole);
}

function filterNavItems(
	items: NavItem[],
	query: string,
	translate: (d: MessageDescriptor) => string,
): NavItem[] {
	if (!query) return items;
	const lowerQuery = query.toLowerCase();
	return items.filter((item) => {
		const titleStr = typeof item.title === "string" ? item.title : translate(item.title);
		const titleMatch = titleStr.toLowerCase().includes(lowerQuery);
		const keywordMatch = item.keywords?.some((k) => k.toLowerCase().includes(lowerQuery));
		return titleMatch || keywordMatch;
	});
}

export function AdminCommandPalette({ manifest }: AdminCommandPaletteProps) {
	const { t } = useLingui();
	const [open, setOpen] = React.useState(false);
	const [query, setQuery] = React.useState("");
	const navigate = useNavigate();

	// Debounce the search query to avoid flickering on every keystroke
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);

	const { data: user } = useCurrentUser();

	const userRole = user?.role ?? 0;

	// Search content when debounced query is long enough
	const { data: searchResults, isFetching: isSearching } = useQuery({
		queryKey: ["command-palette-search", debouncedQuery],
		queryFn: () => searchContent(debouncedQuery),
		enabled: debouncedQuery.length >= 2,
		staleTime: 30 * 1000,
	});

	// Show loading while waiting for debounce or API response
	const isWaitingForDebounce = query.length >= 2 && query !== debouncedQuery;
	const isPendingSearch = isWaitingForDebounce || isSearching;

	// Build navigation items
	const allNavItems = React.useMemo(() => buildNavItems(manifest, userRole), [manifest, userRole]);

	// Filter nav items based on query
	const filteredNavItems = React.useMemo(
		() => filterNavItems(allNavItems, query, t),
		[allNavItems, query, t],
	);

	// Build result groups
	const resultGroups = React.useMemo((): ResultGroup[] => {
		const groups: ResultGroup[] = [];

		// Navigation group
		if (filteredNavItems.length > 0) {
			groups.push({
				id: "navigation",
				label: msg`Navigation`,
				items: filteredNavItems.map((item) => ({
					id: item.id,
					title: typeof item.title === "string" ? item.title : t(item.title),
					to: item.to,
					params: item.params,
					icon: <item.icon className="h-4 w-4" />,
				})),
			});
		}

		// Content search results
		if (searchResults?.items && searchResults.items.length > 0) {
			const contentItems = searchResults.items.map((result) => {
				const collectionConfig = manifest.collections[result.collection];
				const collectionLabel = collectionConfig?.label ?? result.collection;

				return {
					id: `content-${result.id}`,
					title: result.title || result.slug,
					to: "/content/$collection/$id",
					params: { collection: result.collection, id: result.id },
					icon: <FileText className="h-4 w-4" />,
					description: collectionLabel,
					collection: result.collection,
				};
			});

			groups.push({
				id: "content",
				label: msg`Content`,
				items: contentItems,
			});
		}

		return groups;
	}, [filteredNavItems, searchResults, manifest.collections, t]);

	// Keyboard shortcut to open (Cmd+K / Ctrl+K)
	useHotkeys("mod+k", (e) => {
		e.preventDefault();
		setOpen(true);
	});

	// Reset query when closing
	React.useEffect(() => {
		if (!open) {
			setQuery("");
		}
	}, [open]);

	const handleSelect = React.useCallback(
		(item: ResultItem, options: { newTab: boolean }) => {
			setOpen(false);
			if (options.newTab) {
				// Build the full URL for new tab
				const path = item.params
					? item.to.replace(ROUTE_PARAM_REGEX, (_, key) => item.params?.[key] ?? "")
					: item.to;
				window.open(`/_emdash/admin${path}`, "_blank");
			} else {
				// Navigate within the app
				void navigate({
					to: item.to as "/",
					params: item.params,
				});
			}
		},
		[navigate],
	);

	const handleItemClick = React.useCallback(
		(item: ResultItem, e: React.MouseEvent) => {
			handleSelect(item, { newTab: e.metaKey || e.ctrlKey });
		},
		[handleSelect],
	);

	return (
		<CommandPalette.Root
			open={open}
			onOpenChange={setOpen}
			items={resultGroups}
			value={query}
			onValueChange={setQuery}
			itemToStringValue={(group) => t(group.label)}
			onSelect={handleSelect}
			getSelectableItems={(groups) => groups.flatMap((g) => g.items)}
		>
			<CommandPalette.Input
				placeholder={t`Search pages and content...`}
				leading={<MagnifyingGlass className="h-4 w-4 text-kumo-subtle" weight="bold" />}
			/>
			<CommandPalette.List>
				{isPendingSearch ? (
					<CommandPalette.Loading />
				) : (
					<>
						<CommandPalette.Results>
							{(group: ResultGroup) => (
								<CommandPalette.Group key={group.id} items={group.items}>
									<CommandPalette.GroupLabel>{t(group.label)}</CommandPalette.GroupLabel>
									<CommandPalette.Items>
										{(item: ResultItem) => (
											<CommandPalette.ResultItem
												key={item.id}
												value={item}
												title={item.title}
												description={item.description}
												icon={item.icon}
												onClick={(e: React.MouseEvent) => handleItemClick(item, e)}
											/>
										)}
									</CommandPalette.Items>
								</CommandPalette.Group>
							)}
						</CommandPalette.Results>
						<CommandPalette.Empty>{t`No results found`}</CommandPalette.Empty>
					</>
				)}
			</CommandPalette.List>
			<CommandPalette.Footer>
				<div className="flex items-center gap-4 text-kumo-subtle">
					<span className="flex items-center gap-1">
						<kbd className="rounded bg-kumo-control px-1.5 py-0.5 text-xs">Enter</kbd>
						<span>{t`to select`}</span>
					</span>
					<span className="flex items-center gap-1">
						<kbd className="rounded bg-kumo-control px-1.5 py-0.5 text-xs">
							{IS_MAC ? "Cmd" : "Ctrl"}+Enter
						</kbd>
						<span>{t`new tab`}</span>
					</span>
					<span className="flex items-center gap-1">
						<kbd className="rounded bg-kumo-control px-1.5 py-0.5 text-xs">Esc</kbd>
						<span>{t`to close`}</span>
					</span>
				</div>
			</CommandPalette.Footer>
		</CommandPalette.Root>
	);
}
