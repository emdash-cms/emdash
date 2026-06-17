import { Badge, Button, Dialog, Input, LinkButton, Loader, Select, Tabs } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	Pencil,
	Trash,
	ArrowCounterClockwise,
	ArrowSquareOut,
	Copy,
	MagnifyingGlass,
	CaretUp,
	CaretDown,
	CaretUpDown,
	X,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { ContentAuthor, ContentDateField, ContentItem, TrashedContentItem } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks.js";
import { contentUrl } from "../lib/url.js";
import { cn } from "../lib/utils";
import { CaretNext, CaretPrev } from "./ArrowIcons.js";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { RouterLinkButton } from "./RouterLinkButton.js";

/** Sortable content list columns. Maps to the server's order field whitelist. */
export type ContentListSortField = "title" | "status" | "locale" | "updatedAt";
export interface ContentListSort {
	field: ContentListSortField;
	direction: "asc" | "desc";
}

/** Status filter values. `"all"` clears the status filter. */
export type ContentStatusFilter = "all" | "published" | "draft" | "scheduled" | "archived";

/**
 * Date-range filter state. `from`/`to` are raw `YYYY-MM-DD` values from the
 * date inputs (empty string = unset); the parent converts them to UTC day
 * boundaries before calling the API.
 */
export interface ContentDateFilter {
	field: ContentDateField;
	from: string;
	to: string;
}

/** An empty (inactive) date filter, defaulting to the created-at column. */
export const EMPTY_DATE_FILTER: ContentDateFilter = { field: "createdAt", from: "", to: "" };

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
	/** URL pattern for published content links (e.g. `/blog/{slug}`) */
	urlPattern?: string;
	/**
	 * Controlled sort state. When `onSortChange` is also provided, the column
	 * headers become sort controls that invoke it. Uncontrolled sort keeps
	 * the backward-compatible "static headers, server-default ordering"
	 * behavior for callers that haven't opted in yet.
	 */
	sort?: ContentListSort;
	onSortChange?: (sort: ContentListSort) => void;
	/**
	 * Total rows matching the current filters (ignoring pagination). When
	 * set, the pagination denominator reflects this stable count instead of
	 * growing as more API pages are fetched.
	 */
	total?: number;
	/**
	 * When provided, search is performed server-side: the (debounced) query is
	 * reported here so the caller can refetch, and `items`/`total` are assumed
	 * to already reflect the filter. Without it, the list falls back to
	 * filtering the loaded page client-side (legacy behavior).
	 */
	onSearchChange?: (q: string) => void;
	/**
	 * Filter controls. The whole bar is opt-in: it only renders when
	 * `onStatusFilterChange` is provided, keeping the component
	 * backward-compatible for callers that haven't wired filters yet. Each
	 * control renders independently based on the presence of its callback
	 * (and, for the author filter, a non-empty `authors` list).
	 */
	statusFilter?: ContentStatusFilter;
	onStatusFilterChange?: (status: ContentStatusFilter) => void;
	/** Authors who have content in this collection, for the author filter. */
	authors?: ContentAuthor[];
	/** Selected author id; empty string means "all authors". */
	authorFilter?: string;
	onAuthorFilterChange?: (authorId: string) => void;
	/** Controlled date-range filter state. */
	dateFilter?: ContentDateFilter;
	onDateFilterChange?: (filter: ContentDateFilter) => void;
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
	urlPattern,
	sort,
	onSortChange,
	total,
	onSearchChange,
	statusFilter = "all",
	onStatusFilterChange,
	authors,
	authorFilter = "",
	onAuthorFilterChange,
	dateFilter = EMPTY_DATE_FILTER,
	onDateFilterChange,
}: ContentListProps) {
	const { t } = useLingui();
	const [activeTab, setActiveTab] = React.useState<ViewTab>("all");
	const [searchQuery, setSearchQuery] = React.useState("");
	const [page, setPage] = React.useState(0);

	// Server-side search mode: the caller refetches based on the (debounced)
	// query, so `items`/`total` already reflect the filter and we must not
	// re-filter client-side (that would re-introduce the "only matches the
	// loaded page" bug for non-title columns).
	const serverSearch = !!onSearchChange;
	const debouncedSearch = useDebouncedValue(searchQuery, 300);
	React.useEffect(() => {
		if (onSearchChange) onSearchChange(debouncedSearch.trim());
	}, [debouncedSearch, onSearchChange]);

	// Reset page when search changes
	const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearchQuery(e.target.value);
		setPage(0);
	};

	const filteredItems = React.useMemo(() => {
		if (serverSearch || !searchQuery) return items;
		const query = searchQuery.toLowerCase();
		return items.filter((item) => getItemTitle(item).toLowerCase().includes(query));
	}, [items, searchQuery, serverSearch]);

	// The query the current `items` reflect: server-side filtering lags behind
	// typing by the debounce, so the empty-state message must use the debounced
	// term; client-side filtering is immediate, so it uses the live query.
	const activeSearch = serverSearch ? debouncedSearch.trim() : searchQuery;

	// When the server reports a total, it's the source of truth for the
	// denominator. In server-search mode that total already reflects the query,
	// so we use it even while searching; in client mode an active query falls
	// back to the filtered client count.
	const effectiveTotal =
		typeof total === "number" && (serverSearch || !searchQuery) ? total : filteredItems.length;
	const totalPages = Math.max(1, Math.ceil(effectiveTotal / PAGE_SIZE));

	// Clamp the current page in case filters collapse the count (user was on
	// page 5 of 10, then typed a query narrowing to 1 page). Without clamping
	// we'd render an empty table until the next refetch.
	const clampedPage = Math.min(page, totalPages - 1);
	const paginatedItems = filteredItems.slice(
		clampedPage * PAGE_SIZE,
		(clampedPage + 1) * PAGE_SIZE,
	);

	// Auto-fetch the next API page when the user is on a client page whose
	// items haven't been loaded yet. Skip during client-side search because
	// filtering can collapse `filteredItems` below the loaded count and
	// trigger a spurious fetch.
	//
	// Safety: relies on `onLoadMore` being deduped against concurrent calls.
	// The router wires this to TanStack Query's `fetchNextPage`, which is
	// idempotent while a fetch is in flight.
	React.useEffect(() => {
		// In client-search mode we skip auto-fetch while a query is active
		// (filtering can collapse the list). In server-search mode the loaded
		// items already are the matches, so paging forward should keep fetching.
		if (!hasMore || !onLoadMore || (!serverSearch && searchQuery)) return;
		const loadedPages = Math.ceil(filteredItems.length / PAGE_SIZE);
		if (clampedPage >= loadedPages - 1) {
			onLoadMore();
		}
	}, [clampedPage, filteredItems.length, hasMore, onLoadMore, searchQuery, serverSearch]);

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
				<RouterLinkButton
					to="/content/$collection/new"
					params={{ collection }}
					search={{ locale: activeLocale }}
					icon={<Plus />}
				>
					{t`Add New`}
				</RouterLinkButton>
			</div>

			{/* Search */}
			{(serverSearch || items.length > 0) && (
				<div className="relative max-w-sm">
					<MagnifyingGlass className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
					<Input
						type="search"
						placeholder={t`Search ${collectionLabel.toLowerCase()}...`}
						aria-label={t`Search ${collectionLabel.toLowerCase()}`}
						value={searchQuery}
						onChange={handleSearchChange}
						className="ps-9"
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
					{ value: "all", label: t`All` },
					{
						value: "trash",
						label: (
							<span className="flex items-center gap-2">
								<Trash className="h-4 w-4" aria-hidden="true" />
								{t`Trash`}
								{trashedCount > 0 && <Badge variant="secondary">{trashedCount}</Badge>}
							</span>
						),
					},
				]}
			/>

			{/* Content based on active tab */}
			{activeTab === "all" ? (
				<>
					{/* Filters */}
					{onStatusFilterChange && (
						<FilterBar
							statusFilter={statusFilter}
							onStatusFilterChange={onStatusFilterChange}
							authors={authors}
							authorFilter={authorFilter}
							onAuthorFilterChange={onAuthorFilterChange}
							dateFilter={dateFilter}
							onDateFilterChange={onDateFilterChange}
						/>
					)}

					{/* Table */}
					<div className="rounded-md border bg-kumo-base overflow-x-auto">
						<table className="w-full">
							<thead>
								<tr className="border-b bg-kumo-tint/50">
									<SortableTh
										field="title"
										sort={sort}
										onSortChange={onSortChange}
										label={t`Title`}
									/>
									<SortableTh
										field="status"
										sort={sort}
										onSortChange={onSortChange}
										label={t`Status`}
									/>
									{i18n && (
										<SortableTh
											field="locale"
											sort={sort}
											onSortChange={onSortChange}
											label={t`Locale`}
										/>
									)}
									<SortableTh
										field="updatedAt"
										sort={sort}
										onSortChange={onSortChange}
										label={t`Date`}
									/>
									<th scope="col" className="px-4 py-3 text-end text-sm font-medium">
										{t`Actions`}
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-kumo-line">
								{isLoading && items.length === 0 ? (
									<tr>
										<td colSpan={i18n ? 5 : 4} className="px-4 py-8 text-center text-kumo-subtle">
											<span className="inline-flex items-center gap-2">
												<Loader size="sm" />
												{t`Loading...`}
											</span>
										</td>
									</tr>
								) : items.length === 0 ? (
									<tr>
										<td colSpan={i18n ? 5 : 4} className="px-4 py-8 text-center text-kumo-subtle">
											{activeSearch ? (
												t`No results for "${activeSearch}"`
											) : (
												<>
													{t`No ${collectionLabel.toLowerCase()} yet.`}{" "}
													<Link
														to="/content/$collection/new"
														params={{ collection }}
														search={{ locale: activeLocale }}
														className="text-kumo-brand underline"
													>
														{t`Create your first one`}
													</Link>
												</>
											)}
										</td>
									</tr>
								) : paginatedItems.length === 0 ? (
									<tr>
										<td colSpan={i18n ? 5 : 4} className="px-4 py-8 text-center text-kumo-subtle">
											{t`No results for "${activeSearch}"`}
										</td>
									</tr>
								) : (
									paginatedItems.map((item) => (
										<ContentListItem
											key={item.id}
											item={item}
											collection={collection}
											onDelete={onDelete}
											onDuplicate={onDuplicate}
											showLocale={!!i18n}
											urlPattern={urlPattern}
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
								{renderItemCount({
									searchQuery: activeSearch,
									filteredCount: filteredItems.length,
									total,
									hasMore,
									serverSearch,
								})}
							</span>
							<div className="flex items-center gap-2">
								<Button
									variant="outline"
									shape="square"
									disabled={clampedPage === 0}
									onClick={() => setPage(clampedPage - 1)}
									aria-label={t`Previous page`}
								>
									<CaretPrev className="h-4 w-4" aria-hidden="true" />
								</Button>
								<span className="text-sm">
									{clampedPage + 1} / {totalPages}
								</span>
								<Button
									variant="outline"
									shape="square"
									disabled={clampedPage >= totalPages - 1}
									onClick={() => setPage(clampedPage + 1)}
									aria-label={t`Next page`}
								>
									<CaretNext className="h-4 w-4" aria-hidden="true" />
								</Button>
							</div>
						</div>
					)}

					{/* Load more */}
					{hasMore && (
						<div className="flex justify-center">
							<Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
								{isLoading ? t`Loading...` : t`Load More`}
							</Button>
						</div>
					)}
				</>
			) : (
				<>
					{/* Trash Table */}
					<div className="rounded-md border bg-kumo-base overflow-x-auto">
						<table className="w-full">
							<thead>
								<tr className="border-b bg-kumo-tint/50">
									<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
										{t`Title`}
									</th>
									<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
										{t`Deleted`}
									</th>
									<th scope="col" className="px-4 py-3 text-end text-sm font-medium">
										{t`Actions`}
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-kumo-line">
								{isTrashedLoading && trashedItems.length === 0 ? (
									<tr>
										<td colSpan={3} className="px-4 py-8 text-center text-kumo-subtle">
											<span className="inline-flex items-center gap-2">
												<Loader size="sm" />
												{t`Loading...`}
											</span>
										</td>
									</tr>
								) : trashedItems.length === 0 ? (
									<tr>
										<td colSpan={3} className="px-4 py-8 text-center text-kumo-subtle">
											{t`Trash is empty`}
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
								{isTrashedLoading ? t`Loading...` : t`Load More`}
							</Button>
						</div>
					)}
				</>
			)}
		</div>
	);
}

interface FilterBarProps {
	statusFilter: ContentStatusFilter;
	onStatusFilterChange: (status: ContentStatusFilter) => void;
	authors?: ContentAuthor[];
	authorFilter: string;
	onAuthorFilterChange?: (authorId: string) => void;
	dateFilter: ContentDateFilter;
	onDateFilterChange?: (filter: ContentDateFilter) => void;
}

/**
 * Filter controls for the content list: status, author, and a date range over
 * a chosen timestamp column (#1288). All controls report changes to the
 * parent, which owns the state and refetches. Filtering happens server-side,
 * so it works across the whole collection rather than the loaded page.
 */
function FilterBar({
	statusFilter,
	onStatusFilterChange,
	authors,
	authorFilter,
	onAuthorFilterChange,
	dateFilter,
	onDateFilterChange,
}: FilterBarProps) {
	const { t } = useLingui();

	const showAuthorFilter = !!onAuthorFilterChange && !!authors && authors.length > 0;
	const showDateFilter = !!onDateFilterChange;

	const statusItems: Record<string, string> = {
		all: t`All statuses`,
		published: t`Published`,
		draft: t`Draft`,
		scheduled: t`Scheduled`,
		archived: t`Archived`,
	};

	const dateFieldItems: Record<string, string> = {
		createdAt: t`Created`,
		updatedAt: t`Updated`,
		publishedAt: t`Published`,
	};

	const hasActiveFilter =
		statusFilter !== "all" || authorFilter !== "" || !!dateFilter.from || !!dateFilter.to;

	const handleClear = () => {
		onStatusFilterChange("all");
		onAuthorFilterChange?.("");
		onDateFilterChange?.(EMPTY_DATE_FILTER);
	};

	return (
		<div className="flex flex-wrap items-end gap-3">
			<Select
				size="sm"
				aria-label={t`Filter by status`}
				value={statusFilter}
				onValueChange={(v) => onStatusFilterChange((v as ContentStatusFilter) ?? "all")}
				items={statusItems}
			>
				{Object.entries(statusItems).map(([value, label]) => (
					<Select.Option key={value} value={value}>
						{label}
					</Select.Option>
				))}
			</Select>

			{showAuthorFilter && (
				<Select
					size="sm"
					aria-label={t`Filter by author`}
					value={authorFilter}
					onValueChange={(v) => onAuthorFilterChange?.(v ?? "")}
					items={{
						"": t`All authors`,
						...Object.fromEntries(authors.map((a) => [a.id, a.name || a.email])),
					}}
				>
					<Select.Option value="">{t`All authors`}</Select.Option>
					{authors.map((a) => (
						<Select.Option key={a.id} value={a.id}>
							{a.name || a.email}
						</Select.Option>
					))}
				</Select>
			)}

			{showDateFilter && (
				<div className="flex flex-wrap items-end gap-2">
					<Select
						size="sm"
						aria-label={t`Date field to filter on`}
						value={dateFilter.field}
						onValueChange={(v) =>
							onDateFilterChange?.({ ...dateFilter, field: (v as ContentDateField) ?? "createdAt" })
						}
						items={dateFieldItems}
					>
						{Object.entries(dateFieldItems).map(([value, label]) => (
							<Select.Option key={value} value={value}>
								{label}
							</Select.Option>
						))}
					</Select>
					<Input
						type="date"
						size="sm"
						aria-label={t`From date`}
						value={dateFilter.from}
						max={dateFilter.to || undefined}
						onChange={(e) => onDateFilterChange?.({ ...dateFilter, from: e.target.value })}
					/>
					<span className="pb-2 text-sm text-kumo-subtle">{t`to`}</span>
					<Input
						type="date"
						size="sm"
						aria-label={t`To date`}
						value={dateFilter.to}
						min={dateFilter.from || undefined}
						onChange={(e) => onDateFilterChange?.({ ...dateFilter, to: e.target.value })}
					/>
				</div>
			)}

			{hasActiveFilter && (
				<Button variant="ghost" size="sm" onClick={handleClear} icon={<X />}>
					{t`Clear filters`}
				</Button>
			)}
		</div>
	);
}

interface SortableThProps {
	field: ContentListSortField;
	sort: ContentListSort | undefined;
	onSortChange: ((sort: ContentListSort) => void) | undefined;
	label: string;
}

/**
 * Table header that doubles as a sort control when the parent opted in by
 * passing `onSortChange`. When no callback is provided we fall back to a
 * plain `<th>` so legacy callers (and screen readers) see exactly the same
 * markup as before this change.
 *
 * The button's accessible name is just the column label — the sort state
 * is conveyed via `aria-sort` on the <th>, which screen readers announce
 * automatically. Adding a verbose aria-label would make each header re-read
 * the sort instruction on every focus, which is noisy.
 */
function SortableTh({ field, sort, onSortChange, label }: SortableThProps) {
	const isActive = sort?.field === field;
	const direction = isActive ? sort?.direction : undefined;

	if (!onSortChange) {
		return (
			<th scope="col" className="px-4 py-3 text-start text-sm font-medium">
				{label}
			</th>
		);
	}

	const ariaSort: "ascending" | "descending" | "none" = isActive
		? direction === "asc"
			? "ascending"
			: "descending"
		: "none";

	const handleClick = () => {
		// Default to descending for a new column; toggle direction when
		// clicking the already-active one.
		if (isActive) {
			onSortChange({ field, direction: direction === "asc" ? "desc" : "asc" });
		} else {
			onSortChange({ field, direction: "desc" });
		}
	};

	const Icon = isActive ? (direction === "asc" ? CaretUp : CaretDown) : CaretUpDown;

	return (
		<th scope="col" aria-sort={ariaSort} className="px-4 py-3 text-start text-sm font-medium">
			<button
				type="button"
				onClick={handleClick}
				className={cn(
					"inline-flex items-center gap-1 rounded text-kumo-default hover:text-kumo-brand",
					"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand",
				)}
			>
				<span>{label}</span>
				<Icon className="h-3 w-3" aria-hidden="true" />
			</button>
		</th>
	);
}

/**
 * Render the row-count line above pagination. The rules are:
 * - A search query always wins — say how many matches there are. In
 *   server-search mode the server reports the full match count via `total`;
 *   `filteredCount` is only the loaded page, so it would undercount.
 * - When the server reported a total, use it (no `+` suffix needed —
 *   we know the count).
 * - Otherwise fall back to the pre-refactor behavior: loaded count,
 *   with `+` when there are more pages the user hasn't fetched yet.
 */
function renderItemCount({
	searchQuery,
	filteredCount,
	total,
	hasMore,
	serverSearch,
}: {
	searchQuery: string;
	filteredCount: number;
	total: number | undefined;
	hasMore: boolean | undefined;
	serverSearch: boolean;
}): string {
	if (searchQuery) {
		const matchCount = serverSearch && typeof total === "number" ? total : filteredCount;
		return plural(matchCount, {
			one: `# item matching "${searchQuery}"`,
			other: `# items matching "${searchQuery}"`,
		});
	}
	if (typeof total === "number") {
		return plural(total, {
			one: `# item`,
			other: `# items`,
		});
	}
	return plural(filteredCount, {
		one: `#${hasMore ? "+" : ""} item`,
		other: `#${hasMore ? "+" : ""} items`,
	});
}

interface ContentListItemProps {
	item: ContentItem;
	collection: string;
	onDelete?: (id: string) => void;
	onDuplicate?: (id: string) => void;
	showLocale?: boolean;
	urlPattern?: string;
}

function ContentListItem({
	item,
	collection,
	onDelete,
	onDuplicate,
	showLocale,
	urlPattern,
}: ContentListItemProps) {
	const { t } = useLingui();
	const title = getItemTitle(item);
	const date = new Date(item.updatedAt || item.createdAt);

	return (
		<tr className="hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<Link
					to="/content/$collection/$id"
					params={{ collection, id: item.id }}
					search={{ locale: item.locale }}
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
			<td className="px-4 py-3 text-end">
				<div className="flex items-center justify-end space-x-1">
					{item.status === "published" && item.slug && (
						<LinkButton
							href={contentUrl(collection, item.slug, urlPattern, item.publishedAt ?? item.updatedAt)}
							external
							variant="ghost"
							shape="square"
							aria-label={t`View published ${title}`}
							icon={<ArrowSquareOut />}
						/>
					)}
					<RouterLinkButton
						to="/content/$collection/$id"
						params={{ collection, id: item.id }}
						search={{ locale: item.locale }}
						aria-label={t`Edit ${title}`}
						variant="ghost"
						shape="square"
						icon={<Pencil />}
					/>
					<Button
						variant="ghost"
						shape="square"
						aria-label={t`Duplicate ${title}`}
						onClick={() => onDuplicate?.(item.id)}
					>
						<Copy className="h-4 w-4" aria-hidden="true" />
					</Button>
					<Dialog.Root disablePointerDismissal>
						<Dialog.Trigger
							render={(p) => (
								<Button
									{...p}
									variant="ghost"
									shape="square"
									aria-label={t`Move ${title} to trash`}
								>
									<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
								</Button>
							)}
						/>
						<Dialog className="p-6" size="sm">
							<Dialog.Title className="text-lg font-semibold">{t`Move to Trash?`}</Dialog.Title>
							<Dialog.Description className="text-kumo-subtle">
								{t`Move "${title}" to trash? You can restore it later.`}
							</Dialog.Description>
							<div className="mt-6 flex justify-end gap-2">
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="secondary">
											{t`Cancel`}
										</Button>
									)}
								/>
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="destructive" onClick={() => onDelete?.(item.id)}>
											{t`Move to Trash`}
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
	const { t } = useLingui();
	const title = getItemTitle(item);
	const deletedDate = new Date(item.deletedAt);

	return (
		<tr className="hover:bg-kumo-tint/25">
			<td className="px-4 py-3">
				<span className="font-medium text-kumo-subtle">{title}</span>
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{deletedDate.toLocaleDateString()}</td>
			<td className="px-4 py-3 text-end">
				<div className="flex items-center justify-end space-x-1">
					<Button
						variant="ghost"
						shape="square"
						aria-label={t`Restore ${title}`}
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
									aria-label={t`Permanently delete ${title}`}
								>
									<Trash className="h-4 w-4 text-kumo-danger" aria-hidden="true" />
								</Button>
							)}
						/>
						<Dialog className="p-6" size="sm">
							<Dialog.Title className="text-lg font-semibold">
								{t`Delete Permanently?`}
							</Dialog.Title>
							<Dialog.Description className="text-kumo-subtle">
								{t`Permanently delete "${title}"? This cannot be undone.`}
							</Dialog.Description>
							<div className="mt-6 flex justify-end gap-2">
								<Dialog.Close
									render={(p) => (
										<Button {...p} variant="secondary">
											{t`Cancel`}
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
											{t`Delete Permanently`}
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
	const { t } = useLingui();

	const statusLabel =
		status === "published"
			? t`published`
			: status === "draft"
				? t`draft`
				: status === "scheduled"
					? t`scheduled`
					: status === "archived"
						? t`archived`
						: status;

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
				{statusLabel}
			</span>
			{hasPendingChanges && <Badge variant="secondary">{t`pending`}</Badge>}
		</span>
	);
}
