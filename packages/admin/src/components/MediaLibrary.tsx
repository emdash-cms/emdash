import { Button, Input, Loader } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Upload, Image, SquaresFour, List, MagnifyingGlass, Check, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	type MediaItem,
	type MediaProviderInfo,
	type MediaProviderItem,
	fetchMediaProviders,
	fetchProviderMedia,
	uploadToProvider,
} from "../lib/api";
import { providerItemToMediaItem, getFileIcon, formatFileSize } from "../lib/media-utils";
import { cn } from "../lib/utils";
import { MediaDetailPanel } from "./MediaDetailPanel";

export interface MediaLibraryProps {
	items?: MediaItem[];
	isLoading?: boolean;
	onUpload?: (file: File) => Promise<void> | void;
	onSelect?: (item: MediaItem) => void;
	onDelete?: (id: string) => void;
	onItemUpdated?: () => void;
}

/**
 * Media library component with upload, provider tabs, and grid view
 */
export function MediaLibrary({
	items = [],
	isLoading,
	onUpload,
	onDelete,
	onItemUpdated,
}: MediaLibraryProps) {
	const { t } = useLingui();
	const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
	const [selectedItem, setSelectedItem] = React.useState<MediaItem | null>(null);
	const [activeProvider, setActiveProvider] = React.useState<string>("local");
	const [searchQuery, setSearchQuery] = React.useState("");
	const [uploadState, setUploadState] = React.useState<{
		status: "idle" | "uploading" | "success" | "error";
		message?: string;
		progress?: { current: number; total: number };
	}>({ status: "idle" });
	const fileInputRef = React.useRef<HTMLInputElement>(null);
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
				name: "Library",
				capabilities: { browse: true, search: false, upload: true, delete: true },
			} as MediaProviderInfo;
		}
		return providers?.find((p) => p.id === activeProvider);
	}, [activeProvider, providers]);

	// Update selected item when items change (e.g., after metadata update)
	React.useEffect(() => {
		if (selectedItem && activeProvider === "local") {
			const updated = items.find((i) => i.id === selectedItem.id);
			if (updated) {
				setSelectedItem(updated);
			} else {
				// Item was deleted
				setSelectedItem(null);
			}
		}
	}, [items, selectedItem?.id, activeProvider]);

	// Clear success/error message after a delay
	React.useEffect(() => {
		if (uploadState.status === "success" || uploadState.status === "error") {
			const timer = setTimeout(() => {
				setUploadState({ status: "idle" });
			}, 3000);
			return () => clearTimeout(timer);
		}
	}, [uploadState.status]);

	const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		if (files && files.length > 0) {
			const fileArray = [...files];
			const total = fileArray.length;

			if (activeProvider === "local") {
				setUploadState({ status: "uploading", progress: { current: 0, total } });
				let uploaded = 0;
				let failed = 0;

				for (const file of fileArray) {
					try {
						await onUpload?.(file);
						uploaded++;
					} catch (error) {
						console.error("Upload failed:", error);
						failed++;
					}
					setUploadState({
						status: "uploading",
						progress: { current: uploaded + failed, total },
					});
				}

				if (failed === 0) {
					setUploadState({
						status: "success",
						message: plural(total, { one: "# file uploaded", other: "# files uploaded" }),
					});
				} else if (uploaded === 0) {
					setUploadState({
						status: "error",
						message: plural(total, { one: "Upload failed", other: "All # uploads failed" }),
					});
				} else {
					setUploadState({
						status: "error",
						message: t`${uploaded} uploaded, ${failed} failed`,
					});
				}
			} else if (activeProviderInfo?.capabilities.upload) {
				// Upload to external provider
				setUploadState({ status: "uploading", progress: { current: 0, total } });
				let uploaded = 0;
				let failed = 0;

				for (const file of fileArray) {
					try {
						await uploadToProvider(activeProvider, file);
						uploaded++;
					} catch (error) {
						console.error("Upload failed:", error);
						failed++;
					}
					setUploadState({
						status: "uploading",
						progress: { current: uploaded + failed, total },
					});
				}

				if (failed === 0) {
					setUploadState({
						status: "success",
						message: plural(total, { one: "# file uploaded", other: "# files uploaded" }),
					});
				} else if (uploaded === 0) {
					setUploadState({
						status: "error",
						message: plural(total, { one: "Upload failed", other: "All # uploads failed" }),
					});
				} else {
					setUploadState({
						status: "error",
						message: t`${uploaded} uploaded, ${failed} failed`,
					});
				}

				void refetchProviderMedia();
			}
		}
		// Reset input
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	// Build provider tabs
	const providerTabs = React.useMemo(() => {
		const tabs: Array<{ id: string; name: string; icon?: string }> = [
			{ id: "local", name: "Library", icon: undefined },
		];
		if (providers) {
			for (const p of providers) {
				if (p.id !== "local") {
					tabs.push({ id: p.id, name: p.name, icon: p.icon });
				}
			}
		}
		return tabs;
	}, [providers]);

	// Get current items based on active provider
	const currentItems = activeProvider === "local" ? items : [];
	const currentProviderItems = activeProvider !== "local" ? providerData?.items || [] : [];
	const currentLoading = activeProvider === "local" ? isLoading : providerLoading;

	const canUpload = activeProviderInfo?.capabilities.upload ?? false;
	const canSearch = activeProviderInfo?.capabilities.search ?? false;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold">{t`Media Library`}</h1>
				<div className="flex rounded-md border" role="group" aria-label={t`View mode`}>
					<Button
						variant={viewMode === "grid" ? "secondary" : "ghost"}
						shape="square"
						onClick={() => setViewMode("grid")}
						aria-label={t`Grid view`}
						aria-pressed={viewMode === "grid"}
					>
						<SquaresFour className="h-4 w-4" aria-hidden="true" />
					</Button>
					<Button
						variant={viewMode === "list" ? "secondary" : "ghost"}
						shape="square"
						onClick={() => setViewMode("list")}
						aria-label={t`List view`}
						aria-pressed={viewMode === "list"}
					>
						<List className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			</div>

			{/* Provider Tabs + Upload */}
			<div className="flex items-center justify-between gap-4 border-b pb-3">
				{providerTabs.length > 1 && (
					<div className="flex gap-2 overflow-x-auto">
						{providerTabs.map((tab) => (
							<button
								key={tab.id}
								type="button"
								onClick={() => {
									setActiveProvider(tab.id);
									setSelectedItem(null);
									setSearchQuery("");
								}}
								className={cn(
									"flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
									activeProvider === tab.id
										? "bg-kumo-brand text-white"
										: "bg-kumo-tint hover:bg-kumo-tint/80 text-kumo-subtle",
								)}
							>
								{tab.icon &&
									(tab.icon.startsWith("data:") ? (
										<img src={tab.icon} alt="" className="h-4 w-4" aria-hidden="true" />
									) : (
										<span aria-hidden="true">{tab.icon}</span>
									))}
								{tab.name}
							</button>
						))}
					</div>
				)}

				{/* Upload button + status */}
				<div className="flex items-center gap-3 flex-shrink-0">
					{/* Upload status feedback */}
					{uploadState.status === "uploading" && (
						<div className="flex items-center gap-2 text-sm text-kumo-subtle">
							<Loader size="sm" />
							<span>
								{uploadState.progress && uploadState.progress.total > 1
									? t`Uploading ${uploadState.progress.current}/${uploadState.progress.total}...`
									: t`Uploading...`}
							</span>
						</div>
					)}
					{uploadState.status === "success" && (
						<div className="flex items-center gap-2 text-sm text-green-600">
							<Check className="h-4 w-4" />
							<span>{uploadState.message}</span>
						</div>
					)}
					{uploadState.status === "error" && (
						<div className="flex items-center gap-2 text-sm text-kumo-danger">
							<X className="h-4 w-4" />
							<span>{uploadState.message}</span>
						</div>
					)}

					{canUpload && (
						<>
							<Button
								onClick={() => fileInputRef.current?.click()}
								disabled={uploadState.status === "uploading"}
								icon={uploadState.status === "uploading" ? <Loader size="sm" /> : <Upload />}
							>
								{t`Upload to ${activeProviderInfo?.name || "Library"}`}
							</Button>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx"
								className="sr-only"
								onChange={handleFileSelect}
								aria-label={t`Upload files`}
							/>
						</>
					)}
				</div>
			</div>

			{/* Search (for providers that support it) */}
			{canSearch && (
				<div className="relative max-w-sm">
					<MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
					<Input
						type="search"
						placeholder={t`Search...`}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>
			)}

			{/* Content */}
			{currentLoading ? (
				<div className="flex items-center justify-center py-12">
					<Loader />
				</div>
			) : activeProvider === "local" && currentItems.length === 0 ? (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Image className="mx-auto h-12 w-12 text-kumo-subtle" aria-hidden="true" />
					<h2 className="mt-4 text-lg font-medium">{t`No media yet`}</h2>
					<p className="mt-2 text-sm text-kumo-subtle">
						{t`Upload images, videos, and documents to get started.`}
					</p>
					<Button className="mt-4" onClick={() => fileInputRef.current?.click()} icon={<Upload />}>
						{t`Upload Files`}
					</Button>
				</div>
			) : activeProvider !== "local" && currentProviderItems.length === 0 ? (
				<div className="rounded-lg border bg-kumo-base p-12 text-center">
					<Image className="mx-auto h-12 w-12 text-kumo-subtle" aria-hidden="true" />
					<h2 className="mt-4 text-lg font-medium">{t`No media found`}</h2>
					<p className="mt-2 text-sm text-kumo-subtle">
						{canSearch && searchQuery
							? t`Try a different search term`
							: canUpload
								? t`Upload media to get started`
								: t`No media available from this provider`}
					</p>
				</div>
			) : viewMode === "grid" ? (
				<div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(160px,1fr))]">
					{activeProvider === "local"
						? currentItems.map((item) => (
								<MediaGridItem
									key={item.id}
									item={item}
									selected={selectedItem?.id === item.id}
									onClick={() => setSelectedItem(item)}
									onDelete={() => onDelete?.(item.id)}
								/>
							))
						: currentProviderItems.map((item) => (
								<ProviderGridItem
									key={item.id}
									item={item}
									selected={selectedItem?.id === item.id}
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
										setSelectedItem(providerItemToMediaItem(activeProvider, itemWithDims));
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
				<div className="rounded-md border overflow-x-auto">
					<table className="w-full">
						<thead>
							<tr className="border-b bg-kumo-tint/50">
								<th className="px-4 py-3 text-left text-sm font-medium">{t`Preview`}</th>
								<th className="px-4 py-3 text-left text-sm font-medium">{t`Filename`}</th>
								<th className="px-4 py-3 text-left text-sm font-medium">{t`Type`}</th>
								<th className="px-4 py-3 text-left text-sm font-medium">{t`Size`}</th>
								<th className="px-4 py-3 text-right text-sm font-medium">{t`Actions`}</th>
							</tr>
						</thead>
						<tbody>
							{activeProvider === "local"
								? currentItems.map((item) => (
										<MediaListItem
											key={item.id}
											item={item}
											selected={selectedItem?.id === item.id}
											onClick={() => setSelectedItem(item)}
											onDelete={() => onDelete?.(item.id)}
										/>
									))
								: currentProviderItems.map((item) => (
										<ProviderListItem
											key={item.id}
											item={item}
											selected={selectedItem?.id === item.id}
											onClick={() => {
												const dims = loadedDimensions[item.id];
												const itemWithDims = dims
													? {
															...item,
															width: item.width ?? dims.width,
															height: item.height ?? dims.height,
														}
													: item;
												setSelectedItem(providerItemToMediaItem(activeProvider, itemWithDims));
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

			{/* Detail Panel */}
			{selectedItem && (
				<MediaDetailPanel
					item={selectedItem}
					onClose={() => setSelectedItem(null)}
					onDeleted={() => {
						if (activeProvider === "local") {
							onDelete?.(selectedItem.id);
							onItemUpdated?.();
						} else {
							void refetchProviderMedia();
						}
					}}
				/>
			)}
		</div>
	);
}

interface MediaGridItemProps {
	item: MediaItem;
	selected?: boolean;
	onClick?: () => void;
	onDelete: () => void;
}

function MediaGridItem({ item, selected, onClick }: MediaGridItemProps) {
	const isImage = item.mimeType.startsWith("image/");

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"group relative overflow-hidden rounded-lg border bg-kumo-base text-left transition-all max-w-[200px]",
				selected ? "ring-2 ring-kumo-brand border-kumo-brand" : "hover:border-kumo-brand/50",
			)}
		>
			<div className="aspect-square">
				{isImage ? (
					<img
						src={item.url}
						alt={item.alt || item.filename}
						className="h-full w-full object-cover"
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
	const isImage = item.mimeType.startsWith("image/");

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
				"group relative overflow-hidden rounded-lg border bg-kumo-base text-left transition-all max-w-[200px]",
				selected ? "ring-2 ring-kumo-brand border-kumo-brand" : "hover:border-kumo-brand/50",
			)}
		>
			<div className="aspect-square">
				{isImage && item.previewUrl ? (
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
	onDelete: () => void;
}

function MediaListItem({ item, selected, onClick }: MediaListItemProps) {
	const { t } = useLingui();
	const isImage = item.mimeType.startsWith("image/");

	return (
		<tr
			className={cn(
				"border-b cursor-pointer transition-colors",
				selected ? "bg-kumo-brand/10" : "hover:bg-kumo-tint/25",
			)}
			onClick={onClick}
		>
			<td className="px-4 py-3">
				<div className="h-10 w-10 overflow-hidden rounded">
					{isImage ? (
						<img
							src={item.url}
							alt={item.alt || item.filename}
							className="h-full w-full object-cover"
						/>
					) : (
						<div className="flex h-full w-full items-center justify-center bg-kumo-tint text-xl">
							{getFileIcon(item.mimeType)}
						</div>
					)}
				</div>
			</td>
			<td className="px-4 py-3 font-medium">{item.filename}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{item.mimeType}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{formatFileSize(item.size)}</td>
			<td className="px-4 py-3 text-right">
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
	const isImage = item.mimeType.startsWith("image/");

	const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
		const img = e.currentTarget;
		if (onDimensionsLoaded && (!item.width || !item.height)) {
			onDimensionsLoaded(img.naturalWidth, img.naturalHeight);
		}
	};

	return (
		<tr
			className={cn(
				"border-b cursor-pointer transition-colors",
				selected ? "bg-kumo-brand/10" : "hover:bg-kumo-tint/25",
			)}
			onClick={onClick}
		>
			<td className="px-4 py-3">
				<div className="h-10 w-10 overflow-hidden rounded">
					{isImage && item.previewUrl ? (
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
			<td className="px-4 py-3 font-medium">{item.filename}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">{item.mimeType}</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">
				{item.size ? formatFileSize(item.size) : "—"}
			</td>
			<td className="px-4 py-3 text-right">
				<span className="text-sm text-kumo-subtle">
					{item.alt ? t`Alt text set` : t`No alt text`}
				</span>
			</td>
		</tr>
	);
}

export default MediaLibrary;
