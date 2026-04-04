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
	CaretUp,
	CaretDown,
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
	onPublish?: (id: string) => void;
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
type SortField = "title" | "status" | "date";
type SortDir = "asc" | "desc";

export function ContentList({
	collection,
	collectionLabel,
	items,
	trashedItems = [],
	isLoading,
	isTrashedLoading,
	onDelete,
	onPublish,
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
	const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
	const [sortField, setSortField] = React.useState<SortField>("date");
	const [sortDir, setSortDir] = React.useState<SortDir>("desc");
	const [focusedIndex, setFocusedIndex] = React.useState(-1);
	const tableRef = React.useRef<HTMLTableElement>(null);

	// Reset page when search changes
	const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(e.target.value);
		setPage(0);
	};

	const handleSort = (field: SortField) => {
		if (sortField === field) {
			setSortDir((d) => (d === "asc" ? "desc" : "asc"));
		} else {
			setSortField(field);
			setSortDir(field === "title" ? "asc" : "desc");
		}
		setPage(0);
	};

	const toggleSelection = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const filteredItems = React.useMemo(() => {
		let result = items;
		if (searchQuery) {
			const query = searchQuery.toLowerCase();
			result = result.filter((item) => getItemTitle(item).toLowerCase().includes(query));
		}
		return result;
	}, [items, searchQuery]);

	const sortedItems = React.useMemo(() => {
		const sorted = [...filteredItems];
		sorted.sort((a, b) => {
			let cmp = 0;
			switch (sortField) {
				case "title":
					cmp = getItemTitle(a).localeCompare(getItemTitle(b));
					break;
				case "status":
					cmp = a.status.localeCompare(b.status);
					break;
				case "date": {
					const dateA = new Date(a.updatedAt || a.createdAt).getTime();
					const dateB = new Date(b.updatedAt || b.createdAt).getTime();
					cmp = dateA - dateB;
					break;
				}
			}
			return sortDir === "asc" ? cmp : -cmp;
		});
		return sorted;
	}, [filteredItems, sortField, sortDir]);

	const totalPages = Math.max(1, Math.ceil(sortedItems.length / PAGE_SIZE));
	const paginatedItems = sortedItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	const allPageSelected =
		paginatedItems.length > 0 && paginatedItems.every((item) => selectedIds.has(item.id));

	const toggleSelectAll = () => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (allPageSelected) {
				for (const item of paginatedItems) {
					next.delete(item.id);
				}
			} else {
				for (const item of paginatedItems) {
					next.add(item.id);
				}
			}
			return next;
		});
	};

	// Keyboard navigation for the table
	React.useEffect(() => {
		const table = tableRef.current;
		if (!table) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (activeTab !== "all" || paginatedItems.length === 0) return;
			// Don't intercept when focused on an input
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement ||
				e.target instanceof HTMLSelectElement
			)
				return;

			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					setFocusedIndex((prev) => Math.min(prev + 1, paginatedItems.length - 1));
					break;
				case "ArrowUp":
					e.preventDefault();
					setFocusedIndex((prev) => Math.max(prev - 1, 0));
					break;
				case "x":
					if (focusedIndex >= 0 && focusedIndex < paginatedItems.length) {
						const item = paginatedItems[focusedIndex];
						if (item) toggleSelection(item.id);
					}
					break;
			}
		};

		table.addEventListener("keydown", handleKeyDown);
		return () => table.removeEventListener("keydown", handleKeyDown);
	}, [activeTab, paginatedItems, focusedIndex]);

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
					{/* Bulk actions bar */}
					{selectedIds.size > 0 && (
						<div className="flex items-center gap-3 rounded-lg border bg-kumo-brand/10 px-4 py-2">
							<span className="text-sm font-medium">{selectedIds.size} selected</span>
							{onPublish && (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => {
										for (const id of selectedIds) {
											onPublish(id);
										}
										setSelectedIds(new Set());
									}}
								>
									Publish
								</Button>
							)}
							{onDelete && (
								<Button
									variant="secondary"
									size="sm"
									onClick={() => {
										for (const id of selectedIds) {
											onDelete(id);
										}
										setSelectedIds(new Set());
									}}
								>
									Delete
								</Button>
							)}
							<Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
								Clear selection
							</Button>
						</div>
					)}

					{/* Table */}
					<div className="rounded-md border overflow-x-auto">
						<table ref={tableRef} className="w-full" tabIndex={0}>
							<thead>
								<tr className="border-b bg-kumo-tint/50">
									<th scope="col" className="w-10 px-4 py-3">
										<input
											type="checkbox"
											checked={allPageSelected}
											onChange={toggleSelectAll}
											aria-label="Select all"
											className="h-4 w-4 rounded border-kumo-border"
										/>
									</th>
									<SortableHeader
										label="Title"
										field="title"
										sortField={sortField}
										sortDir={sortDir}
										onSort={handleSort}
									/>
									<SortableHeader
										label="Status"
										field="status"
										sortField={sortField}
										sortDir={sortDir}
										onSort={handleSort}
									/>
									{i18n && (
										<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
											Locale
										</th>
									)}
									<SortableHeader
										label="Date"
										field="date"
										sortField={sortField}
										sortDir={sortDir}
										onSort={handleSort}
									/>
									<th scope="col" className="px-4 py-3 text-right text-sm font-medium">
										Actions
									</th>
								</tr>
							</thead>
							<tbody>
								{items.length === 0 && !isLoading ? (
									<tr>
										<td colSpan={i18n ? 6 : 5} className="px-4 py-8 text-center text-kumo-subtle">
											No {collectionLabel.toLowerCase()} yet.{" "}
											<Link
												to="/content/$collection/new"
												params={{ collection }}
												className="text-kumo-brand underline"
											>
												Create your first one
											</Link>
										</td>
									</tr>
								) : paginatedItems.length === 0 ? (
									<tr>
										<td colSpan={i18n ? 6 : 5} className="px-4 py-8 text-center text-kumo-subtle">
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
											selected={selectedIds.has(item.id)}
											focused={index === focusedIndex}
											onToggleSelect={() => toggleSelection(item.id)}
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
								{sortedItems.length} {sortedItems.length === 1 ? "item" : "items"}
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
	selected?: boolean;
	focused?: boolean;
	onToggleSelect?: () => void;
}

function ContentListItem({
	item,
	collection,
	onDelete,
	onDuplicate,
	showLocale,
	selected,
	focused,
	onToggleSelect,
}: ContentListItemProps) {
	const title = getItemTitle(item);
	const date = new Date(item.updatedAt || item.createdAt);

	return (
		<tr
			className={cn(
				"border-b hover:bg-kumo-tint/25",
				selected && "bg-kumo-brand/5",
				focused && "ring-2 ring-inset ring-kumo-brand/40",
			)}
		>
			<td className="w-10 px-4 py-3">
				<input
					type="checkbox"
					checked={!!selected}
					onChange={() => onToggleSelect?.()}
					aria-label={`Select ${title}`}
					className="h-4 w-4 rounded border-kumo-border"
				/>
			</td>
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

function SortableHeader({
	label,
	field,
	sortField,
	sortDir,
	onSort,
}: {
	label: string;
	field: SortField;
	sortField: SortField;
	sortDir: SortDir;
	onSort: (field: SortField) => void;
}) {
	const isActive = sortField === field;
	return (
		<th scope="col" className="px-4 py-3 text-left text-sm font-medium">
			<button
				type="button"
				className="inline-flex items-center gap-1 hover:text-kumo-brand"
				onClick={() => onSort(field)}
			>
				{label}
				{isActive &&
					(sortDir === "asc" ? (
						<CaretUp className="h-3 w-3" aria-hidden="true" />
					) : (
						<CaretDown className="h-3 w-3" aria-hidden="true" />
					))}
			</button>
		</th>
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
