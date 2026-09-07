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
import { ScrollArea } from "@cloudflare/kumo/primitives/scroll-area";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	Globe,
	Image,
	ImagesSquare,
	List,
	LinkSimple,
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
import {
	MediaBrowserFolder,
	MediaBrowserItem,
	MediaSelectionTrayItem,
	MediaUploadPlaceholder,
	mimeForMediaTypeFilter,
} from "./media/MediaBrowserItems.js";
import { useMediaUploadQueue } from "./media/useMediaUploadQueue.js";
import { TableToolbar, TableToolbarSearch } from "./TableToolbar.js";

const URL_SOURCE = "__url";
const PICKER_PAGE_SIZE = 12;

interface SelectedMedia {
	key: string;
	providerId: string;
	item: MediaItem | MediaProviderItem;
	uploadJobId?: number;
}

interface UploadedMedia {
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

function matchesFilenameSearch(filename: string, search: string): boolean {
	return !search || filename.toLowerCase().includes(search.toLowerCase());
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

function appendUniqueSelections(
	current: SelectedMedia[],
	additions: SelectedMedia[],
	sortUploads = true,
) {
	const keys = new Set(current.map((selected) => selected.key));
	const next = [...current];
	for (const selected of additions) {
		if (keys.has(selected.key)) continue;
		keys.add(selected.key);
		next.push(selected);
	}
	if (sortUploads) {
		const uploadPositions = next.flatMap((selected, index) =>
			selected.uploadJobId === undefined ? [] : [index],
		);
		const uploads = uploadPositions
			.map((index) => next[index]!)
			.toSorted((first, second) => first.uploadJobId! - second.uploadJobId!);
		uploadPositions.forEach((position, index) => {
			next[position] = uploads[index]!;
		});
	}
	return next;
}

function withLocalMediaUrl(item: MediaItem): MediaItem {
	if (item.url || !item.storageKey) return item;
	return { ...item, url: `/_emdash/api/media/file/${item.storageKey}` };
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
	const [retainedTotalCount, setRetainedTotalCount] = React.useState(0);
	const [imageUrl, setImageUrl] = React.useState("");
	const [urlError, setUrlError] = React.useState<string | null>(null);
	const [isProbing, setIsProbing] = React.useState(false);
	const [liveMessage, setLiveMessage] = React.useState("");
	const [pinnedItems, setPinnedItems] = React.useState<SelectedMedia[]>([]);
	const [providerDimensions, setProviderDimensions] = React.useState<
		Record<string, { width: number; height: number }>
	>({});
	const fileInputRef = React.useRef<HTMLInputElement>(null);
	const updatedDimensionsRef = React.useRef(new Set<string>());
	const urlProbeIdRef = React.useRef(0);
	const uploadTargetsRef = React.useRef(new Map<number, string>());
	const selectionOrderEditedRef = React.useRef(false);
	const invalidateUrlProbe = React.useCallback(() => {
		urlProbeIdRef.current += 1;
		setIsProbing(false);
	}, []);
	const uploadFile = React.useCallback(
		async (
			file: File,
			{ signal, jobId }: { signal: AbortSignal; jobId: number; attempt: number },
		): Promise<UploadedMedia> => {
			const providerId = uploadTargetsRef.current.get(jobId);
			if (!providerId) throw new Error("Missing upload target");
			if (providerId === "local") {
				return {
					providerId,
					item: withLocalMediaUrl(await uploadMedia(file, { fieldId, signal })),
				};
			}
			return {
				providerId,
				item: await uploadToProvider(providerId, file, undefined, { signal }),
			};
		},
		[fieldId],
	);
	const uploadQueue = useMediaUploadQueue<UploadedMedia>({ upload: uploadFile });

	React.useEffect(() => {
		if (!open) return;
		setActiveSource("local");
		setSelectedItems([]);
		setSearchQuery("");
		setTypeFilter("all");
		setViewMode("grid");
		setFolderId(undefined);
		setPage(1);
		setRetainedTotalCount(0);
		setImageUrl("");
		setUrlError(null);
		invalidateUrlProbe();
		setLiveMessage("");
		setPinnedItems([]);
		setProviderDimensions({});
		updatedDimensionsRef.current.clear();
		uploadQueue.reset();
		uploadTargetsRef.current.clear();
		selectionOrderEditedRef.current = false;
	}, [invalidateUrlProbe, localOnly, open, uploadQueue.reset]);

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
					limit: PICKER_PAGE_SIZE,
				},
			] as const,
		[activeSearch, folderId, mimeKey, page],
	);
	const localQuery = useQuery({
		queryKey: localQueryKey,
		queryFn: () =>
			fetchMediaList({
				page,
				limit: PICKER_PAGE_SIZE,
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
	const lastPage = Math.max(
		1,
		Math.ceil((localQuery.data?.totalCount ?? totalCount) / PICKER_PAGE_SIZE),
	);
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

	React.useEffect(() => {
		if (uploadQueue.hasUnfinished) return;
		const completed = uploadQueue.jobs.filter(
			(job): job is typeof job & { result: UploadedMedia } =>
				job.status === "complete" && job.result !== undefined,
		);
		if (completed.length === 0) return;
		const additions = completed.map(({ id, result }) => ({
			key: selectionKey(result.providerId, result.item),
			providerId: result.providerId,
			item: result.item,
			uploadJobId: id,
		}));
		setPinnedItems((current) => appendUniqueSelections(current, additions));
		setSelectedItems((current) => {
			if (!multiple) return [additions.at(-1)!];
			return appendUniqueSelections(current, additions, !selectionOrderEditedRef.current);
		});
		for (const providerId of new Set(additions.map((selected) => selected.providerId))) {
			void queryClient.invalidateQueries({
				queryKey: providerId === "local" ? ["media"] : ["provider-media", providerId],
			});
		}
		for (const job of completed) {
			uploadTargetsRef.current.delete(job.id);
			uploadQueue.remove(job.id);
		}
	}, [multiple, queryClient, uploadQueue.hasUnfinished, uploadQueue.jobs, uploadQueue.remove]);

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
		if (!source || source === activeSource || uploadQueue.hasUnfinished) return;
		if (activeSource === URL_SOURCE) invalidateUrlProbe();
		setActiveSource(source);
		setSearchQuery("");
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
		uploadQueue.reset();
		uploadTargetsRef.current.clear();
		setPinnedItems([]);
		onOpenChange(false);
		setSelectedItems([]);
	};
	const moveSelectedItem = (from: number, to: number, filename: string) => {
		if (to < 0 || to >= selectedItems.length) return;
		selectionOrderEditedRef.current = true;
		setSelectedItems((current) => {
			if (!current[from] || !current[to]) return current;
			const next = [...current];
			const [moved] = next.splice(from, 1);
			next.splice(to, 0, moved!);
			return next;
		});
		setLiveMessage(t`Moved ${filename} to position ${to + 1}.`);
	};
	const removeSelectedItem = (selected: SelectedMedia) => {
		selectionOrderEditedRef.current = true;
		setSelectedItems((current) => current.filter((item) => item.key !== selected.key));
		setLiveMessage(t`Removed ${selected.item.filename} from selection.`);
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
	const hasSourceControls = sourceTabs.length > 1 || canUpload;
	const canSearch = activeSource === "local" || Boolean(activeProviderInfo?.capabilities.search);
	const currentLoading = activeSource === "local" ? localQuery.isPending : providerQuery.isPending;
	const currentFetching =
		activeSource === "local" ? localQuery.isFetching : providerQuery.isFetching;
	const fetchedItems: Array<MediaItem | MediaProviderItem> =
		activeSource === "local" ? localItems : providerItems;
	const visibleItems = React.useMemo(() => {
		const pinnedSearch = activeSource === "local" ? activeSearch : searchQuery.trim();
		const pinnedMimeFilters = activeSource === "local" ? effectiveMimeFilters : filters;
		const pinned = pinnedItems.filter(
			(selected) =>
				selected.providerId === activeSource &&
				!(activeSource === "local" && folderId && !activeSearch) &&
				!(activeSource === "local" && effectiveMimeFilters?.length === 0) &&
				matchesFilenameSearch(selected.item.filename, pinnedSearch) &&
				matchesAnyFilter(selected.item.mimeType, pinnedMimeFilters),
		);
		const keys = new Set(pinned.map((selected) => selected.key));
		return [
			...pinned.map((selected) => selected.item),
			...fetchedItems.filter((item) => !keys.has(selectionKey(activeSource, item))),
		];
	}, [
		activeSearch,
		activeSource,
		effectiveMimeFilters,
		fetchedItems,
		filters,
		folderId,
		pinnedItems,
		searchQuery,
	]);
	const visibleUploadJobs = uploadQueue.jobs.filter(
		(job) => job.status !== "complete" && uploadTargetsRef.current.get(job.id) === activeSource,
	);
	const hasVisibleItems = visibleItems.length > 0 || visibleUploadJobs.length > 0;
	const enqueueFiles = React.useCallback(
		(files: readonly File[]) => {
			if (!canUpload || files.length === 0) return;
			const compatible = filters?.length
				? files.filter((file) => matchesAnyFilter(file.type, filters))
				: [...files];
			const accepted = multiple ? compatible : compatible.slice(0, 1);
			const rejectedCount = files.length - accepted.length;
			const jobs = uploadQueue.addFiles(accepted);
			for (const job of jobs) uploadTargetsRef.current.set(job.id, activeSource);
			if (rejectedCount > 0) {
				setLiveMessage(
					plural(rejectedCount, {
						one: "# file was not added.",
						other: "# files were not added.",
					}),
				);
			}
		},
		[activeSource, canUpload, filters, multiple, uploadQueue.addFiles],
	);
	const selectionTray =
		multiple && selectedItems.length > 0 ? (
			<section aria-labelledby="media-picker-selection" className="grid gap-2">
				<h2 id="media-picker-selection" className="text-sm font-semibold">
					{t`Selected media`}
				</h2>
				<ul className="grid gap-2">
					{selectedItems.map((selected, index) => (
						<MediaSelectionTrayItem
							key={selected.key}
							item={toMediaItem(selected)}
							position={index + 1}
							total={selectedItems.length}
							onMoveEarlier={() => moveSelectedItem(index, index - 1, selected.item.filename)}
							onMoveLater={() => moveSelectedItem(index, index + 1, selected.item.filename)}
							onRemove={() => removeSelectedItem(selected)}
						/>
					))}
				</ul>
			</section>
		) : null;

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) handleClose();
			}}
		>
			<Dialog
				size="xl"
				className="flex h-[min(48rem,calc(100dvh-1rem))] w-[calc(100vw-2rem)] min-h-0 min-w-0 max-w-[48rem] flex-col overflow-hidden p-0 sm:w-[min(48rem,calc(100vw-2rem))]"
			>
				<header className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-5 py-4 sm:px-7">
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
								size="base"
								aria-label={t`Close`}
								icon={<X aria-hidden="true" />}
							/>
						)}
					/>
				</header>

				<div
					className="flex min-h-0 flex-1 flex-col overflow-hidden"
					onDragOver={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						event.dataTransfer.dropEffect = canUpload ? "copy" : "none";
					}}
					onDrop={(event) => {
						if (!event.dataTransfer.types.includes("Files")) return;
						event.preventDefault();
						if (!canUpload) return;
						enqueueFiles([...event.dataTransfer.files]);
					}}
				>
					{hasSourceControls && (
						<div className="flex shrink-0 flex-wrap items-center gap-2 px-5 py-4 sm:px-7">
							{sourceTabs.length > 1 && (
								<div aria-disabled={uploadQueue.hasUnfinished || undefined} data-source-tabs>
									<Tabs
										variant="segmented"
										size="base"
										listClassName="px-px"
										indicatorClassName="rounded-[7px]"
										value={activeSource}
										onValueChange={changeSource}
										tabs={sourceTabs.map((source) => ({
											value: source.id,
											className: "my-px h-[34px] rounded-[7px] px-3",
											render: (props) => <button {...props} disabled={uploadQueue.hasUnfinished} />,
											label: (
												<span className="flex items-center gap-2">
													{source.id === "local" ? (
														<ImagesSquare className="size-4" aria-hidden="true" />
													) : source.id === URL_SOURCE ? (
														<LinkSimple className="size-4" aria-hidden="true" />
													) : source.icon ? (
														source.icon.startsWith("data:") ? (
															<img src={source.icon} alt="" className="size-4" aria-hidden="true" />
														) : (
															<span aria-hidden="true">{source.icon}</span>
														)
													) : null}
													{source.name}
												</span>
											),
										}))}
									/>
								</div>
							)}
							{canUpload && (
								<>
									<Button
										variant="outline"
										size="base"
										className="ms-auto"
										onClick={() => fileInputRef.current?.click()}
										icon={<Upload aria-hidden="true" />}
									>
										{t`Upload files`}
									</Button>
									<input
										ref={fileInputRef}
										type="file"
										multiple={multiple}
										accept={
											filters
												? filters
														.map((filter) => (filter.endsWith("/") ? `${filter}*` : filter))
														.join(",")
												: undefined
										}
										className="sr-only"
										tabIndex={-1}
										onChange={(event) => {
											enqueueFiles([...(event.currentTarget.files ?? [])]);
											event.currentTarget.value = "";
										}}
										aria-label={t`Choose files to upload`}
									/>
								</>
							)}
						</div>
					)}

					{activeSource === URL_SOURCE ? (
						<ScrollArea.Root className="relative min-h-0 flex-1" data-media-results-scroll>
							<ScrollArea.Viewport
								className="h-full w-full overscroll-contain"
								data-media-results-viewport
							>
								<ScrollArea.Content className="grid min-h-full content-center gap-4 px-5 py-4 sm:px-7">
									<section className="mx-auto grid w-full max-w-2xl gap-4">
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
														className="w-full ps-9"
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
									{selectionTray}
								</ScrollArea.Content>
							</ScrollArea.Viewport>
							<ScrollArea.Scrollbar className="pointer-events-none w-2.5 p-0.5 opacity-0 data-[scrolling]:pointer-events-auto data-[scrolling]:opacity-100">
								<ScrollArea.Thumb className="rounded-full bg-kumo-interact" />
							</ScrollArea.Scrollbar>
						</ScrollArea.Root>
					) : (
						<>
							<div
								className={`shrink-0 space-y-4 px-5 sm:px-7 ${hasSourceControls ? "pb-4" : "py-4"}`}
							>
								{folderId && activeSource === "local" && (
									<div className="flex min-w-0 items-center gap-2">
										<Button
											variant="ghost"
											size="sm"
											disabled={uploadQueue.hasUnfinished}
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
												size="base"
												listClassName="px-px"
												indicatorClassName="rounded-[7px]"
												value={viewMode}
												onValueChange={(value) => {
													if (value === "grid" || value === "list") setViewMode(value);
												}}
												tabs={[
													{
														value: "grid",
														className: "my-px h-[34px] rounded-[7px] px-3",
														label: (
															<>
																<SquaresFour className="size-4" aria-hidden="true" />
																<span className="sr-only">{t`Grid view`}</span>
															</>
														),
													},
													{
														value: "list",
														className: "my-px h-[34px] rounded-[7px] px-3",
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
											placeholder={
												activeSource === "local" ? t`Search by filename...` : t`Search...`
											}
											aria-label={t`Search media`}
											value={searchQuery}
											onChange={(event) => {
												setSearchQuery(event.currentTarget.value);
												if (activeSource === "local") resetPage();
											}}
											maxLength={MEDIA_SEARCH_MAX_LENGTH}
											className="basis-full sm:w-72 sm:basis-auto"
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
								</TableToolbar>
							</div>

							<ScrollArea.Root className="relative min-h-0 flex-1" data-media-results-scroll>
								<ScrollArea.Viewport
									className="h-full w-full overscroll-contain"
									data-media-results-viewport
								>
									<ScrollArea.Content className="space-y-4 px-5 py-4 sm:px-7">
										{uploadQueue.overflowCount > 0 && (
											<p role="alert" className="text-sm text-kumo-danger">
												{plural(uploadQueue.overflowCount, {
													one: "# file was not added because the upload list is full.",
													other: "# files were not added because the upload list is full.",
												})}
											</p>
										)}
										{activeSource === "local" && localQuery.error && localItems.length > 0 && (
											<div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
												<span>{t`The latest media request failed. Showing the previous page.`}</span>
												<Button
													variant="outline"
													size="sm"
													onClick={() => void localQuery.refetch()}
												>
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
														<div
															className="grid grid-cols-[repeat(auto-fill,minmax(min(12rem,100%),1fr))] gap-2"
															inert={uploadQueue.hasUnfinished || undefined}
														>
															{folders.map((folder) => (
																<MediaBrowserFolder
																	key={folder.id}
																	folder={folder}
																	onOpen={() => {
																		if (uploadQueue.hasUnfinished) return;
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
															disabled={
																foldersQuery.isFetchingNextPage || uploadQueue.hasUnfinished
															}
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
													inert={currentFetching || undefined}
													data-media-items
												>
													{visibleUploadJobs.map((job) => (
														<MediaUploadPlaceholder
															key={job.id}
															job={job}
															layout="grid"
															onRetry={() => uploadQueue.retry(job.id)}
															onRemove={() => {
																uploadTargetsRef.current.delete(job.id);
																uploadQueue.remove(job.id);
															}}
														/>
													))}
													{visibleItems.map((rawItem) => {
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
												<div
													className="grid gap-2"
													inert={currentFetching || undefined}
													data-media-items
												>
													{visibleUploadJobs.map((job) => (
														<MediaUploadPlaceholder
															key={job.id}
															job={job}
															layout="list"
															onRetry={() => uploadQueue.retry(job.id)}
															onRemove={() => {
																uploadTargetsRef.current.delete(job.id);
																uploadQueue.remove(job.id);
															}}
														/>
													))}
													{visibleItems.map((rawItem) => {
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
										{selectionTray}
									</ScrollArea.Content>
								</ScrollArea.Viewport>
								<ScrollArea.Scrollbar className="pointer-events-none w-2.5 p-0.5 opacity-0 data-[scrolling]:pointer-events-auto data-[scrolling]:opacity-100">
									<ScrollArea.Thumb className="rounded-full bg-kumo-interact" />
								</ScrollArea.Scrollbar>
							</ScrollArea.Root>

							{activeSource === "local" && totalCount > 0 && (
								<div
									className="shrink-0 border-t border-kumo-line px-5 py-3 sm:px-7"
									data-media-pagination
								>
									<Pagination
										page={isRecoveringPage ? lastPage : page}
										setPage={(nextPage) => {
											const pageCount = Math.max(1, Math.ceil(totalCount / PICKER_PAGE_SIZE));
											if (
												localQuery.isFetching ||
												!Number.isSafeInteger(nextPage) ||
												nextPage < 1 ||
												nextPage > pageCount
											)
												return;
											setPage(nextPage);
										}}
										perPage={PICKER_PAGE_SIZE}
										totalCount={totalCount}
										className="flex-wrap gap-y-2"
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
										<Pagination.Info className="min-w-0 flex-1">
											{({ pageShowingRange, totalCount: count }) => (
												<span role="status">{t`Showing ${pageShowingRange} of ${count ?? 0}`}</span>
											)}
										</Pagination.Info>
										<div inert={localQuery.isFetching || undefined} className="contents">
											<Pagination.Controls
												controls="full"
												className="basis-full sm:basis-auto sm:grow-0 rtl:[&_svg]:-scale-x-100"
											/>
										</div>
									</Pagination>
								</div>
							)}
						</>
					)}
				</div>

				<footer
					className="flex shrink-0 justify-end border-t border-kumo-line px-5 py-3 sm:px-7"
					data-media-actions
				>
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button variant="outline" onClick={handleClose}>
							{t`Cancel`}
						</Button>
						<Button
							variant="primary"
							onClick={handleConfirm}
							disabled={selectedItems.length === 0 || uploadQueue.hasUnfinished}
						>
							{confirmText}
						</Button>
					</div>
				</footer>
				<span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
					{uploadQueue.hasUnfinished
						? plural(
								uploadQueue.jobs.filter(
									(job) => job.status === "queued" || job.status === "uploading",
								).length,
								{ one: "# file uploading", other: "# files uploading" },
							)
						: uploadQueue.failedCount > 0
							? plural(uploadQueue.failedCount, {
									one: "# upload failed",
									other: "# uploads failed",
								})
							: liveMessage}
				</span>
			</Dialog>
		</Dialog.Root>
	);
}

export default MediaPickerModal;
