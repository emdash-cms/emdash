/**
 * Reference Picker Modal
 *
 * A modal for choosing entries to link into a reference field. Unlike the
 * shared ContentPickerModal it is locked to a single target collection (no
 * collection dropdown) and supports multi-select + confirm when the field is
 * `multiple`, or single click-to-choose when it isn't. Chosen entries are
 * emitted with their resolved titles so the field can render labels for newly
 * added rows without a refetch.
 */

import { Button, Checkbox, Dialog, Input, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, FolderOpen, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchContentList, getDraftStatus } from "../lib/api";
import type { ContentItem } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";
import { cn } from "../lib/utils";

/** A chosen reference entry, carrying a display title for the field renderer. */
export interface ReferencePickerRow {
	id: string;
	slug: string | null;
	title: string;
}

interface ReferencePickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The reference field's target collection. */
	collection: string;
	/** Whether the field accepts multiple entries. */
	multiple: boolean;
	/** Ids already selected in the field — rendered checked and disabled. */
	selectedIds: Set<string>;
	/** Emit the chosen entries. For single-select this is a one-element array. */
	onConfirm: (rows: ReferencePickerRow[]) => void;
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

export function ReferencePickerModal({
	open,
	onOpenChange,
	collection,
	multiple,
	selectedIds,
	onConfirm,
}: ReferencePickerModalProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const debouncedSearch = useDebouncedValue(searchQuery, 300);
	const [allItems, setAllItems] = React.useState<ContentItem[]>([]);
	const [nextCursor, setNextCursor] = React.useState<string | undefined>();
	const [isLoadingMore, setIsLoadingMore] = React.useState(false);
	// Staged picks (multi-select mode) — keyed by id so we retain title/slug.
	const [picked, setPicked] = React.useState<Record<string, ReferencePickerRow>>({});

	// Server-side search: the query key includes the debounced term so a new
	// slice is fetched rather than filtered client-side (mirrors the list view).
	const { data: contentResult, isLoading: contentLoading } = useQuery({
		queryKey: ["reference-picker", collection, { search: debouncedSearch, limit: 50 }],
		queryFn: () =>
			fetchContentList(collection, {
				limit: 50,
				search: debouncedSearch || undefined,
			}),
		enabled: open && !!collection,
	});

	// Sync the first page into the accumulated list whenever the query result
	// changes (new search term or reopen).
	React.useEffect(() => {
		if (contentResult) {
			setAllItems(contentResult.items);
			setNextCursor(contentResult.nextCursor);
		}
	}, [contentResult]);

	// Reset transient state when the modal opens.
	React.useEffect(() => {
		if (open) {
			setSearchQuery("");
			setAllItems([]);
			setNextCursor(undefined);
			setPicked({});
		}
	}, [open]);

	const handleLoadMore = async () => {
		if (!nextCursor || isLoadingMore) return;
		setIsLoadingMore(true);
		try {
			const result = await fetchContentList(collection, {
				limit: 50,
				cursor: nextCursor,
				search: debouncedSearch || undefined,
			});
			setAllItems((prev) => [...prev, ...result.items]);
			setNextCursor(result.nextCursor);
		} finally {
			setIsLoadingMore(false);
		}
	};

	const togglePicked = (item: ContentItem) => {
		setPicked((prev) => {
			const next = { ...prev };
			if (next[item.id]) {
				delete next[item.id];
			} else {
				next[item.id] = { id: item.id, slug: item.slug, title: getItemTitle(item) };
			}
			return next;
		});
	};

	const handleSingleChoose = (item: ContentItem) => {
		onConfirm([{ id: item.id, slug: item.slug, title: getItemTitle(item) }]);
		onOpenChange(false);
	};

	const handleConfirmMultiple = () => {
		onConfirm(Object.values(picked));
		onOpenChange(false);
	};

	const pickedCount = Object.keys(picked).length;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog className="p-6 max-w-2xl h-[80vh] flex flex-col" size="lg">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
						{multiple ? t`Add references` : t`Choose a reference`}
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

				{/* Search */}
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
				</div>

				{/* Content list */}
				<div className="flex-1 overflow-y-auto py-4">
					{contentLoading ? (
						<div className="flex items-center justify-center h-32">
							<div className="text-kumo-subtle">{t`Loading content...`}</div>
						</div>
					) : allItems.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 text-center">
							{debouncedSearch ? (
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
							{allItems.map((item) => {
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
							{nextCursor && (
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
