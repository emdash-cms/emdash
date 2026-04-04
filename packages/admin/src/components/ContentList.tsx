import { Badge, Button, buttonVariants, Dialog, Input, Tabs } from "@cloudflare/kumo";
import {
	Plus,
	Pencil,
	Trash,
	ArrowCounterClockwise,
	Copy,
	MagnifyingGlass,
	CaretLeft,
	CaretRight,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { ContentItem, TrashedContentItem } from "../lib/api";
import { cn } from "../lib/utils";
import { LocaleSwitcher } from "./LocaleSwitcher";

export interface ContentListProps {
	collection: string;
	collectionLabel: string;
	items: ContentItem[];
	trashedItems?: TrashedContentItem[];
	isLoading?: boolean;
	isTrashedLoading?: boolean;
	onDelete?: (id: string) => void;
	onDuplicate?: (id: string) => void;
	onRestore?: (id: string) => void;
	onPermanentDelete?: (id: string) => void;
	onLoadMore?: () => void;
	onLoadMoreTrashed?: () => void;
	hasMore?: boolean;
	hasMoreTrashed?: boolean;
	trashedCount?: number;
	/** i18n config — present when multiple locales are configured */
	i18n?: { defaultLocale: string; locales: string[] };
	/** Currently active locale filter */
	activeLocale?: string;
	/** Callback when locale filter changes */
	onLocaleChange?: (locale: string) => void;
}

type ViewTab = "all" | "trash";

const PAGE_SIZE = 20;

function getItemTitle(item: { data: Record<string, unknown>; slug: string | null; id: string }) {
	const rawTitle = item.data.title;
	const rawName = item.data.name;
	return (
		(typeof rawTitle === "string" ? rawTitle : "") ||
		(typeof rawName === "string" ? rawName : "") ||
		item.slug ||
		item.id
	);
}

/**
 * Content list view with table display and trash tab
 */
export function ContentList({
	collection,
	collectionLabel,
	items,
	trashedItems = [],
	isLoading,
	isTrashedLoading,
	onDelete,
	onDuplicate,
	onRestore,
	onPermanentDelete,
	onLoadMore,
	onLoadMoreTrashed,
	hasMore,
	hasMoreTrashed,
	trashedCount = 0,
	i18n,
	activeLocale,
	onLocaleChange,
}: ContentListProps) {
	const [activeTab, setActiveTab] = React.useState<ViewTab>("all");
	const [searchQuery, setSearchQuery] = React.useState("");
	const [page, setPage] = React.useState(0);
	const [focusedIndex, setFocusedIndex] = React.useState(-1);
	const tableRef = React.useRef<HTMLTableSectionElement>(null);

	// Reset page when search changes
	const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(e.target.value);
		setPage(0);
		setFocusedIndex(-1);
	};

	const filteredItems = React.useMemo(() => {
		if (!searchQuery) return items;
		const query = searchQuery.toLowerCase();
		return items.filter((item) => getItemTitle(item).toLowerCase().includes(query));
	}, [items, searchQuery]);

	const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
	const paginatedItems = filteredItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	// Keyboard navigation: j/k to move, Enter to open
	React.useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Don't intercept when typing in search input
			const target = e.target as HTMLElement;
			if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
			if (activeTab !== "all") return;

			if (e.key === "j" || e.key === "ArrowDown") {
				e.preventDefault();
				setFocusedIndex((prev) => Math.min(prev + 1, paginatedItems.length - 1));
			} else if (e.key === "k" || e.key === "ArrowUp") {
				e.preventDefault();
				setFocusedIndex((prev) => Math.max(prev - 1, 0));
			} else if (e.key === "Enter" && focusedIndex >= 0) {
				e.preventDefault();
				const item = paginatedItems[focusedIndex];
				if (item) {
					// Navigate to the content editor
					const link = tableRef.current
						?.querySelectorAll("tr[data-row]")
						[focusedIndex]?.querySelector("a");
					if (link instanceof HTMLAnchorElement) link.click();
				}
			} else if (e.key === "Escape") {
				setFocusedIndex(-1);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [activeTab, focusedIndex, paginatedItems]);

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-4">
					<h1 className="text-2xl font-bold">{collectionLabel}</h1>
					{i18n && activeLocale && onLocaleChange && (
						<LocaleSwitcher
							locales={i18n.locales}
							defaultLocale={i18n.defaultLocale}
							value={activeLocale}
							onChange={onLocaleChange}
							size="sm"
						/>
					)}
				</div>
				<Link to="/content/$collection/new" params={{ collection }} className={buttonVariants()}>
					<Plus className="mr-2 h-4 w-4" aria-hidden="true" />
					Add New
				</Link>
			</div>

			{/* Search */}
			{items.length > 0 && (
				<div className="relative max-w-sm">
					<MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
					<Input
						type="search"
						placeholder={`Search ${collectionLabel.toLowerCase()}...`}
						aria-label={`Search ${collectionLabel.toLowerCase()}`}
						value={searchQuery}
						onChange={handleSearchChange}
						className="pl-9"
					/>
				</div>
			)}

			{/* Tabs */}
			<Tabs
				variant="underline"
				value={activeTab}
				onValueChange={(v) => {
					if (v === "all" || v === "trash") setActiveTab(v);
				}}
				tabs={[
					{ value: "all", label: "All" },
					{
						value: "trash",
						label: (
							<span className="flex items-center gap-2">
								<Trash className="h-4 w-4" aria-hidden="true" />
								Trash
								{trashedCount > 0 && <Badge variant="secondary">{trashedCount}</Badge>}
							</span>
						),
					},
				]}
			/>

			{/* Content based on active tab */}
			{activeTab === "all" ? (
				<>
					{/* Table */}
					<div className="rounded-md border overflow-x-auto">
						<table className="w-full">
							<thead>
								<tr className="border-b bg-kumo-tint/50">
									<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
										Title
									</th>
									<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
										Status
									</th>
									{i18n && (
										<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
											Locale
										</th>
									)}
									<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
										Date
									</th>
									<th scope="col" className="px-4 py-3 text-right text-sm font-medium">
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								{items.length === 0 && !isLoading ? (
									<tr>
										<td colSpan={i18n ? 5 : 4} className="px-4 py-12 text-center">
											<p className="text-kumo-subtle mb-3">
												No {collectionLabel.toLowerCase()} yet.
											</p>
											<div className="flex items-center justify-center gap-3">
												<Link
													to="/content/$collection/new"
													params={{ collection }}
													className="inline-flex items-center gap-1.5 rounded-md bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
												>
													Create your first one
												</Link>
												<Link
													to="/import"
													className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-kumo-default hover:bg-kumo-tint"
												>
													Import from WordPress
												</Link>
											</div>
										</td>
									</tr>
								) : paginatedItems.length === 0 ? (
									<tr>
										<td colSpan={i18n ? 5 : 4} className="px-4 py-8 text-center text-kumo-subtle">
											No results for &ldquo;{searchQuery}&rdquo;
										</td>
									</tr>
								) : (
									paginatedItems.map((item, index) => (
										<ContentListItem
											key={item.id}
											item={item}
											collection={collection}
											onDelete={onDelete}
											onDuplicate={onDuplicate}
											showLocale={!!i18n}
											isFocused={index === focusedIndex}
										/>
									))
								)}
							</tbody>
						</table>
					</div>

					{/* Pagination */}
					{totalPages > 1 && (
						<div className="flex items-center justify-between">
							<span className="text-sm text-kumo-subtle">
								{filteredItems.length} {filteredItems.length === 1 ? "item" : "items"}
								{searchQuery && ` matching "${searchQuery}"`}
							</span>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									shape="square"
									disabled={page === 0}
									onClick={() => setPage(page - 1)}
									aria-label="Previous page"
								>
									<CaretLeft className="h-4 w-4" aria-hidden="true" />
								</Button>
								<span className="text-sm">
									{page + 1} / {totalPages}
								</span>
								<Button
									variant="outline"
									shape="square"
									disabled={page >= totalPages - 1}
									onClick={() => setPage(page + 1)}
									aria-label="Next page"
								>
									<CaretRight className="h-4 w-4" aria-hidden="true" />
								</Button>
							</div>
						</div>
					)}

					{/* Load more */}
					{hasMore && (
						<div className="flex justify-center">
							<Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
								{isLoading ? "Loading..." : "Load More"}
							</Button>
						</div>
					)}

					{/* Keyboard shortcut hints */}
					{paginatedItems.length > 0 && (
						<div className="flex items-center gap-4 text-xs text-kumo-subtle pt-2">
							<span>
								<kbd className="rounded bg-kumo-control px-1 py-0.5 text-xs">j</kbd>
								<kbd className="rounded bg-kumo-control px-1 py-0.5 text-xs ml-0.5">k</kbd> navigate
							</span>
							<span>
								<kbd className="rounded bg-kumo-control px-1 py-0.5 text-xs">Enter</kbd> open
							</span>
							<span>
								<kbd className="rounded bg-kumo-control px-1 py-0.5 text-xs">Esc</kbd> clear
							</span>
						</div>
					)}
				</>
			) : (
				<>
					{/* Trash Table */}
					<div className="rounded-md border overflow-x-auto">
						<table className="w-full">
							<thead>
								<tr className="border-b bg-kumo-tint/50">
									<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
										Title
									</th>
									<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
										Deleted
									</th>
									<th scope="col" className="px-4 py-3 text-right text-sm font-medium">
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								{trashedItems.length === 0 && !isTrashedLoading ? (
									<tr>
										<td colSpan={3} className="px-4 py-8 text-center text-kumo-subtle">
											Trash is empty
										</td>
									</tr>
								) : (
									trashedItems.map((item) => (
										<TrashedListItem
											key={item.id}
											item={item}
											onRestore={onRestore}
											onPermanentDelete={onPermanentDelete}
										/>
									))
								)}
							</tbody>
						</table>
					</div>

					{/* Load more trashed */}
					{hasMoreTrashed && (
						<div className="flex justify-center">
							<Button variant="outline" onClick={onLoadMoreTrashed} disabled={isTrashedLoading}>
								{isTrashedLoading ? "Loading..." : "Load More"}
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

interface ContentListItemProps {
	item: ContentItem;
	collection: string;
	onDelete?: (id: string) => void;
	onDuplicate?: (id: string) => void;
	showLocale?: boolean;
	isFocused?: boolean;
}

function ContentListItem({
	item,
	collection,
	onDelete,
	onDuplicate,
	showLocale,
	isFocused,
}: ContentListItemProps) {
	const title = getItemTitle(item);
	const date = new Date(item.updatedAt || item.createdAt);
	const rowRef = React.useRef<HTMLTableRowElement>(null);

	// Scroll focused row into view
	React.useEffect(() => {
		if (isFocused && rowRef.current) {
			rowRef.current.scrollIntoView({ block: "nearest" });
		}
	}, [isFocused]);

	return (
		<tr
			ref={rowRef}
			data-row
			className={cn(
				"border-b hover:bg-kumo-tint/25",
				isFocused && "bg-kumo-tint/50 outline outline-2 outline-kumo-brand/30 -outline-offset-2",
			)}
		>
			<td className="px-4 py-3">
				<Link
					to="/content/$collection/$id"
					params={{ collection, id: item.id }}
					className="font-medium hover:text-kumo-brand"
				>
					{title}
				</Link>
			</td>
			<td className="px-4 py-3">
				<StatusBadge
					status={item.status}
					hasPendingChanges={!!item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId}
				/>
			</td>
			{showLocale && (
				<td className="px-4 py-3">
					<span className="bg-kumo-tint rounded px-1.5 py-0.5 text-xs font-semibold uppercase">
						{item.locale}
					</span>
				</td>
			)}
			<td className="px-4 py-3 text-sm text-kumo-subtle">{date.toLocaleDateString()}</td>
			<td className="px-4 py-3 text-right">
				<div className="flex items-center justify-end space-x-1">
					<Link
						to="/content/$collection/$id"
						params={{ collection, id: item.id }}
						aria-label={`Edit ${title}`}
						className={buttonVariants({ variant: "ghost", shape: "square" })}
					>
						<Pencil className="h-4 w-4" aria-hidden="true" />
					</Link>
					<Button
						variant="ghost"
						shape="square"
						aria-label={`Duplicate ${title}`}
						onClick={() => onDuplicate?.(item.id)}
					>
						<Copy className="h-4 w-4" aria-hidden="true" />
					</Button>
					<Dialog.Root disablePointerDismissal>
						<Dialog.Trigger
							render={(p) => (
								<Button {...p} variant="ghost" shape="square" aria-label={`Move ${title} to trash`}>
									<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
								</Button>
							)}
						/>
						<Dialog className="p-6" size="sm">
							<Dialog.Title className="text-lg font-semibold">Move to Trash?</Dialog.Title>
							<Dialog.Description className="text-kumo-subtle">
								Move "{title}" to trash? You can restore it later.
							</Dialog.Description>
							<div className="mt-6 flex justify-end gap-2">
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="secondary">
											Cancel
										</Button>
									)}
								/>
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="destructive" onClick={() => onDelete?.(item.id)}>
											Move to Trash
										</Button>
									)}
								/>
							</div>
						</Dialog>
					</Dialog.Root>
				</div>
			</td>
		</tr>
	);
}

interface TrashedListItemProps {
	item: TrashedContentItem;
	onRestore?: (id: string) => void;
	onPermanentDelete?: (id: string) => void;
}

function TrashedListItem({ item, onRestore, onPermanentDelete }: TrashedListItemProps) {
	const title = getItemTitle(item);
	const deletedDate = new Date(item.deletedAt);

	return (
		<tr className="border-b hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<span className="font-medium text-kumo-subtle">{title}</span>
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{deletedDate.toLocaleDateString()}</td>
			<td className="px-4 py-3 text-right">
				<div className="flex items-center justify-end space-x-1">
					<Button
						variant="ghost"
						shape="square"
						aria-label={`Restore ${title}`}
						onClick={() => onRestore?.(item.id)}
					>
						<ArrowCounterClockwise className="h-4 w-4 text-kumo-brand" aria-hidden="true" />
					</Button>
					<Dialog.Root disablePointerDismissal>
						<Dialog.Trigger
							render={(p) => (
								<Button
									{...p}
									variant="ghost"
									shape="square"
									aria-label={`Permanently delete ${title}`}
								>
									<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
								</Button>
							)}
						/>
						<Dialog className="p-6" size="sm">
							<Dialog.Title className="text-lg font-semibold">Delete Permanently?</Dialog.Title>
							<Dialog.Description className="text-kumo-subtle">
								Permanently delete "{title}"? This cannot be undone.
							</Dialog.Description>
							<div className="mt-6 flex justify-end gap-2">
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="secondary">
											Cancel
										</Button>
									)}
								/>
								<Dialog.Close
									render={(p) => (
										<Button
											{...p}
											variant="destructive"
											onClick={() => onPermanentDelete?.(item.id)}
										>
											Delete Permanently
										</Button>
									)}
								/>
							</div>
						</Dialog>
					</Dialog.Root>
				</div>
			</td>
		</tr>
	);
}

function StatusBadge({
	status,
	hasPendingChanges,
}: {
	status: string;
	hasPendingChanges?: boolean;
}) {
	return (
		<span className="inline-flex items-center gap-1.5">
			<span
				className={cn(
					"inline-flex items-center rounded-full px-2 py-1 text-xs font-medium",
					status === "published" &&
						"bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
					status === "draft" &&
						"bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
					status === "scheduled" &&
						"bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
					status === "archived" && "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
				)}
			>
				{status}
			</span>
			{hasPendingChanges && <Badge variant="secondary">pending</Badge>}
		</span>
	);
}
