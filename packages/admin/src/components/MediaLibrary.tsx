import { Button, Input, Loader, Select, Tabs } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Upload, Images, SquaresFour, List, MagnifyingGlass } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	type MediaItem,
	type MediaUploadOptions,
	type MediaProviderItem,
	MEDIA_SEARCH_MAX_LENGTH,
	fetchMediaProviders,
	fetchProviderMedia,
	uploadToProvider,
} from "../lib/api";
import { useDebouncedValue } from "../lib/hooks.js";
import {
	providerItemToMediaItem,
	getFileIcon,
	formatFileSize,
	getMediaThumbnailUrl,
	fallbackToOriginalThumbnail,
	MEDIA_THUMBNAIL_WIDTH,
	metaNumber,
} from "../lib/media-utils";
import { cn } from "../lib/utils";
import { MediaDetailPanel } from "./MediaDetailPanel";
import { LOCAL_MEDIA_UPLOAD_ACCEPT, MediaUploadDialog } from "./MediaUploadDialog.js";

/** Maps a coarse type-filter choice to the media list's `mimeType` filter. */
function mimeForTypeFilter(value: string): string | string[] | undefined {
	switch (value) {
		case "image":
			return "image/";
		case "video":
			return "video/";
		case "audio":
			return "audio/";
		case "document":
			return ["application/", "text/"];
		default:
			return undefined;
	}
}

export interface MediaLibraryProps {
	items?: MediaItem[];
	isLoading?: boolean;
	onUpload?: (file: File, options?: MediaUploadOptions) => Promise<void> | void;
	onSelect?: (item: MediaItem) => void;
	onItemUpdated?: () => void;
	/** True when more local-library items can be fetched via cursor pagination */
	hasMore?: boolean;
	/** Triggered to fetch the next page of local-library items */
	onLoadMore?: () => void;
	/** Called (debounced) with the filename search term for the local library. */
	onLocalSearchChange?: (q: string) => void;
	/** Called with the MIME filter for the local library (undefined = all types). */
	onLocalMimeFilterChange?: (mimeType: string | string[] | undefined) => void;
}

/**
 * Media library component with upload, provider tabs, and grid view
 */
export function MediaLibrary({
	items = [],
	isLoading,
	onUpload,
	onItemUpdated,
	hasMore,
	onLoadMore,
	onLocalSearchChange,
	onLocalMimeFilterChange,
}: MediaLibraryProps) {
	const { t } = useLingui();
	const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
	const [detailItem, setDetailItem] = React.useState<MediaItem | null>(null);
	const [isDetailOpen, setIsDetailOpen] = React.useState(false);
	const [activeProvider, setActiveProvider] = React.useState<string>("local");
	const [searchQuery, setSearchQuery] = React.useState("");
	const [localTypeFilter, setLocalTypeFilter] = React.useState("all");
	const mediaHeadingRef = React.useRef<HTMLHeadingElement>(null);
	const detailOpenFrameRef = React.useRef<number | null>(null);
	// Debounced filename search reported up for the local library's server query.
	const debouncedSearch = useDebouncedValue(searchQuery, 300);
	React.useEffect(() => {
		if (activeProvider === "local" && onLocalSearchChange) {
			onLocalSearchChange(debouncedSearch.trim());
		}
	}, [debouncedSearch, activeProvider, onLocalSearchChange]);
	const [uploadDialogOpen, setUploadDialogOpen] = React.useState(false);
	const [enqueueRequest, setEnqueueRequest] = React.useState<{
		id: number;
		files: readonly File[];
	} | null>(null);
	const [uploadTarget, setUploadTarget] = React.useState<{ id: string; name: string } | null>(null);
	const [isFileDragActive, setIsFileDragActive] = React.useState(false);
	const enqueueIdRef = React.useRef(0);
	const dragDepthRef = React.useRef(0);
	const returnFocusRef = React.useRef<HTMLElement | null>(null);
	// Track loaded image dimensions for providers that don't return them (e.g., CF Images)
	const [loadedDimensions, setLoadedDimensions] = React.useState<
		Record<string, { width: number; height: number }>
	>({});

	// Fetch available providers
	const { data: providers } = useQuery({
		queryKey: ["media-providers"],
		queryFn: fetchMediaProviders,
		placeholderData: [],
	});

	// Fetch provider media when a non-local provider is selected
	const {
		data: providerData,
		isLoading: providerLoading,
		refetch: refetchProviderMedia,
	} = useQuery({
		queryKey: ["provider-media", activeProvider, searchQuery],
		queryFn: () =>
			fetchProviderMedia(activeProvider, {
				limit: 50,
				query: searchQuery || undefined,
			}),
		enabled: activeProvider !== "local",
	});

	// Get active provider info
	const activeProviderInfo = React.useMemo(() => {
		if (activeProvider === "local") {
			return {
				id: "local",
				name: t`Library`,
				capabilities: { browse: true, search: false, upload: true, delete: true },
			};
		}
		return providers?.find((p) => p.id === activeProvider);
	}, [activeProvider, providers, t]);
	const canUpload = activeProviderInfo?.capabilities.upload ?? false;
	const canSearch = activeProviderInfo?.capabilities.search ?? false;

	const cancelPendingDetailOpen = React.useCallback(() => {
		if (detailOpenFrameRef.current === null) return;
		window.cancelAnimationFrame(detailOpenFrameRef.current);
		detailOpenFrameRef.current = null;
	}, []);

	React.useEffect(() => cancelPendingDetailOpen, [cancelPendingDetailOpen]);

	const openDetail = React.useCallback(
		(item: MediaItem) => {
			cancelPendingDetailOpen();
			setIsDetailOpen(false);
			setDetailItem(item);
			detailOpenFrameRef.current = window.requestAnimationFrame(() => {
				detailOpenFrameRef.current = null;
				setIsDetailOpen(true);
			});
		},
		[cancelPendingDetailOpen],
	);

	const closeDetail = React.useCallback(() => {
		cancelPendingDetailOpen();
		setIsDetailOpen(false);
	}, [cancelPendingDetailOpen]);

	const handleDetailClosed = React.useCallback(() => {
		setDetailItem(null);
	}, []);

	const enqueueFiles = React.useCallback(
		(files: readonly File[], returnFocus?: HTMLElement | null) => {
			if (!canUpload || !activeProviderInfo || files.length === 0) return;
			if (returnFocus) returnFocusRef.current = returnFocus;
			setUploadTarget({ id: activeProviderInfo.id, name: activeProviderInfo.name });
			setEnqueueRequest({ id: (enqueueIdRef.current += 1), files });
			setUploadDialogOpen(true);
		},
		[activeProviderInfo, canUpload],
	);

	const openUploadDialog = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (!canUpload || !activeProviderInfo) return;
		returnFocusRef.current = event.currentTarget;
		setUploadTarget({ id: activeProviderInfo.id, name: activeProviderInfo.name });
		setEnqueueRequest(null);
		setUploadDialogOpen(true);
	};

	React.useEffect(() => {
		const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
		const resetDrag = () => {
			dragDepthRef.current = 0;
			setIsFileDragActive(false);
		};
		const handleDragEnter = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			if (uploadDialogOpen || !canUpload) return;
			dragDepthRef.current += 1;
			setIsFileDragActive(true);
		};
		const handleDragOver = (event: DragEvent) => {
			if (hasFiles(event)) event.preventDefault();
		};
		const handleDragLeave = (event: DragEvent) => {
			if (dragDepthRef.current === 0 || uploadDialogOpen || !canUpload) return;
			if (event.relatedTarget === null) {
				resetDrag();
				return;
			}
			dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
			if (dragDepthRef.current === 0) setIsFileDragActive(false);
		};
		const handleDrop = (event: DragEvent) => {
			if (!hasFiles(event)) return;
			event.preventDefault();
			resetDrag();
			if (uploadDialogOpen || !canUpload) return;
			enqueueFiles([...(event.dataTransfer?.files ?? [])], mediaHeadingRef.current);
		};

		window.addEventListener("dragenter", handleDragEnter);
		window.addEventListener("dragover", handleDragOver);
		window.addEventListener("dragleave", handleDragLeave);
		window.addEventListener("drop", handleDrop);
		return () => {
			window.removeEventListener("dragenter", handleDragEnter);
			window.removeEventListener("dragover", handleDragOver);
			window.removeEventListener("dragleave", handleDragLeave);
			window.removeEventListener("drop", handleDrop);
		};
	}, [canUpload, enqueueFiles, uploadDialogOpen]);

	// Build provider tabs
	const providerTabs = React.useMemo(() => {
		const tabs: Array<{ id: string; name: string; icon?: string }> = [
			{ id: "local", name: t`Library`, icon: undefined },
		];
		if (providers) {
			for (const p of providers) {
				if (p.id !== "local") {
					tabs.push({ id: p.id, name: p.name, icon: p.icon });
				}
			}
		}
		return tabs;
	}, [providers, t]);

	// Get current items based on active provider
	const currentItems = activeProvider === "local" ? items : [];
	const currentProviderItems = activeProvider !== "local" ? providerData?.items || [] : [];
	const currentLoading = activeProvider === "local" ? isLoading : providerLoading;

	const resultCount =
		activeProvider === "local" ? currentItems.length : currentProviderItems.length;
	const hasMoreCurrentItems =
		activeProvider === "local" ? Boolean(hasMore) : Boolean(providerData?.nextCursor);
	const resultCountText =
		resultCount > 0 && !hasMoreCurrentItems
			? plural(resultCount, { one: "# item", other: "# items" })
			: "";
	const hasActiveQuery =
		searchQuery.trim() !== "" || (activeProvider === "local" && localTypeFilter !== "all");
	const clearLocalQuery = () => {
		setSearchQuery("");
		onLocalSearchChange?.("");
		setLocalTypeFilter("all");
		onLocalMimeFilterChange?.(mimeForTypeFilter("all"));
	};
	const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const next = e.target.value;
		setSearchQuery(next);
		if (activeProvider === "local" && next.trim() === "") {
			onLocalSearchChange?.("");
		}
	};
	const showToolbar = resultCount > 0 || hasActiveQuery;
	const uploadFile = React.useCallback(
		async (file: File, options: { signal: AbortSignal }) => {
			if (!uploadTarget) throw new Error("Upload target unavailable");
			if (uploadTarget.id === "local") {
				if (!onUpload) throw new Error("Upload callback unavailable");
				await onUpload(file, options);
				return;
			}
			await uploadToProvider(uploadTarget.id, file, undefined, options);
		},
		[onUpload, uploadTarget],
	);
	const handleUploadDialogClosed = React.useCallback(() => {
		setEnqueueRequest(null);
		setUploadTarget(null);
		const returnTarget = returnFocusRef.current;
		returnFocusRef.current = null;
		window.requestAnimationFrame(() => {
			(returnTarget?.isConnected ? returnTarget : mediaHeadingRef.current)?.focus();
		});
	}, []);
	const handleUploadQueueIdle = React.useCallback(() => {
		if (uploadTarget?.id !== "local") void refetchProviderMedia();
	}, [refetchProviderMedia, uploadTarget?.id]);

	return (
		<div className="space-y-4" data-media-library>
			{isFileDragActive && (
				<div
					className="pointer-events-none fixed inset-0 z-50 bg-kumo-base/70 p-4 backdrop-blur-sm sm:p-8"
					aria-hidden="true"
				>
					<div className="flex h-full items-center justify-center rounded-2xl border-[3px] border-dashed border-kumo-brand/80 bg-kumo-tint/70">
						<div className="flex flex-col items-center gap-3 text-center">
							<Upload className="h-10 w-10 text-kumo-subtle" aria-hidden="true" />
							<p className="text-lg font-semibold">{t`Drop files to upload`}</p>
						</div>
					</div>
				</div>
			)}
			{/* Header: page title (start) + primary upload action (end) */}
			<div className="flex flex-wrap items-center justify-between gap-4">
				<h1 ref={mediaHeadingRef} tabIndex={-1} className="text-2xl font-semibold leading-tight">
					{t`Media Library`}
				</h1>
				<div className="flex items-center gap-3">
					{canUpload && (
						<Button onClick={openUploadDialog} icon={<Upload />}>
							{t`Upload to ${activeProviderInfo?.name || t`Library`}`}
						</Button>
					)}
				</div>
			</div>

			{/* Provider tabs (only when an external provider is configured) */}
			{providerTabs.length > 1 && (
				<Tabs
					variant="underline"
					value={activeProvider}
					onValueChange={(v) => {
						if (!v) return;
						cancelPendingDetailOpen();
						setActiveProvider(v);
						setIsDetailOpen(false);
						setDetailItem(null);
						setSearchQuery("");
					}}
					tabs={providerTabs.map((tab) => ({
						value: tab.id,
						label: (
							<span className="flex items-center gap-2">
								{tab.icon &&
									(tab.icon.startsWith("data:") ? (
										<img src={tab.icon} alt="" className="h-4 w-4" aria-hidden="true" />
									) : (
										<span aria-hidden="true">{tab.icon}</span>
									))}
								{tab.name}
							</span>
						),
					}))}
				/>
			)}

			{/* Toolbar: search + type filter (start) · result count + view toggle (end).
			    Local library search/filter is handled server-side. */}
			{showToolbar && (
				<div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						{(canSearch || activeProvider === "local") && (
							<div className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
								<MagnifyingGlass
									className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kumo-subtle"
									aria-hidden="true"
								/>
								<Input
									type="search"
									placeholder={activeProvider === "local" ? t`Search by filename...` : t`Search...`}
									aria-label={t`Search media`}
									value={searchQuery}
									onChange={handleSearchChange}
									maxLength={MEDIA_SEARCH_MAX_LENGTH}
									className="w-full ps-9"
								/>
							</div>
						)}
						{activeProvider === "local" && (
							<Select
								value={localTypeFilter}
								onValueChange={(v) => {
									const next = v ?? "all";
									setLocalTypeFilter(next);
									onLocalMimeFilterChange?.(mimeForTypeFilter(next));
								}}
								items={{
									all: t`All types`,
									image: t`Images`,
									video: t`Video`,
									audio: t`Audio`,
									document: t`Documents`,
								}}
								aria-label={t`Filter by type`}
							/>
						)}
					</div>
					<div className="flex flex-shrink-0 items-center justify-between gap-3 sm:justify-end">
						<span className="text-sm text-kumo-subtle tabular-nums" aria-live="polite">
							{resultCountText}
						</span>
						<div role="group" aria-label={t`View mode`}>
							<Tabs
								variant="segmented"
								value={viewMode}
								onValueChange={(v) => {
									if (v === "grid" || v === "list") setViewMode(v);
								}}
								tabs={[
									{
										value: "grid",
										label: (
											<>
												<SquaresFour className="h-4 w-4" aria-hidden="true" />
												<span className="sr-only">{t`Grid view`}</span>
											</>
										),
									},
									{
										value: "list",
										label: (
											<>
												<List className="h-4 w-4" aria-hidden="true" />
												<span className="sr-only">{t`List view`}</span>
											</>
										),
									},
								]}
							/>
						</div>
					</div>
				</div>
			)}

			{/* Content */}
			{currentLoading && currentItems.length === 0 && currentProviderItems.length === 0 ? (
				<div className="flex items-center justify-center py-12">
					<Loader />
				</div>
			) : activeProvider === "local" && currentItems.length === 0 ? (
				hasActiveQuery ? (
					<MediaEmptyState
						hero={MagnifyingGlass}
						title={t`No matching media`}
						description={
							searchQuery.trim()
								? t`Try another filename, or clear your search and filters.`
								: t`Try a broader media type or clear your filters.`
						}
						action={
							<Button variant="outline" onClick={clearLocalQuery}>
								{searchQuery.trim() ? t`Clear search` : t`Clear filters`}
							</Button>
						}
					/>
				) : (
					<MediaEmptyState
						hero={Images}
						title={t`Your media library is empty`}
						description={t`Upload images, videos, and documents to keep reusable assets in one place.`}
						action={
							<Button onClick={openUploadDialog} icon={<Upload />}>
								{t`Upload Files`}
							</Button>
						}
					/>
				)
			) : activeProvider !== "local" && currentProviderItems.length === 0 ? (
				canSearch && searchQuery.trim() ? (
					<MediaEmptyState
						hero={MagnifyingGlass}
						title={t`No matching media`}
						description={t`Try another filename or clear your search.`}
						action={
							<Button variant="outline" onClick={() => setSearchQuery("")}>
								{t`Clear search`}
							</Button>
						}
					/>
				) : canUpload ? (
					<MediaEmptyState
						hero={Images}
						title={t`Your media library is empty`}
						description={t`Upload media to keep reusable assets in one place.`}
						action={
							<Button onClick={openUploadDialog} icon={<Upload />}>
								{t`Upload Files`}
							</Button>
						}
					/>
				) : (
					<MediaEmptyState
						hero={Images}
						title={t`No media found`}
						description={t`No media available from this provider.`}
					/>
				)
			) : viewMode === "grid" ? (
				<div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
					{activeProvider === "local"
						? currentItems.map((item) => (
								<MediaGridItem
									key={item.id}
									item={item}
									selected={detailItem?.id === item.id}
									onClick={() => openDetail(item)}
								/>
							))
						: currentProviderItems.map((item) => (
								<ProviderGridItem
									key={item.id}
									item={item}
									selected={detailItem?.id === item.id}
									onClick={() => {
										// Merge loaded dimensions if provider didn't return them
										const dims = loadedDimensions[item.id];
										const itemWithDims = dims
											? {
													...item,
													width: item.width ?? dims.width,
													height: item.height ?? dims.height,
												}
											: item;
										openDetail(providerItemToMediaItem(activeProvider, itemWithDims));
									}}
									onDimensionsLoaded={(width, height) => {
										setLoadedDimensions((prev) => ({
											...prev,
											[item.id]: { width, height },
										}));
									}}
								/>
							))}
				</div>
			) : (
				<div className="rounded-md border bg-kumo-base overflow-x-auto">
					<table className="w-full">
						<thead>
							<tr className="border-b bg-kumo-tint/50">
								<th className="px-4 py-3 text-start text-sm font-medium">{t`Preview`}</th>
								<th className="px-4 py-3 text-start text-sm font-medium">{t`Filename`}</th>
								<th className="px-4 py-3 text-start text-sm font-medium">{t`Type`}</th>
								<th className="px-4 py-3 text-start text-sm font-medium">{t`Size`}</th>
								<th className="px-4 py-3 text-end text-sm font-medium">{t`Alt text`}</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-kumo-line">
							{activeProvider === "local"
								? currentItems.map((item) => (
										<MediaListItem
											key={item.id}
											item={item}
											selected={detailItem?.id === item.id}
											onClick={() => openDetail(item)}
										/>
									))
								: currentProviderItems.map((item) => (
										<ProviderListItem
											key={item.id}
											item={item}
											selected={detailItem?.id === item.id}
											onClick={() => {
												const dims = loadedDimensions[item.id];
												const itemWithDims = dims
													? {
															...item,
															width: item.width ?? dims.width,
															height: item.height ?? dims.height,
														}
													: item;
												openDetail(providerItemToMediaItem(activeProvider, itemWithDims));
											}}
											onDimensionsLoaded={(width, height) => {
												setLoadedDimensions((prev) => ({
													...prev,
													[item.id]: { width, height },
												}));
											}}
										/>
									))}
						</tbody>
					</table>
				</div>
			)}

			{/* Load more (local library only — providers handle pagination internally) */}
			{activeProvider === "local" && hasMore && onLoadMore && (
				<div className="flex justify-center">
					<Button variant="outline" onClick={onLoadMore} disabled={isLoading}>
						{isLoading ? t`Loading...` : t`Load More`}
					</Button>
				</div>
			)}

			<MediaUploadDialog
				open={uploadDialogOpen}
				providerName={uploadTarget?.name ?? activeProviderInfo?.name ?? t`Library`}
				accept={uploadTarget?.id === "local" ? LOCAL_MEDIA_UPLOAD_ACCEPT : undefined}
				enqueueRequest={enqueueRequest}
				onEnqueueRequestConsumed={(id) =>
					setEnqueueRequest((current) => (current?.id === id ? null : current))
				}
				onOpenChange={setUploadDialogOpen}
				onCloseComplete={handleUploadDialogClosed}
				onQueueIdle={handleUploadQueueIdle}
				upload={uploadFile}
			/>

			{/* Detail Dialog */}
			{detailItem && (
				<MediaDetailPanel
					open={isDetailOpen}
					item={detailItem}
					providerName={detailItem.provider ? activeProviderInfo?.name : undefined}
					canDelete={detailItem.provider ? activeProviderInfo?.capabilities.delete : undefined}
					restoreFocusTargetRef={mediaHeadingRef}
					onClose={closeDetail}
					onClosed={handleDetailClosed}
					onUpdated={onItemUpdated}
					onDeleted={detailItem.provider ? undefined : onItemUpdated}
				/>
			)}
		</div>
	);
}

/** Single-chip illustration: solid tinted circle + darker icon, decorative. */
function MediaEmptyIllustration({ hero: Hero }: { hero: Icon }) {
	return (
		<div
			className="flex items-center justify-center"
			style={{
				width: "5rem",
				height: "5rem",
				minWidth: "5rem",
				minHeight: "5rem",
				borderRadius: "9999px",
				backgroundColor: "var(--color-kumo-info-tint)",
			}}
			aria-hidden="true"
		>
			<Hero size={36} className="text-kumo-link" aria-hidden="true" />
		</div>
	);
}

interface MediaEmptyStateProps {
	hero: Icon;
	title: string;
	description: string;
	action?: React.ReactNode;
}

/** Centered empty / no-results panel with the media illustration. */
function MediaEmptyState({ hero, title, description, action }: MediaEmptyStateProps) {
	return (
		<div
			className="flex flex-col items-center rounded-lg border bg-kumo-base px-6 py-20 text-center"
			style={{ gap: "1.5rem" }}
		>
			<MediaEmptyIllustration hero={hero} />
			<div className="flex flex-col items-center" style={{ gap: "0.75rem" }}>
				<h2 className="text-xl font-semibold leading-tight text-balance">{title}</h2>
				<p className="max-w-md text-base leading-6 text-pretty text-kumo-subtle">{description}</p>
			</div>
			{action && <div style={{ marginTop: "0.25rem" }}>{action}</div>}
		</div>
	);
}

interface MediaGridItemProps {
	item: MediaItem;
	selected?: boolean;
	onClick?: () => void;
}

function MediaGridItem({ item, selected, onClick }: MediaGridItemProps) {
	const isImage = item.mimeType.startsWith("image/");

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"group relative overflow-hidden rounded-lg border bg-kumo-base text-start transition-all max-w-[200px]",
				selected ? "ring-2 ring-kumo-brand border-kumo-brand" : "hover:border-kumo-brand/50",
			)}
		>
			<div className="aspect-square">
				{isImage ? (
					<img
						src={getMediaThumbnailUrl(item.url, item.mimeType, MEDIA_THUMBNAIL_WIDTH)}
						alt={item.alt || item.filename}
						className="h-full w-full object-cover"
						onError={(e) => fallbackToOriginalThumbnail(e.currentTarget, item.url)}
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
						<span className="text-4xl">{getFileIcon(item.mimeType)}</span>
					</div>
				)}
			</div>
			<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
				<div className="w-full p-3">
					<p className="truncate text-sm font-medium text-white">{item.filename}</p>
				</div>
			</div>
		</button>
	);
}

interface ProviderGridItemProps {
	item: MediaProviderItem;
	selected?: boolean;
	onClick?: () => void;
	/** Callback when image dimensions are loaded (for providers that don't return dimensions) */
	onDimensionsLoaded?: (width: number, height: number) => void;
}

function ProviderGridItem({ item, selected, onClick, onDimensionsLoaded }: ProviderGridItemProps) {
	const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
		const img = e.currentTarget;
		// Only report if we don't already have dimensions
		if (onDimensionsLoaded && (!item.width || !item.height)) {
			onDimensionsLoaded(img.naturalWidth, img.naturalHeight);
		}
	};

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"group relative overflow-hidden rounded-lg border bg-kumo-base text-start transition-all max-w-[200px]",
				selected ? "ring-2 ring-kumo-brand border-kumo-brand" : "hover:border-kumo-brand/50",
			)}
		>
			<div className="aspect-square">
				{item.previewUrl ? (
					<img
						src={item.previewUrl}
						alt={item.alt || item.filename}
						className="h-full w-full object-cover"
						onLoad={handleImageLoad}
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
						<span className="text-4xl">{getFileIcon(item.mimeType)}</span>
					</div>
				)}
			</div>
			<div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
				<div className="w-full p-3">
					<p className="truncate text-sm font-medium text-white">{item.filename}</p>
				</div>
			</div>
		</button>
	);
}

interface MediaListItemProps {
	item: MediaItem;
	selected?: boolean;
	onClick?: () => void;
}

function MediaListItem({ item, selected, onClick }: MediaListItemProps) {
	const { t } = useLingui();
	const isImage = item.mimeType.startsWith("image/");

	return (
		<tr
			className={cn(
				"cursor-pointer transition-colors",
				selected ? "bg-kumo-brand/10" : "hover:bg-kumo-tint/25",
			)}
			onClick={onClick}
		>
			<td className="px-4 py-3">
				<div className="h-10 w-10 overflow-hidden rounded">
					{isImage ? (
						<img
							src={getMediaThumbnailUrl(item.url, item.mimeType, 80)}
							alt={item.alt || item.filename}
							className="h-full w-full object-cover"
							onError={(e) => fallbackToOriginalThumbnail(e.currentTarget, item.url)}
						/>
					) : (
						<div className="flex h-full w-full items-center justify-center bg-kumo-tint text-xl">
							{getFileIcon(item.mimeType)}
						</div>
					)}
				</div>
			</td>
			<td className="px-4 py-3 text-base font-medium leading-5">{item.filename}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{item.mimeType}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle tabular-nums">
				{formatFileSize(item.size)}
			</td>
			<td className="px-4 py-3 text-end">
				<span className="text-sm text-kumo-subtle">
					{item.alt ? t`Alt text set` : t`No alt text`}
				</span>
			</td>
		</tr>
	);
}

interface ProviderListItemProps {
	item: MediaProviderItem;
	selected?: boolean;
	onClick?: () => void;
	/** Callback when image dimensions are loaded (for providers that don't return dimensions) */
	onDimensionsLoaded?: (width: number, height: number) => void;
}

function ProviderListItem({ item, selected, onClick, onDimensionsLoaded }: ProviderListItemProps) {
	const { t } = useLingui();
	const size = item.size ?? metaNumber(item.meta, "size");

	const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
		const img = e.currentTarget;
		if (onDimensionsLoaded && (!item.width || !item.height)) {
			onDimensionsLoaded(img.naturalWidth, img.naturalHeight);
		}
	};

	return (
		<tr
			className={cn(
				"cursor-pointer transition-colors",
				selected ? "bg-kumo-brand/10" : "hover:bg-kumo-tint/25",
			)}
			onClick={onClick}
		>
			<td className="px-4 py-3">
				<div className="h-10 w-10 overflow-hidden rounded">
					{item.previewUrl ? (
						<img
							src={item.previewUrl}
							alt={item.alt || item.filename}
							className="h-full w-full object-cover"
							onLoad={handleImageLoad}
						/>
					) : (
						<div className="flex h-full w-full items-center justify-center bg-kumo-tint text-xl">
							{getFileIcon(item.mimeType)}
						</div>
					)}
				</div>
			</td>
			<td className="px-4 py-3 text-base font-medium leading-5">{item.filename}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{item.mimeType}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle tabular-nums">
				{size ? formatFileSize(size) : "—"}
			</td>
			<td className="px-4 py-3 text-end">
				<span className="text-sm text-kumo-subtle">
					{item.alt ? t`Alt text set` : t`No alt text`}
				</span>
			</td>
		</tr>
	);
}

export default MediaLibrary;
