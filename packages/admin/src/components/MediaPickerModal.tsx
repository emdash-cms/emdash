/**
 * Media Picker Modal
 *
 * A modal dialog for selecting media from the library or uploading new files.
 * Supports multiple media providers with tabbed navigation.
 * Used by the rich text editor and image field components.
 */

import { Button, Dialog, Input, Label, Loader } from "@cloudflare/kumo";
import { Plural, useLingui } from "@lingui/react/macro";
import { Upload, Image, Check, Globe, MagnifyingGlass } from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchMediaList,
	fetchMediaProviders,
	fetchProviderMedia,
	uploadMedia,
	uploadToProvider,
	updateMedia,
	type MediaItem,
	type MediaProviderInfo,
	type MediaProviderItem,
} from "../lib/api";
import { providerItemToMediaItem, getFileIcon } from "../lib/media-utils";
import { cn } from "../lib/utils";
import { DialogError } from "./DialogError.js";

/** Selected item can be either a local MediaItem or a provider item with provider context */
interface SelectedMedia {
	providerId: string;
	item: MediaItem | MediaProviderItem;
}

export interface MediaPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (item: MediaItem) => void;
	/** Filter by mime type prefix, e.g. "image/" */
	mimeTypeFilter?: string;
	title?: string;
}

/**
 * Probe image URL to get dimensions
 */
function probeImageDimensions(url: string): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const img = new window.Image();
		img.onload = () => {
			resolve({ width: img.naturalWidth, height: img.naturalHeight });
		};
		img.onerror = () => {
			reject(new Error("Failed to load image"));
		};
		img.src = url;
	});
}

export function MediaPickerModal({
	open,
	onOpenChange,
	onSelect,
	mimeTypeFilter = "image/",
	title,
}: MediaPickerModalProps) {
	const { t } = useLingui();
	const resolvedTitle = title ?? t`Select Image`;
	const queryClient = useQueryClient();
	const [selectedItem, setSelectedItem] = React.useState<SelectedMedia | null>(null);
	const [activeProvider, setActiveProvider] = React.useState<string>("local");
	const [searchQuery, setSearchQuery] = React.useState("");
	const fileInputRef = React.useRef<HTMLInputElement>(null);

	// URL input state
	const [imageUrl, setImageUrl] = React.useState("");
	const [isProbing, setIsProbing] = React.useState(false);
	const [urlError, setUrlError] = React.useState<string | null>(null);

	// Track loaded image dimensions for providers that don't return them (e.g., CF Images)
	const [providerDimensions, setProviderDimensions] = React.useState<
		Record<string, { width: number; height: number }>
	>({});

	// Reset state when modal opens
	React.useEffect(() => {
		if (open) {
			setSelectedItem(null);
			setActiveProvider("local");
			setSearchQuery("");
			setImageUrl("");
			setUrlError(null);
			setUploadError(null);
			setProviderDimensions({});
		}
	}, [open]);

	// Fetch available providers
	const { data: providers } = useQuery({
		queryKey: ["media-providers"],
		queryFn: fetchMediaProviders,
		enabled: open,
		// Default to just local if fetch fails
		placeholderData: [],
	});

	// Get active provider info
	const activeProviderInfo = React.useMemo(() => {
		if (activeProvider === "local") {
			return {
				id: "local",
				name: "Library",
				icon: undefined,
				capabilities: { browse: true, search: false, upload: true, delete: true },
			} as MediaProviderInfo;
		}
		return providers?.find((p) => p.id === activeProvider);
	}, [activeProvider, providers]);

	// Fetch local media list
	const { data: localData, isLoading: localLoading } = useQuery({
		queryKey: ["media", mimeTypeFilter],
		queryFn: () =>
			fetchMediaList({
				mimeType: mimeTypeFilter,
				limit: 50,
			}),
		enabled: open && activeProvider === "local",
	});

	// Fetch provider media list
	const { data: providerData, isLoading: providerLoading } = useQuery({
		queryKey: ["provider-media", activeProvider, mimeTypeFilter, searchQuery],
		queryFn: () =>
			fetchProviderMedia(activeProvider, {
				mimeType: mimeTypeFilter,
				limit: 50,
				query: searchQuery || undefined,
			}),
		enabled: open && activeProvider !== "local",
	});

	const isLoading = activeProvider === "local" ? localLoading : providerLoading;

	const [uploadError, setUploadError] = React.useState<string | null>(null);

	// Upload mutation for local provider
	const uploadLocalMutation = useMutation({
		mutationFn: (file: File) => uploadMedia(file),
		onSuccess: (item) => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			setSelectedItem({ providerId: "local", item });
			setUploadError(null);
		},
		onError: (err: Error) => {
			setUploadError(err.message);
		},
	});

	// Upload mutation for external providers
	const uploadProviderMutation = useMutation({
		mutationFn: ({ providerId, file }: { providerId: string; file: File }) =>
			uploadToProvider(providerId, file),
		onSuccess: (item, { providerId }) => {
			void queryClient.invalidateQueries({ queryKey: ["provider-media", providerId] });
			setSelectedItem({ providerId, item });
			setUploadError(null);
		},
		onError: (err: Error) => {
			setUploadError(err.message);
		},
	});

	const isUploading = uploadLocalMutation.isPending || uploadProviderMutation.isPending;

	// Track which items we've already updated dimensions for
	const updatedDimensionsRef = React.useRef<Set<string>>(new Set());

	// Mutation for updating media dimensions
	const dimensionsMutation = useMutation({
		mutationFn: ({ id, width, height }: { id: string; width: number; height: number }) =>
			updateMedia(id, { width, height }),
		onSuccess: (_updated, { id, width, height }) => {
			queryClient.setQueryData(
				["media", mimeTypeFilter],
				(old: { items: MediaItem[]; nextCursor?: string } | undefined) => {
					if (!old) return old;
					return {
						...old,
						items: old.items.map((item) => (item.id === id ? { ...item, width, height } : item)),
					};
				},
			);

			if (selectedItem?.providerId === "local" && selectedItem.item.id === id) {
				setSelectedItem({
					providerId: "local",
					item: { ...selectedItem.item, width, height },
				});
			}
		},
		onError: (error) => {
			console.warn("Failed to update media dimensions:", error);
		},
	});

	// Handle dimensions detected for local images missing them
	const handleDimensionsDetected = React.useCallback(
		(id: string, width: number, height: number) => {
			if (updatedDimensionsRef.current.has(id)) return;
			updatedDimensionsRef.current.add(id);
			dimensionsMutation.mutate({ id, width, height });
		},
		[dimensionsMutation],
	);

	// Get items for current view
	const items = React.useMemo(() => {
		if (activeProvider === "local") {
			const localItems = localData?.items || [];
			if (!mimeTypeFilter) return localItems;
			return localItems.filter((item) => item.mimeType.startsWith(mimeTypeFilter));
		}
		return providerData?.items || [];
	}, [activeProvider, localData?.items, providerData?.items, mimeTypeFilter]);

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const files = e.target.files;
		const file = files?.[0];
		if (file) {
			if (activeProvider === "local") {
				uploadLocalMutation.mutate(file);
			} else if (activeProviderInfo?.capabilities.upload) {
				uploadProviderMutation.mutate({ providerId: activeProvider, file });
			}
		}
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const handleConfirm = () => {
		if (selectedItem) {
			if (selectedItem.providerId === "local") {
				// When providerId is "local", item is always MediaItem
				onSelect(selectedItem.item as MediaItem);
			} else {
				// When providerId is not "local", item is always MediaProviderItem
				const providerItem = selectedItem.item as MediaProviderItem;
				const dims = providerDimensions[providerItem.id];
				const itemWithDims = dims
					? {
							...providerItem,
							width: providerItem.width ?? dims.width,
							height: providerItem.height ?? dims.height,
						}
					: providerItem;
				const mediaItem = providerItemToMediaItem(selectedItem.providerId, itemWithDims);
				onSelect(mediaItem);
			}
			onOpenChange(false);
			setSelectedItem(null);
			setImageUrl("");
		}
	};

	const handleClose = () => {
		onOpenChange(false);
		setSelectedItem(null);
		setImageUrl("");
		setUrlError(null);
	};

	const handleUrlSubmit = async () => {
		if (!imageUrl.trim()) return;

		let url: URL;
		try {
			url = new URL(imageUrl.trim());
		} catch {
			setUrlError(t`Please enter a valid URL`);
			return;
		}

		setIsProbing(true);
		setUrlError(null);

		try {
			const dimensions = await probeImageDimensions(url.href);
			const externalItem: MediaItem = {
				id: "",
				filename: url.pathname.split("/").pop() || "external-image",
				mimeType: "image/unknown",
				url: url.href,
				size: 0,
				width: dimensions.width,
				height: dimensions.height,
				createdAt: new Date().toISOString(),
			};

			onSelect(externalItem);
			onOpenChange(false);
			setImageUrl("");
		} catch {
			setUrlError(t`Could not load image from URL`);
		} finally {
			setIsProbing(false);
		}
	};

	const handleUrlKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			void handleUrlSubmit();
		}
	};

	const canUpload =
		activeProvider === "local" || (activeProviderInfo?.capabilities.upload ?? false);
	const canSearch = activeProviderInfo?.capabilities.search ?? false;

	// Build provider tabs - always show local first, then add external providers
	// Filter out "local" from API response since we add it manually
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

	return (
		<Dialog.Root open={open} onOpenChange={handleClose}>
			<Dialog className="p-6 max-w-4xl max-h-[80vh] flex flex-col" size="xl">
				<div className="flex items-start justify-between gap-4 mb-4">
					<Dialog.Title className="text-lg font-semibold leading-none tracking-tight">
						{resolvedTitle}
					</Dialog.Title>
					<Dialog.Close
						aria-label="Close"
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								aria-label="Close"
								className="absolute right-4 top-4"
							>
								<X className="h-4 w-4" />
								<span className="sr-only">Close</span>
							</Button>
						)}
					/>
				</div>

				{/* URL Input */}
				<div className="border-b pb-4">
					<Label>{t`Insert from URL`}</Label>
					<div className="flex gap-2 mt-1.5">
						<div className="flex-1 relative">
							<Globe className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
							<Input
								type="url"
								placeholder="https://example.com/image.jpg"
								aria-label={t`Image URL`}
								value={imageUrl}
								onChange={(e) => {
									setImageUrl(e.target.value);
									setUrlError(null);
								}}
								onKeyDown={handleUrlKeyDown}
								className="pl-9"
							/>
						</div>
						<Button onClick={handleUrlSubmit} disabled={!imageUrl.trim() || isProbing}>
							{isProbing ? <Loader size="sm" /> : t`Insert`}
						</Button>
					</div>
					{urlError && <p className="text-sm text-kumo-danger mt-1">{urlError}</p>}
				</div>

				{/* Divider with "or" */}
				<div className="relative py-2">
					<div className="absolute inset-0 flex items-center">
						<span className="w-full border-t" />
					</div>
					<div className="relative flex justify-center text-xs uppercase">
						<span className="bg-kumo-base px-2 text-kumo-subtle">{t`or choose from library`}</span>
					</div>
				</div>

				{/* Provider Tabs */}
				{providerTabs.length > 1 && (
					<div className="flex gap-2 border-b pb-3 flex-wrap">
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
									"flex items-center gap-2 px-4 h-9 text-sm font-medium rounded-md transition-colors whitespace-nowrap",
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

				{/* Toolbar */}
				<div className="flex items-center justify-between pb-3 gap-4">
					{/* Search (if provider supports it) */}
					{canSearch ? (
						<div className="relative flex-1 max-w-xs">
							<MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-kumo-subtle" />
							<Input
								type="search"
								placeholder={t`Search...`}
								aria-label={t`Search media`}
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-9"
							/>
						</div>
					) : (
						<p className="text-sm text-kumo-subtle">
							<Plural value={items.length} one="# item" other="# items" />
						</p>
					)}

					{/* Upload button (if provider supports it) */}
					{canUpload && (
						<>
							<Button
								size="sm"
								icon={<Upload />}
								onClick={() => fileInputRef.current?.click()}
								disabled={isUploading}
							>
								{isUploading ? t`Uploading...` : t`Upload`}
							</Button>
							<input
								ref={fileInputRef}
								type="file"
								accept={mimeTypeFilter ? `${mimeTypeFilter}*` : undefined}
								className="sr-only"
								onChange={handleFileSelect}
								aria-label={t`Upload file`}
							/>
						</>
					)}
				</div>

				{/* Upload error */}
				<DialogError
					message={uploadError ? t`Upload failed: ${uploadError}` : null}
					className="mb-3"
				/>

				{/* Media Grid */}
				<div className="flex-1 overflow-y-auto min-h-[300px]">
					{isLoading ? (
						<div className="flex items-center justify-center h-full">
							<Loader />
						</div>
					) : items.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full text-center p-8">
							<Image className="h-12 w-12 text-kumo-subtle mb-4" aria-hidden="true" />
							<h3 className="text-lg font-medium">{t`No media found`}</h3>
							<p className="text-sm text-kumo-subtle mt-1">
								{canSearch && searchQuery
									? t`Try a different search term`
									: canUpload
										? t`Upload an image to get started`
										: t`No media available from this provider`}
							</p>
							{canUpload && !searchQuery && (
								<Button
									className="mt-4"
									icon={<Upload />}
									onClick={() => fileInputRef.current?.click()}
								>
									{t`Upload Image`}
								</Button>
							)}
						</div>
					) : (
						<ul
							className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 p-1"
							role="listbox"
							aria-label={t`Available media`}
						>
							{activeProvider === "local"
								? (items as MediaItem[]).map((item) => (
										<MediaPickerItem
											key={item.id}
											item={item}
											selected={
												selectedItem?.providerId === "local" && selectedItem.item.id === item.id
											}
											onClick={() => setSelectedItem({ providerId: "local", item })}
											onDoubleClick={() => {
												onSelect(item);
												onOpenChange(false);
											}}
											onDimensionsDetected={handleDimensionsDetected}
										/>
									))
								: (items as MediaProviderItem[]).map((item) => (
										<ProviderMediaItem
											key={item.id}
											item={item}
											selected={
												selectedItem?.providerId === activeProvider &&
												selectedItem.item.id === item.id
											}
											onClick={() => setSelectedItem({ providerId: activeProvider, item })}
											onDoubleClick={() => {
												// Merge loaded dimensions for double-click select
												const dims = providerDimensions[item.id];
												const itemWithDims = dims
													? {
															...item,
															width: item.width ?? dims.width,
															height: item.height ?? dims.height,
														}
													: item;
												const mediaItem = providerItemToMediaItem(activeProvider, itemWithDims);
												onSelect(mediaItem);
												onOpenChange(false);
											}}
											onDimensionsLoaded={(width, height) => {
												setProviderDimensions((prev) => ({
													...prev,
													[item.id]: { width, height },
												}));
											}}
										/>
									))}
						</ul>
					)}
				</div>

				{/* Footer */}
				<div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 border-t pt-4">
					<div className="flex-1 text-sm text-kumo-subtle">
						{selectedItem && (
							<span>
								{t`Selected:`} <strong>{selectedItem.item.filename}</strong>
								{selectedItem.providerId !== "local" && (
									<span className="ml-2 text-xs">
										(from {providers?.find((p) => p.id === selectedItem.providerId)?.name})
									</span>
								)}
							</span>
						)}
					</div>
					<Button variant="outline" onClick={handleClose}>
						{t`Cancel`}
					</Button>
					<Button onClick={handleConfirm} disabled={!selectedItem}>
						{t`Insert`}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

interface MediaPickerItemProps {
	item: MediaItem;
	selected: boolean;
	onClick: () => void;
	onDoubleClick: () => void;
	onDimensionsDetected?: (id: string, width: number, height: number) => void;
}

function MediaPickerItem({
	item,
	selected,
	onClick,
	onDoubleClick,
	onDimensionsDetected,
}: MediaPickerItemProps) {
	const isImage = item.mimeType.startsWith("image/");
	const needsDimensions = isImage && (!item.width || !item.height);

	const handleImageLoad = React.useCallback(
		(e: React.SyntheticEvent<HTMLImageElement>) => {
			if (needsDimensions && onDimensionsDetected) {
				const img = e.currentTarget;
				if (img.naturalWidth && img.naturalHeight) {
					onDimensionsDetected(item.id, img.naturalWidth, img.naturalHeight);
				}
			}
		},
		[needsDimensions, onDimensionsDetected, item.id],
	);

	return (
		<li role="option" aria-selected={selected}>
			<button
				type="button"
				className={cn(
					"relative aspect-square w-full rounded-lg border-2 overflow-hidden transition-all",
					"hover:border-kumo-brand/50 focus:outline-none focus:ring-2 focus:ring-kumo-ring",
					selected ? "border-kumo-brand ring-2 ring-kumo-brand/20" : "border-transparent",
				)}
				onClick={onClick}
				onDoubleClick={onDoubleClick}
				aria-label={`${item.filename}${selected ? " (selected)" : ""}`}
			>
				{isImage ? (
					<img
						src={item.url}
						alt=""
						className="h-full w-full object-cover"
						onLoad={handleImageLoad}
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
						<span className="text-3xl" aria-hidden="true">
							{getFileIcon(item.mimeType)}
						</span>
					</div>
				)}

				{selected && (
					<div
						className="absolute inset-0 bg-kumo-brand/20 flex items-center justify-center"
						aria-hidden="true"
					>
						<div className="bg-kumo-brand text-white rounded-full p-1">
							<Check className="h-4 w-4" />
						</div>
					</div>
				)}

				<div
					className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2"
					aria-hidden="true"
				>
					<p className="text-xs text-white truncate">{item.filename}</p>
				</div>
			</button>
		</li>
	);
}

interface ProviderMediaItemProps {
	item: MediaProviderItem;
	selected: boolean;
	onClick: () => void;
	onDoubleClick: () => void;
	/** Callback when image dimensions are loaded (for providers that don't return dimensions) */
	onDimensionsLoaded?: (width: number, height: number) => void;
}

function ProviderMediaItem({
	item,
	selected,
	onClick,
	onDoubleClick,
	onDimensionsLoaded,
}: ProviderMediaItemProps) {
	const isImage = item.mimeType.startsWith("image/");
	const needsDimensions = isImage && (!item.width || !item.height);

	const handleImageLoad = React.useCallback(
		(e: React.SyntheticEvent<HTMLImageElement>) => {
			if (needsDimensions && onDimensionsLoaded) {
				const img = e.currentTarget;
				if (img.naturalWidth && img.naturalHeight) {
					onDimensionsLoaded(img.naturalWidth, img.naturalHeight);
				}
			}
		},
		[needsDimensions, onDimensionsLoaded],
	);

	return (
		<li role="option" aria-selected={selected}>
			<button
				type="button"
				className={cn(
					"relative aspect-square w-full rounded-lg border-2 overflow-hidden transition-all",
					"hover:border-kumo-brand/50 focus:outline-none focus:ring-2 focus:ring-kumo-ring",
					selected ? "border-kumo-brand ring-2 ring-kumo-brand/20" : "border-transparent",
				)}
				onClick={onClick}
				onDoubleClick={onDoubleClick}
				aria-label={`${item.filename}${selected ? " (selected)" : ""}`}
			>
				{isImage && item.previewUrl ? (
					<img
						src={item.previewUrl}
						alt=""
						className="h-full w-full object-cover"
						onLoad={handleImageLoad}
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
						<span className="text-3xl" aria-hidden="true">
							{getFileIcon(item.mimeType)}
						</span>
					</div>
				)}

				{selected && (
					<div
						className="absolute inset-0 bg-kumo-brand/20 flex items-center justify-center"
						aria-hidden="true"
					>
						<div className="bg-kumo-brand text-white rounded-full p-1">
							<Check className="h-4 w-4" />
						</div>
					</div>
				)}

				<div
					className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-2"
					aria-hidden="true"
				>
					<p className="text-xs text-white truncate">{item.filename}</p>
				</div>
			</button>
		</li>
	);
}

export default MediaPickerModal;
