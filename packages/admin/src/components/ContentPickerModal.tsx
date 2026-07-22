/**
 * Content Picker Modal
 *
 * A modal for browsing and selecting content entries. Serves two callers:
 *
 * - **Menus** browse across collections (a collection dropdown is shown) and
 *   pick a single entry.
 * - **Reference fields** lock to a single target collection (dropdown hidden),
 *   and either pick one entry or stage several (`multiple`), disabling entries
 *   already linked (`selectedIds`).
 *
 * Search is served by the content list's `q` filter, which uses the
 * collection's FTS5 index when available (LIKE fallback otherwise) — the same
 * search the admin content list uses. Results are cursor-paginated through
 * `useInfiniteQuery` so pages accumulate in the query cache; nothing is
 * mirrored into local state, so reopening the modal shows the cached results
 * immediately rather than an empty list.
 */

import { Button, Checkbox, Dialog, Input, Loader, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, FolderOpen, X } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchCollections, fetchContentList, getDraftStatus } from "../lib/api";
import type { ContentItem } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";
import { cn } from "../lib/utils";

/** A chosen content entry, carrying its collection and a display title. */
export interface PickedContentEntry {
	collection: string;
	id: string;
	slug: string | null;
	title: string;
	/** Locale of the picked variant, so links/badges keep locale context before hydration. */
	locale?: string;
}

interface ContentPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Lock the picker to a single collection and hide the dropdown (reference
	 * fields). When omitted, a collection dropdown is shown (menus).
	 */
	collection?: string;
	/** Allow staging several entries before confirming. Defaults to single-select. */
	multiple?: boolean;
	/** Ids already linked in the target field — rendered checked and disabled. */
	selectedIds?: ReadonlySet<string>;
	/** Emit the chosen entries. Single-select emits a one-element array. */
	onConfirm: (rows: PickedContentEntry[]) => void;
	/** Optional dialog title override. */
	title?: string;
	/**
	 * The editing entry's locale (reference fields). When set, translations of the
	 * same entry collapse to one row, preferring this locale and falling back to
	 * another when the entry has no variant here — mirroring how the reference
	 * list resolves edges (`resolveEntries`/`pickVariant`). Edges are keyed by
	 * translation group, so a cross-locale target is still a valid pick.
	 */
	locale?: string;
}

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

const EMPTY_SELECTED: ReadonlySet<string> = new Set<string>();

export function ContentPickerModal({
	open,
	onOpenChange,
	collection,
	multiple = false,
	selectedIds = EMPTY_SELECTED,
	onConfirm,
	title,
	locale,
}: ContentPickerModalProps) {
	const { t } = useLingui();
	const locked = !!collection;
	const [searchQuery, setSearchQuery] = React.useState("");
	const debouncedSearch = useDebouncedValue(searchQuery, 300);
	const [dropdownCollection, setDropdownCollection] = React.useState<string>("");
	// Staged picks (multiple mode) — keyed by id so we retain title/slug.
	const [picked, setPicked] = React.useState<Record<string, PickedContentEntry>>({});

	const { data: collections = [] } = useQuery({
		queryKey: ["collections"],
		queryFn: fetchCollections,
		enabled: open && !locked,
	});

	// Default the dropdown to the first collection once collections load.
	React.useEffect(() => {
		if (!locked && collections.length > 0 && !dropdownCollection) {
			setDropdownCollection(collections[0]!.slug);
		}
	}, [locked, collections, dropdownCollection]);

	const activeCollection = collection ?? dropdownCollection;

	// Reset transient UI state when the modal opens. Result pages come from the
	// query cache (below), so there is nothing to re-fetch or re-sync here.
	React.useEffect(() => {
		if (open) {
			setSearchQuery("");
			setPicked({});
			if (!locked) setDropdownCollection("");
		}
	}, [open, locked]);

	const trimmedSearch = debouncedSearch.trim();
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
		queryKey: ["content-picker", activeCollection, trimmedSearch],
		queryFn: ({ pageParam }) =>
			fetchContentList(activeCollection, {
				limit: 50,
				cursor: pageParam,
				search: trimmedSearch || undefined,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		enabled: open && !!activeCollection,
	});

	const items = React.useMemo(() => {
		const flat = data?.pages.flatMap((page) => page.items) ?? [];
		if (!locale) return flat;
		// Reference fields link by translation group, so translations of the same
		// entry are the same target. Collapse them to one row, preferring the
		// editor locale and falling back to the lowest locale code (deterministic),
		// mirroring `pickVariant` in the reference-list resolver.
		const byGroup = new Map<string, ContentItem>();
		const order: string[] = [];
		for (const item of flat) {
			const key = item.translationGroup ?? item.id;
			const existing = byGroup.get(key);
			if (!existing) {
				byGroup.set(key, item);
				order.push(key);
			} else if (
				existing.locale !== locale &&
				(item.locale === locale || item.locale < existing.locale)
			) {
				byGroup.set(key, item);
			}
		}
		return order.map((key) => byGroup.get(key)!);
	}, [data, locale]);

	const togglePicked = (item: ContentItem) => {
		setPicked((prev) => {
			const next = { ...prev };
			if (next[item.id]) {
				delete next[item.id];
			} else {
				next[item.id] = {
					collection: activeCollection,
					id: item.id,
					slug: item.slug,
					title: getItemTitle(item),
					locale: item.locale,
				};
			}
			return next;
		});
	};

	const handleSingleChoose = (item: ContentItem) => {
		onConfirm([
			{
				collection: activeCollection,
				id: item.id,
				slug: item.slug,
				title: getItemTitle(item),
				locale: item.locale,
			},
		]);
		onOpenChange(false);
	};

	const handleConfirmMultiple = () => {
		onConfirm(Object.values(picked));
		onOpenChange(false);
	};

	const pickedCount = Object.keys(picked).length;
	const dialogTitle = title ?? (multiple ? t`Add references` : t`Select content`);

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 max-w-2xl h-[80vh] flex flex-col" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
						{dialogTitle}
					</Dialog.Title>
					<Dialog.Close
						aria-label={t`Close`}
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label={t`Close`}
								className="absolute end-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">{t`Close`}</span>
							</Button>
						)}
					/>
				</div>

				{/* Search and (unlocked) collection filter */}
				<div className="flex items-center gap-4 py-4 border-b">
					<div className="relative flex-1">
						<MagnifyingGlass className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
						<Input
							placeholder={t`Search content...`}
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="ps-10"
							autoFocus
						/>
					</div>
					{!locked && (
						<Select
							value={dropdownCollection}
							onValueChange={(v) => {
								setDropdownCollection(v ?? "");
								setPicked({});
							}}
							items={Object.fromEntries(collections.map((col) => [col.slug, col.label]))}
							aria-label={t`Collection`}
						/>
					)}
				</div>

				{/* Content list */}
				<div className="flex-1 overflow-y-auto py-4">
					{isLoading ? (
						<div className="flex items-center justify-center h-32">
							<div className="text-kumo-subtle">{t`Loading content...`}</div>
						</div>
					) : items.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							{trimmedSearch ? (
								<>
									<MagnifyingGlass className="h-8 w-8 text-kumo-subtle mb-2" />
									<p className="text-kumo-subtle">{t`No content found`}</p>
									<p className="text-sm text-kumo-subtle">{t`Try adjusting your search`}</p>
								</>
							) : (
								<>
									<FolderOpen className="h-8 w-8 text-kumo-subtle mb-2" />
									<p className="text-kumo-subtle">{t`No content in this collection`}</p>
								</>
							)}
						</div>
					) : (
						<div className="space-y-1">
							{items.map((item) => {
								const status = getDraftStatus(item);
								const alreadyLinked = selectedIds.has(item.id);
								const isPicked = alreadyLinked || !!picked[item.id];
								const statusDot = (
									<span
										className={cn(
											"inline-block h-2 w-2 rounded-full",
											status === "published"
												? "bg-kumo-success"
												: status === "published_with_changes"
													? "bg-kumo-warning"
													: "bg-kumo-fill",
										)}
									/>
								);
								const statusLabel =
									status === "published"
										? t`Published`
										: status === "published_with_changes"
											? t`Modified`
											: t`Draft`;
								const meta = (
									<div className="text-sm text-kumo-subtle flex items-center gap-2">
										{statusDot}
										{statusLabel}
										{item.slug && (
											<>
												<span className="text-kumo-subtle/50">/</span>
												<span>{item.slug}</span>
											</>
										)}
									</div>
								);

								if (multiple) {
									return (
										<label
											key={item.id}
											className={cn(
												"flex items-start gap-3 rounded-md px-3 py-2 transition-colors",
												alreadyLinked ? "opacity-60" : "cursor-pointer hover:bg-kumo-tint/50",
											)}
										>
											<Checkbox
												checked={isPicked}
												disabled={alreadyLinked}
												onCheckedChange={() => togglePicked(item)}
												aria-label={getItemTitle(item)}
											/>
											<div className="min-w-0">
												<div className="font-medium">{getItemTitle(item)}</div>
												{meta}
											</div>
										</label>
									);
								}

								return (
									<button
										key={item.id}
										type="button"
										disabled={alreadyLinked}
										onClick={() => handleSingleChoose(item)}
										className={cn(
											"w-full text-start rounded-md px-3 py-2 transition-colors",
											alreadyLinked
												? "opacity-60"
												: "hover:bg-kumo-tint/50 focus:outline-none focus:ring-2 focus:ring-kumo-ring focus:ring-offset-2",
										)}
									>
										<div className="font-medium">{getItemTitle(item)}</div>
										{meta}
									</button>
								);
							})}
							{hasNextPage && (
								<div className="pt-2 text-center">
									<Button
										variant="outline"
										size="sm"
										onClick={() => void fetchNextPage()}
										disabled={isFetchingNextPage}
									>
										{isFetchingNextPage ? (
											<>
												<Loader size="sm" /> {t`Loading...`}
											</>
										) : (
											t`Load more`
										)}
									</Button>
								</div>
							)}
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-2 pt-4 border-t">
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t`Cancel`}
					</Button>
					{multiple && (
						<Button onClick={handleConfirmMultiple} disabled={pickedCount === 0}>
							{t`Add selected`}
						</Button>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
