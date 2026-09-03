import {
	Button,
	Dialog,
	Grid,
	Input,
	Label,
	Loader,
	Pagination,
	Select,
	Tabs,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	Globe,
	Image,
	List,
	Paperclip,
	SquaresFour,
	Upload,
	X,
} from "@phosphor-icons/react";
import {
	keepPreviousData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import * as React from "react";

import {
	ApiResponseError,
	MEDIA_SEARCH_MAX_LENGTH,
	fetchMediaFolder,
	fetchMediaFolders,
	fetchMediaList,
	fetchMediaProviders,
	fetchProviderMedia,
	uploadMedia,
	uploadToProvider,
	updateMedia,
	type MediaItem,
	type MediaProviderItem,
} from "../lib/api.js";
import { useDebouncedValue } from "../lib/hooks.js";
import { canonicalMediaProviderId, providerItemToMediaItem } from "../lib/media-utils.js";
import { matchesMimeAllowlist, mimeFromUrl } from "../lib/mime-utils.js";
import { DialogError } from "./DialogError.js";
import {
	MAX_MEDIA_PAGE_DROPDOWN_ITEMS,
	MEDIA_BROWSER_PAGE_SIZES,
	MediaBrowserFolder,
	MediaBrowserItem,
	mimeForMediaTypeFilter,
} from "./media/MediaBrowserItems.js";
import { TableToolbar, TableToolbarSearch } from "./TableToolbar.js";

const URL_SOURCE = "__url";
const DEFAULT_PAGE_SIZE = MEDIA_BROWSER_PAGE_SIZES[0]!;

interface SelectedMedia {
	key: string;
	providerId: string;
	item: MediaItem | MediaProviderItem;
}

function matchesAnyFilter(mime: string, filters: string[] | undefined): boolean {
	if (!filters || filters.length === 0) return true;
	return filters.some((entry) => {
		if (!entry || !entry.includes("/")) return false;
		return entry.endsWith("/")
			? mime.toLowerCase().startsWith(entry.toLowerCase())
			: mime.toLowerCase() === entry.toLowerCase();
	});
}

function filtersOverlap(first: string, second: string): string | null {
	const left = first.toLowerCase();
	const right = second.toLowerCase();
	if (left === right) return left;
	if (left.endsWith("/") && right.startsWith(left)) return right;
	if (right.endsWith("/") && left.startsWith(right)) return left;
	return null;
}

function intersectMimeFilters(
	allowed: string[] | undefined,
	chosen: string | string[] | undefined,
): string[] | undefined {
	if (!allowed?.length) {
		if (!chosen) return undefined;
		return Array.isArray(chosen) ? chosen : [chosen];
	}
	if (!chosen) return allowed;
	const chosenFilters = Array.isArray(chosen) ? chosen : [chosen];
	return [
		...new Set(
			allowed.flatMap((allowedMime) =>
				chosenFilters.flatMap((chosenMime) => filtersOverlap(allowedMime, chosenMime) ?? []),
			),
		),
	];
}

function selectionKey(providerId: string, item: MediaItem | MediaProviderItem): string {
	if (providerId === URL_SOURCE) return `external:${(item as MediaItem).url}`;
	return `${canonicalMediaProviderId(providerId)}:${item.id}`;
}

function probeImageDimensions(
	url: string,
	errorMessage: string,
): Promise<{ width: number; height: number }> {
	return new Promise((resolve, reject) => {
		const image = new window.Image();
		image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
		image.onerror = () => reject(new Error(errorMessage));
		image.src = url;
	});
}

export interface MediaPickerModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (item: MediaItem) => void;
	multiple?: boolean;
	onSelectMany?: (items: MediaItem[]) => void;
	mimeTypeFilter?: string;
	title?: string;
	confirmLabel?: string;
	hideUrlInput?: boolean;
	mediaKind?: "image" | "file";
	mimeTypeFilters?: string[];
	fieldId?: string;
	localOnly?: boolean;
}

export function MediaPickerModal({
	open,
	onOpenChange,
	onSelect,
	multiple = false,
	onSelectMany,
	mimeTypeFilter = "image/",
	mimeTypeFilters,
	fieldId,
	title: providedTitle,
	confirmLabel,
	hideUrlInput = false,
	mediaKind = "image",
	localOnly = false,
}: MediaPickerModalProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const isFileKind = mediaKind === "file";
	const filters = React.useMemo(() => {
		if (mimeTypeFilters !== undefined) {
			return mimeTypeFilters.length > 0 ? mimeTypeFilters : undefined;
		}
		return mimeTypeFilter ? [mimeTypeFilter] : undefined;
	}, [mimeTypeFilter, mimeTypeFilters]);
	const title = providedTitle ?? (isFileKind ? t`Select file` : t`Select image`);
	const description = isFileKind
		? t`Choose a file from the library or upload a new one.`
		: t`Choose an image from the library or upload a new one.`;
	const EmptyStateIcon = isFileKind ? Paperclip : Image;

	const [activeSource, setActiveSource] = React.useState("local");
	const [selectedItems, setSelectedItems] = React.useState<SelectedMedia[]>([]);
	const [searchQuery, setSearchQuery] = React.useState("");
	const debouncedSearch = useDebouncedValue(searchQuery, 300).trim();
	const activeSearch = searchQuery.trim() ? debouncedSearch : "";
	const [typeFilter, setTypeFilter] = React.useState("all");
	const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
	const [folderId, setFolderId] = React.useState<string | undefined>();
	const [page, setPage] = React.useState(1);
	const [pageSize, setPageSize] = React.useState(DEFAULT_PAGE_SIZE);
	const [retainedTotalCount, setRetainedTotalCount] = React.useState(0);
	const [imageUrl, setImageUrl] = React.useState("");
	const [urlError, setUrlError] = React.useState<string | null>(null);
	const [isProbing, setIsProbing] = React.useState(false);
	const [uploadError, setUploadError] = React.useState<string | null>(null);
	const [liveMessage, setLiveMessage] = React.useState("");
	const [providerDimensions, setProviderDimensions] = React.useState<
		Record<string, { width: number; height: number }>
	>({});
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const updatedDimensionsRef = React.useRef(new Set<string>());
	const urlProbeIdRef = React.useRef(0);
	const invalidateUrlProbe = React.useCallback(() => {
		urlProbeIdRef.current += 1;
		setIsProbing(false);
	}, []);

	React.useEffect(() => {
		if (!open) return;
		setActiveSource("local");
		setSelectedItems([]);
		setSearchQuery("");
		setTypeFilter("all");
		setViewMode("grid");
		setFolderId(undefined);
		setPage(1);
		setPageSize(DEFAULT_PAGE_SIZE);
		setRetainedTotalCount(0);
		setImageUrl("");
		setUrlError(null);
		invalidateUrlProbe();
		setUploadError(null);
		setLiveMessage("");
		setProviderDimensions({});
		updatedDimensionsRef.current.clear();
	}, [invalidateUrlProbe, localOnly, open]);

	const providersQuery = useQuery({
		queryKey: ["media-providers"],
		queryFn: fetchMediaProviders,
		enabled: open && !localOnly,
		placeholderData: [],
	});
	const providers = providersQuery.data ?? [];
	const urlSourceAvailable =
		!hideUrlInput &&
		!localOnly &&
		(!filters || filters.some((mime) => filtersOverlap(mime, "image/")));
	const sourceTabs = React.useMemo(() => {
		const tabs: Array<{ id: string; name: string; icon?: string }> = [
			{ id: "local", name: t`Library` },
		];
		for (const provider of providers) {
			if (provider.id !== "local") tabs.push(provider);
		}
		if (urlSourceAvailable) tabs.push({ id: URL_SOURCE, name: t`From URL` });
		return tabs;
	}, [providers, t, urlSourceAvailable]);
	React.useEffect(() => {
		if (sourceTabs.some((source) => source.id === activeSource)) return;
		if (activeSource === URL_SOURCE) invalidateUrlProbe();
		setActiveSource("local");
	}, [activeSource, invalidateUrlProbe, sourceTabs]);
	const activeProviderInfo =
		activeSource === "local"
			? {
					id: "local",
					name: t`Library`,
					capabilities: { browse: true, search: true, upload: true, delete: false },
				}
			: providers.find((provider) => provider.id === activeSource);

	const typeItems = React.useMemo(() => {
		const items: Record<string, string> = { all: t`All types` };
		for (const [value, label] of [
			["image", t`Images`],
			["video", t`Video`],
			["audio", t`Audio`],
			["document", t`Documents`],
		] as const) {
			const category = mimeForMediaTypeFilter(value);
			if (intersectMimeFilters(filters, category)?.length !== 0) items[value] = label;
		}
		return items;
	}, [filters, t]);
	React.useEffect(() => {
		if (typeFilter in typeItems) return;
		setTypeFilter("all");
		setPage(1);
		setRetainedTotalCount(0);
	}, [typeFilter, typeItems]);
	const effectiveMimeFilters = React.useMemo(
		() => intersectMimeFilters(filters, mimeForMediaTypeFilter(typeFilter)),
		[filters, typeFilter],
	);
	const mimeKey = effectiveMimeFilters?.join(",") ?? "";
	const localQueryKey = React.useMemo(
		() =>
			[
				"media",
				"picker",
				{
					search: activeSearch,
					mime: mimeKey,
					folder: activeSearch ? "all" : (folderId ?? "main"),
					page,
					pageSize,
				},
			] as const,
		[activeSearch, folderId, mimeKey, page, pageSize],
	);
	const localQuery = useQuery({
		queryKey: localQueryKey,
		queryFn: () =>
			fetchMediaList({
				page,
				limit: pageSize,
				search: activeSearch || undefined,
				mimeType: effectiveMimeFilters,
				folderId: activeSearch ? undefined : (folderId ?? null),
			}),
		enabled: open && activeSource === "local" && effectiveMimeFilters?.length !== 0,
		placeholderData: keepPreviousData,
	});

	React.useEffect(() => {
		if (localQuery.data?.totalCount !== undefined) {
			setRetainedTotalCount(localQuery.data.totalCount);
		}
	}, [localQuery.data?.totalCount]);
	const fallbackItemCount = localQuery.data?.items.length ?? 0;
	const totalCount = localQuery.data?.totalCount ?? (retainedTotalCount || fallbackItemCount);
	const lastPage = Math.max(1, Math.ceil((localQuery.data?.totalCount ?? totalCount) / pageSize));
	const isRecoveringPage =
		localQuery.data?.totalCount !== undefined && page > lastPage && activeSource === "local";
	React.useEffect(() => {
		if (isRecoveringPage) setPage(lastPage);
	}, [isRecoveringPage, lastPage]);

	const showFolderResults =
		activeSource === "local" &&
		page === 1 &&
		typeFilter === "all" &&
		(!folderId || Boolean(activeSearch));
	const foldersQuery = useInfiniteQuery({
		queryKey: ["media-folders", "picker", { search: activeSearch }],
		queryFn: ({ pageParam }) =>
			fetchMediaFolders({ limit: 100, cursor: pageParam, search: activeSearch || undefined }),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastFolderPage) => lastFolderPage.nextCursor,
		enabled: open && showFolderResults,
	});
	const folders = React.useMemo(
		() => foldersQuery.data?.pages.flatMap((folderPage) => folderPage.items) ?? [],
		[foldersQuery.data?.pages],
	);
	const currentFolderQuery = useQuery({
		queryKey: ["media-folder", folderId],
		queryFn: () => fetchMediaFolder(folderId!),
		enabled: open && activeSource === "local" && Boolean(folderId),
		retry: (failureCount, error) =>
			!(error instanceof ApiResponseError && error.code === "NOT_FOUND") && failureCount < 2,
	});
	const missingFolder =
		currentFolderQuery.error instanceof ApiResponseError &&
		currentFolderQuery.error.code === "NOT_FOUND";
	React.useEffect(() => {
		if (!folderId || !missingFolder) return;
		setFolderId(undefined);
		setPage(1);
		setLiveMessage(t`Folder no longer exists. Returned to the main library.`);
	}, [folderId, missingFolder, t]);

	const providerQuery = useQuery({
		queryKey: ["provider-media", activeSource, filters?.join(",") ?? "", searchQuery],
		queryFn: () =>
			fetchProviderMedia(activeSource, {
				mimeType: filters,
				limit: 50,
				query: searchQuery.trim() || undefined,
			}),
		enabled: open && !localOnly && activeSource !== "local" && activeSource !== URL_SOURCE,
	});

	const updateSelection = React.useCallback(
		(providerId: string, item: MediaItem | MediaProviderItem) => {
			const key = selectionKey(providerId, item);
			setSelectedItems((current) => {
				const exists = current.some((selected) => selected.key === key);
				if (exists) return current.filter((selected) => selected.key !== key);
				const next = { key, providerId, item };
				return multiple ? [...current, next] : [next];
			});
		},
		[multiple],
	);
	const ensureSelection = React.useCallback(
		(providerId: string, item: MediaItem | MediaProviderItem) => {
			const key = selectionKey(providerId, item);
			setSelectedItems((current) => {
				if (current.some((selected) => selected.key === key)) return current;
				const next = { key, providerId, item };
				return multiple ? [...current, next] : [next];
			});
		},
		[multiple],
	);
	const toMediaItem = React.useCallback(
		(selected: SelectedMedia): MediaItem => {
			if (selected.providerId === "local" || selected.providerId === URL_SOURCE) {
				return selected.item as MediaItem;
			}
			const providerItem = selected.item as MediaProviderItem;
			const dimensions = providerDimensions[selected.key];
			return providerItemToMediaItem(
				selected.providerId,
				dimensions
					? {
							...providerItem,
							width: providerItem.width ?? dimensions.width,
							height: providerItem.height ?? dimensions.height,
						}
					: providerItem,
			);
		},
		[providerDimensions],
	);

	const uploadLocalMutation = useMutation({
		mutationFn: (file: File) => uploadMedia(file, { fieldId }),
		onSuccess: (item) => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			ensureSelection("local", item);
			setUploadError(null);
		},
		onError: (error: Error) => setUploadError(error.message),
	});
	const uploadProviderMutation = useMutation({
		mutationFn: ({ providerId, file }: { providerId: string; file: File }) =>
			uploadToProvider(providerId, file),
		onSuccess: (item, { providerId }) => {
			void queryClient.invalidateQueries({ queryKey: ["provider-media", providerId] });
			ensureSelection(providerId, item);
			setUploadError(null);
		},
		onError: (error: Error) => setUploadError(error.message),
	});
	const isUploading = uploadLocalMutation.isPending || uploadProviderMutation.isPending;

	const dimensionsMutation = useMutation({
		mutationFn: ({ id, width, height }: { id: string; width: number; height: number }) =>
			updateMedia(id, { width, height }),
		onSuccess: (_item, { id, width, height }) => {
			queryClient.setQueryData(localQueryKey, (current: typeof localQuery.data) => {
				if (!current) return current;
				return {
					...current,
					items: current.items.map((item) => (item.id === id ? { ...item, width, height } : item)),
				};
			});
			setSelectedItems((current) =>
				current.map((selected) =>
					selected.providerId === "local" && selected.item.id === id
						? { ...selected, item: { ...selected.item, width, height } }
						: selected,
				),
			);
		},
		onError: (error) => console.warn("Failed to update media dimensions:", error),
	});
	const handleDimensionsDetected = React.useCallback(
		(id: string, width: number, height: number) => {
			if (updatedDimensionsRef.current.has(id)) return;
			updatedDimensionsRef.current.add(id);
			dimensionsMutation.mutate({ id, width, height });
		},
		[dimensionsMutation],
	);
	const handleBrowserDimensions = React.useCallback(
		(
			providerId: string,
			item: MediaItem | MediaProviderItem,
			key: string,
			width: number,
			height: number,
		) => {
			if (providerId === "local") {
				handleDimensionsDetected(item.id, width, height);
				return;
			}
			setProviderDimensions((current) => ({ ...current, [key]: { width, height } }));
		},
		[handleDimensionsDetected],
	);

	const resetPage = React.useCallback(() => {
		setPage(1);
		setRetainedTotalCount(0);
	}, []);
	const changeSource = (source: string) => {
		if (!source || source === activeSource) return;
		if (activeSource === URL_SOURCE) invalidateUrlProbe();
		setActiveSource(source);
		setSearchQuery("");
		setUploadError(null);
	};
	const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.currentTarget.files?.[0];
		if (file) {
			if (activeSource === "local") uploadLocalMutation.mutate(file);
			else if (activeProviderInfo?.capabilities.upload) {
				uploadProviderMutation.mutate({ providerId: activeSource, file });
			}
		}
		event.currentTarget.value = "";
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
		const probeId = (urlProbeIdRef.current += 1);
		setIsProbing(true);
		setUrlError(null);
		try {
			const mimeType = mimeFromUrl(url) ?? "image/unknown";
			if (mimeType === "image/unknown" && filters?.length) {
				setUrlError(t`Use a URL ending in a recognized image extension, such as .jpg or .png.`);
				return;
			}
			if (filters?.length && !matchesMimeAllowlist(mimeType, filters)) {
				setUrlError(t`This field does not accept ${mimeType} files.`);
				return;
			}
			const dimensions = await probeImageDimensions(url.href, t`Failed to load image`);
			if (urlProbeIdRef.current !== probeId) return;
			const item: MediaItem = {
				id: "",
				filename: url.pathname.split("/").pop() || "external-image",
				mimeType,
				url: url.href,
				provider: "external",
				size: 0,
				width: dimensions.width,
				height: dimensions.height,
				createdAt: new Date().toISOString(),
			};
			ensureSelection(URL_SOURCE, item);
			setImageUrl("");
		} catch {
			if (urlProbeIdRef.current === probeId) setUrlError(t`Could not load image from URL`);
		} finally {
			if (urlProbeIdRef.current === probeId) setIsProbing(false);
		}
	};

	const handleConfirm = () => {
		if (selectedItems.length === 0) return;
		const items = selectedItems.map(toMediaItem);
		if (multiple) onSelectMany?.(items);
		else onSelect(items[0]!);
		onOpenChange(false);
	};
	const handleClose = () => {
		invalidateUrlProbe();
		onOpenChange(false);
		setSelectedItems([]);
	};
	const confirmText =
		confirmLabel ??
		(multiple
			? isFileKind
				? plural(selectedItems.length, { one: "Add # file", other: "Add # files" })
				: plural(selectedItems.length, { one: "Add # image", other: "Add # images" })
			: t`Select`);
	const providerItems = React.useMemo(
		() =>
			(providerQuery.data?.items ?? []).filter((item) => matchesAnyFilter(item.mimeType, filters)),
		[filters, providerQuery.data?.items],
	);
	const localItems = isRecoveringPage
		? []
		: effectiveMimeFilters?.length === 0
			? []
			: (localQuery.data?.items ?? []).filter((item) =>
					matchesAnyFilter(item.mimeType, effectiveMimeFilters),
				);
	const canUpload =
		activeSource === "local" ? !folderId : Boolean(activeProviderInfo?.capabilities.upload);
	const canSearch = activeSource === "local" || Boolean(activeProviderInfo?.capabilities.search);
	const currentLoading = activeSource === "local" ? localQuery.isPending : providerQuery.isPending;
	const currentFetching =
		activeSource === "local" ? localQuery.isFetching : providerQuery.isFetching;
	const hasVisibleItems =
		activeSource === "local" ? localItems.length > 0 : providerItems.length > 0;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) handleClose();
			}}
		>
			<Dialog
				size="xl"
				className="flex max-h-[calc(100dvh-1rem)] min-h-0 min-w-0 max-w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:max-h-[88dvh] sm:min-w-[48rem] sm:max-w-5xl"
			>
				<header className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-6">
					<div className="min-w-0">
						<Dialog.Title className="text-lg font-semibold leading-6">{title}</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm leading-5 text-kumo-subtle">
							{description}
						</Dialog.Description>
					</div>
					<Dialog.Close
						aria-label={t`Close`}
						render={(props) => (
							<Button
								{...props}
								variant="ghost"
								shape="square"
								size="sm"
								aria-label={t`Close`}
								icon={<X aria-hidden="true" />}
							/>
						)}
					/>
				</header>

				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
					{sourceTabs.length > 1 && (
						<Tabs
							variant="underline"
							value={activeSource}
							onValueChange={changeSource}
							tabs={sourceTabs.map((source) => ({
								value: source.id,
								label: (
									<span className="flex items-center gap-2">
										{source.icon &&
											(source.icon.startsWith("data:") ? (
												<img src={source.icon} alt="" className="size-4" aria-hidden="true" />
											) : (
												<span aria-hidden="true">{source.icon}</span>
											))}
										{source.name}
									</span>
								),
							}))}
						/>
					)}

					{activeSource === URL_SOURCE ? (
						<section className="mx-auto grid w-full max-w-2xl gap-4 py-6">
							<div className="grid gap-1.5">
								<Label htmlFor="media-picker-url">{t`Image URL`}</Label>
								<div className="flex flex-col gap-2 sm:flex-row">
									<div className="relative min-w-0 flex-1">
										<Globe
											className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-kumo-subtle"
											aria-hidden="true"
										/>
										<Input
											id="media-picker-url"
											type="url"
											aria-label={t`Image URL`}
											placeholder={t`https://example.com/image.jpg`}
											value={imageUrl}
											onChange={(event) => {
												setImageUrl(event.currentTarget.value);
												setUrlError(null);
											}}
											onKeyDown={(event) => {
												if (event.key !== "Enter") return;
												event.preventDefault();
												void handleUrlSubmit();
											}}
											className="ps-9"
										/>
									</div>
									<Button
										onClick={() => void handleUrlSubmit()}
										disabled={!imageUrl.trim() || isProbing}
										loading={isProbing}
									>
										{t`Use URL`}
									</Button>
								</div>
								{urlError && (
									<p role="alert" className="text-sm text-kumo-danger">
										{urlError}
									</p>
								)}
							</div>

							{selectedItems
								.filter((selected) => selected.providerId === URL_SOURCE)
								.map((selected) => (
									<MediaBrowserItem
										key={selected.key}
										item={selected.item as MediaItem}
										layout="list"
										selected
										selectable
										onClick={(event) => {
											if (event.detail > 1) return;
											updateSelection(URL_SOURCE, selected.item);
										}}
									/>
								))}
						</section>
					) : (
						<>
							{folderId && activeSource === "local" && (
								<div className="flex min-w-0 items-center gap-2">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											setFolderId(undefined);
											resetPage();
										}}
										icon={<ArrowLeft className="rtl:-scale-x-100" aria-hidden="true" />}
									>
										{t`Main library`}
									</Button>
									<span aria-hidden="true" className="text-kumo-subtle">
										/
									</span>
									<span dir="auto" className="min-w-0 truncate text-sm font-medium">
										{currentFolderQuery.data?.name ?? t`Folder`}
									</span>
								</div>
							)}
							{folderId && currentFolderQuery.error && !missingFolder && (
								<div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
									<span>{t`Could not load this folder.`}</span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => void currentFolderQuery.refetch()}
									>
										{t`Retry`}
									</Button>
								</div>
							)}

							<TableToolbar
								trailing={
									<div role="group" aria-label={t`View mode`}>
										<Tabs
											variant="segmented"
											value={viewMode}
											onValueChange={(value) => {
												if (value === "grid" || value === "list") setViewMode(value);
											}}
											tabs={[
												{
													value: "grid",
													label: (
														<>
															<SquaresFour className="size-4" aria-hidden="true" />
															<span className="sr-only">{t`Grid view`}</span>
														</>
													),
												},
												{
													value: "list",
													label: (
														<>
															<List className="size-4" aria-hidden="true" />
															<span className="sr-only">{t`List view`}</span>
														</>
													),
												},
											]}
										/>
									</div>
								}
							>
								{canSearch && (
									<TableToolbarSearch
										size="base"
										placeholder={activeSource === "local" ? t`Search by filename...` : t`Search...`}
										aria-label={t`Search media`}
										value={searchQuery}
										onChange={(event) => {
											setSearchQuery(event.currentTarget.value);
											if (activeSource === "local") resetPage();
										}}
										maxLength={MEDIA_SEARCH_MAX_LENGTH}
										className="w-full flex-1 sm:w-72"
									/>
								)}
								{activeSource === "local" && (
									<Select
										size="base"
										value={typeFilter}
										onValueChange={(value) => {
											setTypeFilter(value ?? "all");
											resetPage();
										}}
										items={typeItems}
										aria-label={t`Filter by type`}
									/>
								)}
								{canUpload && (
									<>
										<Button
											size="sm"
											onClick={() => fileInputRef.current?.click()}
											disabled={isUploading}
											loading={isUploading}
											icon={<Upload aria-hidden="true" />}
										>
											{t`Upload files`}
										</Button>
										<input
											ref={fileInputRef}
											type="file"
											accept={
												filters
													? filters
															.map((filter) => (filter.endsWith("/") ? `${filter}*` : filter))
															.join(",")
													: undefined
											}
											className="sr-only"
											tabIndex={-1}
											onChange={handleFileSelect}
											aria-label={t`Choose files to upload`}
										/>
									</>
								)}
							</TableToolbar>

							<DialogError message={uploadError ? t`Upload failed: ${uploadError}` : null} />
							{activeSource === "local" && localQuery.error && localItems.length > 0 && (
								<div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
									<span>{t`The latest media request failed. Showing the previous page.`}</span>
									<Button variant="outline" size="sm" onClick={() => void localQuery.refetch()}>
										{t`Retry`}
									</Button>
								</div>
							)}

							{showFolderResults &&
								(foldersQuery.isPending || folders.length > 0 || foldersQuery.error) && (
									<section aria-labelledby="media-picker-folders" className="grid gap-2">
										<div className="flex items-center justify-between gap-2">
											<h2 id="media-picker-folders" className="text-sm font-semibold">
												{t`Folders`}
											</h2>
											{foldersQuery.error && (
												<div className="flex items-center gap-2">
													<span className="text-sm text-kumo-danger">
														{t`Folders could not be loaded.`}
													</span>
													<Button
														variant="outline"
														size="sm"
														onClick={() => void foldersQuery.refetch()}
													>
														{t`Retry`}
													</Button>
												</div>
											)}
										</div>
										{foldersQuery.isPending && folders.length === 0 ? (
											<div
												role="status"
												className="flex items-center gap-2 text-sm text-kumo-subtle"
											>
												<Loader size="sm" />
												{t`Loading folders`}
											</div>
										) : (
											<div className="grid grid-cols-[repeat(auto-fill,minmax(min(12rem,100%),1fr))] gap-2">
												{folders.map((folder) => (
													<MediaBrowserFolder
														key={folder.id}
														folder={folder}
														onOpen={() => {
															setSearchQuery("");
															setFolderId(folder.id);
															resetPage();
														}}
													/>
												))}
											</div>
										)}
										{foldersQuery.hasNextPage && (
											<Button
												variant="outline"
												size="sm"
												onClick={() => void foldersQuery.fetchNextPage()}
												disabled={foldersQuery.isFetchingNextPage}
												loading={foldersQuery.isFetchingNextPage}
											>
												{t`Load more folders`}
											</Button>
										)}
									</section>
								)}

							<div
								role="region"
								aria-label={t`Media results`}
								aria-busy={currentFetching || undefined}
							>
								{currentLoading && !hasVisibleItems ? (
									<div
										role="status"
										className="flex min-h-48 items-center justify-center gap-2 text-sm text-kumo-subtle"
									>
										<Loader />
										{t`Loading media`}
									</div>
								) : (activeSource === "local" ? localQuery.error : providerQuery.error) &&
								  !hasVisibleItems ? (
									<div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
										<p className="text-sm text-kumo-danger">{t`Could not load media.`}</p>
										<Button
											variant="outline"
											onClick={() =>
												void (activeSource === "local"
													? localQuery.refetch()
													: providerQuery.refetch())
											}
										>
											{t`Retry`}
										</Button>
									</div>
								) : !hasVisibleItems ? (
									<div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
										<EmptyStateIcon className="size-10 text-kumo-subtle" aria-hidden="true" />
										<div className="grid gap-1">
											<h2 className="text-lg font-semibold">{t`No media found`}</h2>
											<p className="text-sm text-kumo-subtle">
												{searchQuery.trim()
													? t`Try another filename or clear your search.`
													: folderId && activeSource === "local"
														? t`This folder is empty.`
														: isFileKind
															? t`Upload a file to get started`
															: t`Upload an image to get started`}
											</p>
										</div>
									</div>
								) : viewMode === "grid" ? (
									<Grid
										variant="4up"
										gap="sm"
										className="2xl:grid-cols-5"
										inert={currentFetching || undefined}
										data-media-items
									>
										{(activeSource === "local" ? localItems : providerItems).map((rawItem) => {
											const key = selectionKey(activeSource, rawItem);
											const item =
												activeSource === "local"
													? (rawItem as MediaItem)
													: toMediaItem({ key, providerId: activeSource, item: rawItem });
											return (
												<MediaBrowserItem
													key={key}
													item={item}
													layout="grid"
													selectable
													selected={selectedItems.some((selected) => selected.key === key)}
													onClick={(event) => {
														if (event.detail > 1) return;
														updateSelection(activeSource, rawItem);
													}}
													onDimensionsLoaded={(width, height) =>
														handleBrowserDimensions(activeSource, rawItem, key, width, height)
													}
												/>
											);
										})}
									</Grid>
								) : (
									<div className="grid gap-2" inert={currentFetching || undefined} data-media-items>
										{(activeSource === "local" ? localItems : providerItems).map((rawItem) => {
											const key = selectionKey(activeSource, rawItem);
											const item =
												activeSource === "local"
													? (rawItem as MediaItem)
													: toMediaItem({ key, providerId: activeSource, item: rawItem });
											return (
												<MediaBrowserItem
													key={key}
													item={item}
													layout="list"
													selectable
													selected={selectedItems.some((selected) => selected.key === key)}
													onClick={(event) => {
														if (event.detail > 1) return;
														updateSelection(activeSource, rawItem);
													}}
													onDimensionsLoaded={(width, height) =>
														handleBrowserDimensions(activeSource, rawItem, key, width, height)
													}
												/>
											);
										})}
									</div>
								)}
							</div>

							{activeSource === "local" && totalCount > 0 && (
								<Pagination
									page={isRecoveringPage ? lastPage : page}
									setPage={(nextPage) => {
										const pageCount = Math.max(1, Math.ceil(totalCount / pageSize));
										if (
											localQuery.isFetching ||
											!Number.isSafeInteger(nextPage) ||
											nextPage < 1 ||
											nextPage > pageCount
										)
											return;
										setPage(nextPage);
									}}
									perPage={pageSize}
									totalCount={totalCount}
									className="flex-wrap gap-y-3"
									labels={{
										navigation: t`Media pagination`,
										firstPage: t`First page`,
										previousPage: t`Previous page`,
										nextPage: t`Next page`,
										lastPage: t`Last page`,
										pageNumber: t`Page number`,
										pageSize: t`Page size`,
									}}
								>
									<Pagination.Info className="min-w-fit">
										{({ pageShowingRange, totalCount: count }) => (
											<span role="status">{t`Showing ${pageShowingRange} of ${count ?? 0}`}</span>
										)}
									</Pagination.Info>
									<Pagination.Separator className="hidden sm:block" />
									<div inert={localQuery.isFetching || undefined} className="contents">
										<Pagination.PageSize
											value={pageSize}
											onChange={(nextPageSize) => {
												if (
													localQuery.isFetching ||
													!MEDIA_BROWSER_PAGE_SIZES.includes(nextPageSize)
												)
													return;
												setPageSize(nextPageSize);
												resetPage();
											}}
											options={MEDIA_BROWSER_PAGE_SIZES}
											label={t`Per page`}
										/>
										<Pagination.Controls
											pageSelector={
												Math.ceil(totalCount / pageSize) <= MAX_MEDIA_PAGE_DROPDOWN_ITEMS
													? "dropdown"
													: "input"
											}
											className="basis-full sm:basis-auto rtl:[&_svg]:-scale-x-100"
										/>
									</div>
								</Pagination>
							)}
						</>
					)}
				</div>

				<footer className="flex shrink-0 flex-col gap-3 border-t border-kumo-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
					<div className="min-w-0 text-sm text-kumo-subtle">
						{selectedItems.length > 0
							? multiple
								? plural(selectedItems.length, {
										one: "# item selected",
										other: "# items selected",
									})
								: t`Selected: ${selectedItems[0]!.item.filename}`
							: t`No media selected`}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button variant="outline" onClick={handleClose}>
							{t`Cancel`}
						</Button>
						<Button onClick={handleConfirm} disabled={selectedItems.length === 0 || isUploading}>
							{confirmText}
						</Button>
					</div>
				</footer>
				<span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
					{liveMessage}
				</span>
			</Dialog>
		</Dialog.Root>
	);
}

export default MediaPickerModal;
