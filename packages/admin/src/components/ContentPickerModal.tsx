/**
 * Content Picker Modal
 *
 * A modal for browsing and selecting content items to add to menus.
 * Uses cursor pagination to allow browsing beyond the initial page.
 */

import { Button, Dialog, Input, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, FolderOpen, X } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchCollections, fetchContentList, getDraftStatus } from "../lib/api";
import type { ContentItem } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";
import { cn } from "../lib/utils";

interface ContentPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (item: { collection: string; id: string; title: string }) => void;
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

export function ContentPickerModal({ open, onOpenChange, onSelect }: ContentPickerModalProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const debouncedSearch = useDebouncedValue(searchQuery, 300);
	const [selectedCollection, setSelectedCollection] = React.useState<string>("");
	const [allItems, setAllItems] = React.useState<ContentItem[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();
	const [isLoadingMore, setIsLoadingMore] = React.useState(false);

	const { data: collections = [] } = useQuery({
		queryKey: ["collections"],
		queryFn: fetchCollections,
		enabled: open,
	});

	// Default to first collection when collections load
	React.useEffect(() => {
		if (collections.length > 0 && !selectedCollection) {
			setSelectedCollection(collections[0]!.slug);
		}
	}, [collections, selectedCollection]);

	// Push search to the server so the picker can find items across the
	// entire collection, not just whatever has already been scrolled into
	// view. Falls back to no-search when the box is empty.
	const searchParam = debouncedSearch.trim() || undefined;
	const { data: contentResult, isLoading: contentLoading } = useQuery({
		queryKey: ["content-picker", selectedCollection, { limit: 50, q: searchParam }],
		queryFn: () => fetchContentList(selectedCollection, { limit: 50, q: searchParam }),
		enabled: open && !!selectedCollection,
		// Keep the previous page's rows visible while the debounced search
		// refetches, so the list doesn't flash to empty between keystrokes.
		placeholderData: keepPreviousData,
	});

	// Sync initial page into accumulated items. The query re-runs when the
	// debounced search changes, so we reset the accumulator each time.
	React.useEffect(() => {
		if (contentResult) {
			setAllItems(contentResult.items);
			setNextCursor(contentResult.nextCursor);
		}
	}, [contentResult]);

	const handleLoadMore = async () => {
		if (!nextCursor || isLoadingMore) return;
		setIsLoadingMore(true);
		try {
			const result = await fetchContentList(selectedCollection, {
				limit: 50,
				cursor: nextCursor,
				q: searchParam,
			});
			setAllItems((prev) => [...prev, ...result.items]);
			setNextCursor(result.nextCursor);
		} finally {
			setIsLoadingMore(false);
		}
	};

	// Items arrive pre-filtered from the server; alias for readability.
	const filteredItems = allItems;

	// Reset state when modal opens or collection changes
	React.useEffect(() => {
		if (open) {
			setSearchQuery("");
			setSelectedCollection("");
			setAllItems([]);
			setNextCursor(undefined);
		}
	}, [open]);

	const handleSelect = (item: ContentItem) => {
		onSelect({
			collection: selectedCollection,
			id: item.id,
			title: getItemTitle(item),
		});
		onOpenChange(false);
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 max-w-2xl h-[80vh] flex flex-col" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
						{t`Select Content`}
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

				{/* Search and collection filter */}
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
					<select
						value={selectedCollection}
						onChange={(e) => {
							setSelectedCollection(e.target.value);
							setAllItems([]);
							setNextCursor(undefined);
						}}
						className="h-10 rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-kumo-ring focus:ring-offset-2"
					>
						{collections.map((col) => (
							<option key={col.slug} value={col.slug}>
								{col.label}
							</option>
						))}
					</select>
				</div>

				{/* Content list */}
				<div className="flex-1 overflow-y-auto py-4">
					{contentLoading ? (
						<div className="flex items-center justify-center h-32">
							<div className="text-kumo-subtle">{t`Loading content...`}</div>
						</div>
					) : filteredItems.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							{searchQuery ? (
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
							{filteredItems.map((item) => {
								const status = getDraftStatus(item);
								return (
									<button
										key={item.id}
										type="button"
										onClick={() => handleSelect(item)}
										className={cn(
											"w-full text-start rounded-md px-3 py-2 transition-colors",
											"hover:bg-kumo-tint/50",
											"focus:outline-none focus:ring-2 focus:ring-kumo-ring focus:ring-offset-2",
										)}
									>
										<div className="font-medium">{getItemTitle(item)}</div>
										<div className="text-sm text-kumo-subtle flex items-center gap-2">
											<span
												className={cn(
													"inline-block h-2 w-2 rounded-full",
													status === "published"
														? "bg-green-500"
														: status === "published_with_changes"
															? "bg-yellow-500"
															: "bg-gray-400",
												)}
											/>
											{status === "published"
												? t`Published`
												: status === "published_with_changes"
													? t`Modified`
													: t`Draft`}
											{item.slug && (
												<>
													<span className="text-kumo-subtle/50">/</span>
													<span>{item.slug}</span>
												</>
											)}
										</div>
									</button>
								);
							})}
							{nextCursor && !searchQuery && (
								<div className="pt-2 text-center">
									<Button
										variant="outline"
										size="sm"
										onClick={handleLoadMore}
										disabled={isLoadingMore}
									>
										{isLoadingMore ? (
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
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
