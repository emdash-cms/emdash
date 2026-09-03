import {
	Badge,
	Banner,
	Breadcrumbs,
	Button,
	Grid,
	LayerCard,
	Loader,
	Pagination,
	Select,
	Tabs,
	Toasty,
	createKumoToastManager,
} from "@cloudflare/kumo";
import {
	DndContext,
	DragOverlay,
	PointerSensor,
	pointerWithin,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
	type CollisionDetection,
	type DragCancelEvent,
	type DragEndEvent,
	type DragStartEvent,
	type Modifier,
} from "@dnd-kit/core";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowLeft,
	File as FileIcon,
	Folder,
	Images,
	List,
	MagnifyingGlass,
	PencilSimple,
	Plus,
	SquaresFour,
	Upload,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	type LocalMediaItem,
	type MediaItem,
	type MediaFolder,
	type MediaUploadOptions,
	type MediaProviderItem,
	MEDIA_SEARCH_MAX_LENGTH,
	ApiResponseError,
	fetchMediaProviders,
	fetchProviderMedia,
	uploadToProvider,
} from "../lib/api";
import { useCurrentUser } from "../lib/api/current-user.js";
import {
	MEDIA_USAGE_ACTIVATION_QUERY_KEY,
	MEDIA_USAGE_PROGRESS_QUERY_KEY,
	fetchMediaUsageActivationStatus,
	fetchMediaUsageProgress,
} from "../lib/api/media-usage-activation.js";
import { useDebouncedValue } from "../lib/hooks.js";
import {
	providerItemToMediaItem,
	getFileIcon,
	formatFileSize,
	getMediaThumbnailUrl,
	getMediaPreviewUrl,
	getMediaObjectPosition,
	fallbackToOriginalThumbnail,
	MEDIA_THUMBNAIL_WIDTH,
	metaNumber,
} from "../lib/media-utils";
import { cn } from "../lib/utils";
import { MediaDetailPanel } from "./MediaDetailPanel";
import { MediaFolderDialog } from "./MediaFolderDialog.js";
import { LOCAL_MEDIA_UPLOAD_ACCEPT, MediaUploadDialog } from "./MediaUploadDialog.js";
import { RouterLinkButton } from "./RouterLinkButton.js";
import { TableToolbar, TableToolbarSearch } from "./TableToolbar.js";

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
	pagination?: MediaLibraryPagination;
	/** Called (debounced) with the filename search term for the local library. */
	onLocalSearchChange?: (q: string) => void;
	/** Called with the MIME filter for the local library (undefined = all types). */
	onLocalMimeFilterChange?: (mimeType: string | string[] | undefined) => void;
	/** Bounded folder pages owned by the main local Media route. */
	folders?: MediaFolder[];
	foldersLoading?: boolean;
	foldersError?: Error | null;
	hasMoreFolders?: boolean;
	isLoadingMoreFolders?: boolean;
	onLoadMoreFolders?: () => void;
	onActiveProviderChange?: (providerId: string) => void;
	folderId?: string;
	currentFolder?: MediaFolder | null;
	currentFolderLoading?: boolean;
	canManageFolders?: boolean;
	onOpenFolder?: (folder: MediaFolder) => void;
	onBackToMain?: () => void;
	onRetryFolders?: () => void;
	onCreateFolder?: (name: string) => Promise<MediaFolder>;
	onRenameFolder?: (folder: MediaFolder, name: string) => Promise<MediaFolder>;
	onDeleteFolder?: (folder: MediaFolder) => Promise<void>;
	canMoveMedia?: (item: LocalMediaItem) => boolean;
	onMoveMedia?: (item: LocalMediaItem, folder: MediaFolder) => Promise<void>;
}

export interface MediaLibraryPagination {
	page: number;
	perPage: number;
	totalCount: number;
	isPending: boolean;
	onPageChange: (page: number) => void;
	onPageSizeChange: (perPage: number) => void;
}

const MEDIA_PAGE_SIZE_OPTIONS = [35, 70, 90];
const MAX_DROPDOWN_PAGE_COUNT = 100;
const MEDIA_DRAG_OVERLAY_MAX_WIDTH = 384;
const MEDIA_DRAG_OVERLAY_HEIGHT = 36;
let pendingMediaLibraryScrollTop: number | null = null;

interface MediaDragData {
	kind: "local-media";
	item: LocalMediaItem;
}

interface MediaFolderTargetData {
	kind: "media-folder-target";
	folder: MediaFolder;
}

const mediaDragId = (id: string) => `media:${id}`;
const folderDropId = (id: string) => `folder:${id}`;

function isMediaDragData(value: unknown): value is MediaDragData {
	return (value as MediaDragData | undefined)?.kind === "local-media";
}

function isFolderTargetData(value: unknown): value is MediaFolderTargetData {
	return (value as MediaFolderTargetData | undefined)?.kind === "media-folder-target";
}

const centerMediaOverlayOnCursor: Modifier = ({
	activatorEvent,
	draggingNodeRect,
	transform,
	windowRect,
}) => {
	if (!activatorEvent || !draggingNodeRect || !("clientX" in activatorEvent)) return transform;
	const pointer = activatorEvent as PointerEvent;
	const previewWidth = Math.min(
		draggingNodeRect.width,
		MEDIA_DRAG_OVERLAY_MAX_WIDTH,
		(windowRect?.width ?? MEDIA_DRAG_OVERLAY_MAX_WIDTH) - 32,
	);
	return {
		...transform,
		x: transform.x + pointer.clientX - draggingNodeRect.left - previewWidth / 2,
		y: transform.y + pointer.clientY - draggingNodeRect.top - MEDIA_DRAG_OVERLAY_HEIGHT / 2,
	};
};
const MEDIA_DRAG_OVERLAY_MODIFIERS = [centerMediaOverlayOnCursor];

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
	pagination,
	onLocalSearchChange,
	onLocalMimeFilterChange,
	onActiveProviderChange,
	folders = [],
	foldersLoading,
	foldersError,
	hasMoreFolders,
	isLoadingMoreFolders,
	onLoadMoreFolders,
	folderId,
	currentFolder,
	currentFolderLoading,
	canManageFolders,
	onOpenFolder,
	onBackToMain,
	onRetryFolders,
	onCreateFolder,
	onRenameFolder,
	onDeleteFolder,
	canMoveMedia,
	onMoveMedia,
}: MediaLibraryProps) {
	const { t } = useLingui();
	const currentUser = useCurrentUser().data;
	const isAdmin = (currentUser?.role ?? 0) >= 50;
	const [activeProvider, setActiveProvider] = React.useState<string>("local");
	const activationQuery = useQuery({
		queryKey: MEDIA_USAGE_ACTIVATION_QUERY_KEY,
		queryFn: fetchMediaUsageActivationStatus,
		enabled: isAdmin && activeProvider === "local",
		retry: false,
		staleTime: 60_000,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const setupStatus = isAdmin && !activationQuery.isError ? activationQuery.data : undefined;
	const progressQuery = useQuery({
		queryKey: MEDIA_USAGE_PROGRESS_QUERY_KEY,
		queryFn: fetchMediaUsageProgress,
		enabled:
			isAdmin &&
			activeProvider === "local" &&
			!activationQuery.isError &&
			setupStatus?.state === "active",
		retry: false,
		staleTime: 60_000,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
	const setupProgress = progressQuery.data;
	const setupIncomplete =
		setupStatus &&
		(setupStatus.state !== "active" ||
			progressQuery.isError ||
			(progressQuery.isSuccess && setupProgress?.status !== "ready"));
	const [toastManager] = React.useState(createKumoToastManager);
	const [viewMode, setViewMode] = React.useState<"grid" | "list">("grid");
	const [detailItem, setDetailItem] = React.useState<MediaItem | null>(null);
	const [isDetailOpen, setIsDetailOpen] = React.useState(false);
	const [searchQuery, setSearchQuery] = React.useState("");
	const [localTypeFilter, setLocalTypeFilter] = React.useState("all");
	const mediaHeadingRef = React.useRef<HTMLHeadingElement>(null);
	const detailOpenFrameRef = React.useRef<number | null>(null);
	const paginationRequestedRef = React.useRef(false);
	const paginationWasPendingRef = React.useRef(false);
	const paginationRootRef = React.useRef<HTMLDivElement>(null);
	const paginationFocusTargetRef = React.useRef<HTMLElement | null>(null);
	const paginationFocusFallbackRef = React.useRef<"page" | "page-size">("page");
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
	const [folderDialogOpen, setFolderDialogOpen] = React.useState(false);
	const [editingFolder, setEditingFolder] = React.useState<MediaFolder | null>(null);
	const folderDialogReturnFocusRef = React.useRef<HTMLElement | null>(null);
	const [activeDragItem, setActiveDragItem] = React.useState<LocalMediaItem | null>(null);
	const suppressDragClickRef = React.useRef(false);
	const suppressDragClickTimerRef = React.useRef<number | null>(null);
	const movePendingRef = React.useRef(false);
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
	const canUploadHere = canUpload && (activeProvider !== "local" || !folderId);

	const cancelPendingDetailOpen = React.useCallback(() => {
		if (detailOpenFrameRef.current === null) return;
		window.cancelAnimationFrame(detailOpenFrameRef.current);
		detailOpenFrameRef.current = null;
	}, []);

	React.useEffect(() => cancelPendingDetailOpen, [cancelPendingDetailOpen]);
	const requestPage = React.useCallback(
		(nextPage: number) => {
			if (!pagination || pagination.isPending) return;
			const pageCount = Math.max(1, Math.ceil(pagination.totalCount / pagination.perPage));
			if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > pageCount) return;
			paginationRequestedRef.current = true;
			paginationFocusTargetRef.current =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
			paginationFocusFallbackRef.current = "page";
			pagination.onPageChange(nextPage);
		},
		[pagination],
	);
	const requestPageSize = React.useCallback(
		(nextPerPage: number) => {
			if (!pagination || pagination.isPending || !MEDIA_PAGE_SIZE_OPTIONS.includes(nextPerPage)) {
				return;
			}
			paginationRequestedRef.current = true;
			paginationFocusTargetRef.current =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
			paginationFocusFallbackRef.current = "page-size";
			pagination.onPageSizeChange(nextPerPage);
		},
		[pagination],
	);
	React.useEffect(() => {
		const pending = pagination?.isPending ?? false;
		if (activeProvider !== "local") {
			paginationRequestedRef.current = false;
			paginationFocusTargetRef.current = null;
		} else if (paginationRequestedRef.current && paginationWasPendingRef.current && !pending) {
			paginationRequestedRef.current = false;
			let focusTarget = paginationFocusTargetRef.current;
			if (!focusTarget?.isConnected || focusTarget.matches(":disabled")) {
				const slot =
					paginationFocusFallbackRef.current === "page-size"
						? "pagination-page-size"
						: "pagination-controls";
				focusTarget =
					paginationRootRef.current?.querySelector<HTMLElement>(
						`[data-slot="${slot}"] [role="combobox"], [data-slot="${slot}"] input, [data-slot="${slot}"] button:not(:disabled)`,
					) ?? null;
			}
			paginationFocusTargetRef.current = null;
			focusTarget?.focus({ preventScroll: true });
		}
		paginationWasPendingRef.current = pending;
	}, [activeProvider, pagination?.isPending]);

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
	const handleDetailItemRefreshed = React.useCallback((refreshed: LocalMediaItem) => {
		setDetailItem((current) => (current?.id === refreshed.id ? refreshed : current));
	}, []);

	const enqueueFiles = React.useCallback(
		(files: readonly File[], returnFocus?: HTMLElement | null) => {
			if (!canUploadHere || !activeProviderInfo || files.length === 0) return;
			if (returnFocus) returnFocusRef.current = returnFocus;
			setUploadTarget({ id: activeProviderInfo.id, name: activeProviderInfo.name });
			setEnqueueRequest({ id: (enqueueIdRef.current += 1), files });
			setUploadDialogOpen(true);
		},
		[activeProviderInfo, canUploadHere],
	);

	const openUploadDialog = (event: React.MouseEvent<HTMLButtonElement>) => {
		if (!canUploadHere || !activeProviderInfo) return;
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
			if (uploadDialogOpen || !canUploadHere) return;
			dragDepthRef.current += 1;
			setIsFileDragActive(true);
		};
		const handleDragOver = (event: DragEvent) => {
			if (hasFiles(event)) event.preventDefault();
		};
		const handleDragLeave = (event: DragEvent) => {
			if (dragDepthRef.current === 0 || uploadDialogOpen || !canUploadHere) return;
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
			if (uploadDialogOpen || !canUploadHere) return;
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
	}, [canUploadHere, enqueueFiles, uploadDialogOpen]);

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
	React.useEffect(() => {
		if (
			pendingMediaLibraryScrollTop === null ||
			currentLoading ||
			foldersLoading ||
			currentFolderLoading
		)
			return;
		let secondFrame: number | undefined;
		const firstFrame = window.requestAnimationFrame(() => {
			secondFrame = window.requestAnimationFrame(() => {
				const scrollContainer = document.querySelector<HTMLElement>("main");
				if (scrollContainer && pendingMediaLibraryScrollTop !== null) {
					scrollContainer.scrollTop = pendingMediaLibraryScrollTop;
				}
				pendingMediaLibraryScrollTop = null;
			});
		});
		return () => {
			window.cancelAnimationFrame(firstFrame);
			if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
		};
	}, [currentFolderLoading, currentLoading, folderId, foldersLoading]);

	const resultCount =
		activeProvider === "local"
			? (pagination?.totalCount ?? currentItems.length)
			: currentProviderItems.length;
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
	const showToolbar =
		resultCount > 0 ||
		hasActiveQuery ||
		(activeProvider === "local" &&
			(folders.length > 0 || Boolean(foldersLoading) || Boolean(foldersError)));
	const assetPage = pagination?.page ?? 1;
	const showFolderResults =
		activeProvider === "local" &&
		assetPage === 1 &&
		localTypeFilter === "all" &&
		(!folderId || searchQuery.trim() !== "");
	const visibleFolders = showFolderResults ? folders : [];
	const hasFolderSurface =
		showFolderResults &&
		(Boolean(foldersLoading) ||
			Boolean(foldersError) ||
			visibleFolders.length > 0 ||
			hasMoreFolders);
	const folderResultsMayFillView =
		showFolderResults &&
		(Boolean(foldersLoading) ||
			Boolean(foldersError) ||
			visibleFolders.length > 0 ||
			(viewMode === "list" && hasFolderSurface));
	const folderActionsAvailable =
		Boolean(canManageFolders) &&
		Boolean(onCreateFolder) &&
		Boolean(onRenameFolder) &&
		Boolean(onDeleteFolder);
	const dragDropAvailable =
		activeProvider === "local" && visibleFolders.length > 0 && Boolean(onMoveMedia);
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 8 },
		}),
	);
	const collisionDetection = React.useCallback<CollisionDetection>((args) => {
		const dragData = args.active.data.current;
		if (!isMediaDragData(dragData)) return [];
		const validFolders = args.droppableContainers.filter((container) => {
			const target = container.data.current;
			return isFolderTargetData(target) && target.folder.id !== dragData.item.folderId;
		});
		return pointerWithin({ ...args, droppableContainers: validFolders });
	}, []);

	const clearDragClickSuppression = React.useCallback(() => {
		suppressDragClickRef.current = false;
		if (suppressDragClickTimerRef.current !== null) {
			window.clearTimeout(suppressDragClickTimerRef.current);
			suppressDragClickTimerRef.current = null;
		}
	}, []);
	React.useEffect(() => {
		const handlePointerUp = () => {
			if (!suppressDragClickRef.current) return;
			if (suppressDragClickTimerRef.current !== null)
				window.clearTimeout(suppressDragClickTimerRef.current);
			suppressDragClickTimerRef.current = window.setTimeout(clearDragClickSuppression, 0);
		};
		const handlePointerCancel = () => clearDragClickSuppression();
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") clearDragClickSuppression();
		};
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerCancel);
		window.addEventListener("blur", clearDragClickSuppression);
		window.addEventListener("resize", clearDragClickSuppression);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerCancel);
			window.removeEventListener("blur", clearDragClickSuppression);
			window.removeEventListener("resize", clearDragClickSuppression);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			clearDragClickSuppression();
		};
	}, [clearDragClickSuppression]);
	const handleRootClickCapture = React.useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			if (!suppressDragClickRef.current) return;
			event.preventDefault();
			event.stopPropagation();
			clearDragClickSuppression();
		},
		[clearDragClickSuppression],
	);

	const moveMutation = useMutation({
		mutationFn: async ({ item, folder }: { item: LocalMediaItem; folder: MediaFolder }) => {
			if (!onMoveMedia) throw new Error("Media move callback unavailable");
			await onMoveMedia(item, folder);
		},
		onSuccess: (_result, { folder }) => {
			toastManager.add({
				title: t`Moved to ${folder.name}`,
				variant: "success",
				timeout: 3000,
			});
			if (!searchQuery.trim()) mediaHeadingRef.current?.focus({ preventScroll: true });
		},
		onError: (error) => {
			const title = t`Couldn’t move file`;
			let description: string;
			if (error instanceof ApiResponseError && error.code === "NOT_FOUND") {
				description = t`The file or folder no longer exists.`;
			} else if (
				error instanceof ApiResponseError &&
				(error.status === 401 || error.status === 403)
			) {
				description = t`You don’t have permission to move this file.`;
			} else {
				description = t`Try again.`;
			}
			toastManager.add({ title, description, variant: "error" });
		},
		onSettled: () => {
			movePendingRef.current = false;
		},
	});

	const handleMediaDragStart = React.useCallback((event: DragStartEvent) => {
		const data = event.active.data.current;
		if (!isMediaDragData(data)) return;
		suppressDragClickRef.current = true;
		if (suppressDragClickTimerRef.current !== null) {
			window.clearTimeout(suppressDragClickTimerRef.current);
			suppressDragClickTimerRef.current = null;
		}
		setActiveDragItem(data.item);
	}, []);
	const handleMediaDragCancel = React.useCallback((_event: DragCancelEvent) => {
		setActiveDragItem(null);
	}, []);
	const handleMediaDragEnd = React.useCallback(
		(event: DragEndEvent) => {
			setActiveDragItem(null);
			if (movePendingRef.current || !event.over || !onMoveMedia) return;
			const dragData = event.active.data.current;
			const targetData = event.over.data.current;
			if (!isMediaDragData(dragData) || !isFolderTargetData(targetData)) return;
			if (dragData.item.folderId === targetData.folder.id) return;
			if (canMoveMedia?.(dragData.item) !== true) return;
			movePendingRef.current = true;
			moveMutation.mutate({ item: dragData.item, folder: targetData.folder });
		},
		[canMoveMedia, moveMutation, onMoveMedia],
	);
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
	const openCreateFolder = (event: React.MouseEvent<HTMLButtonElement>) => {
		folderDialogReturnFocusRef.current = event.currentTarget;
		setEditingFolder(null);
		setFolderDialogOpen(true);
	};
	const openEditFolder = (folder: MediaFolder, trigger: HTMLElement) => {
		folderDialogReturnFocusRef.current = trigger;
		setEditingFolder(folder);
		setFolderDialogOpen(true);
	};
	const closeFolderDialog = () => {
		setFolderDialogOpen(false);
		const returnTarget = folderDialogReturnFocusRef.current;
		folderDialogReturnFocusRef.current = null;
		window.requestAnimationFrame(() => {
			(returnTarget?.isConnected ? returnTarget : mediaHeadingRef.current)?.focus({
				preventScroll: true,
			});
		});
	};
	const focusMediaHeading = () => mediaHeadingRef.current?.focus({ preventScroll: true });
	const rememberScrollPosition = () => {
		pendingMediaLibraryScrollTop = mediaHeadingRef.current?.closest("main")?.scrollTop ?? null;
	};
	const backToMain = () => {
		rememberScrollPosition();
		focusMediaHeading();
		onBackToMain?.();
	};
	const openFolder = (folder: MediaFolder) => {
		setSearchQuery("");
		onLocalSearchChange?.("");
		cancelPendingDetailOpen();
		setIsDetailOpen(false);
		setDetailItem(null);
		rememberScrollPosition();
		focusMediaHeading();
		onOpenFolder?.(folder);
	};
	const uploadActionLabel =
		activeProvider === "local"
			? t`Upload Files`
			: t`Upload to ${activeProviderInfo?.name || t`Library`}`;

	return React.createElement(
		DndContext,
		{
			sensors,
			collisionDetection,
			accessibility: {
				announcements: {
					onDragStart: () => "",
					onDragOver: () => "",
					onDragEnd: () => "",
					onDragCancel: () => "",
				},
				restoreFocus: false,
				screenReaderInstructions: { draggable: "" },
			},
			onDragStart: handleMediaDragStart,
			onDragEnd: handleMediaDragEnd,
			onDragCancel: handleMediaDragCancel,
		},
		<div
			className="space-y-4"
			data-media-library
			aria-busy={currentLoading || moveMutation.isPending || undefined}
			onClickCapture={handleRootClickCapture}
		>
			<Toasty toastManager={toastManager}>{null}</Toasty>
			{isFileDragActive && canUploadHere && (
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
			{/* Header: page title (start) + primary actions (end) */}
			<div className="flex items-center justify-between gap-2 sm:gap-4">
				<div className="min-w-0">
					{activeProvider === "local" && folderId && (
						<RouterLinkButton
							to="/media"
							search={{ folder: undefined }}
							variant="ghost"
							size="sm"
							icon={<ArrowLeft className="rtl:-scale-x-100" aria-hidden="true" />}
							className="mb-2"
							onClick={(event) =>
								handleNavigationClick(event, onBackToMain ? backToMain : undefined)
							}
						>
							{t`Back`}
						</RouterLinkButton>
					)}
					<h1
						ref={mediaHeadingRef}
						tabIndex={-1}
						className="text-lg font-semibold leading-tight min-[360px]:text-xl sm:text-2xl"
					>
						{t`Media Library`}
					</h1>
					{activeProvider === "local" && folderId && (
						<nav aria-label={t`Folders navigation`} className="mt-2">
							<Breadcrumbs size="sm">
								<RouterLinkButton
									to="/media"
									search={{ folder: undefined }}
									variant="ghost"
									size="sm"
									className="h-auto px-0 py-0 text-sm"
									onClick={(event) =>
										handleNavigationClick(event, onBackToMain ? backToMain : undefined)
									}
								>
									{t`Media Library`}
								</RouterLinkButton>
								<Breadcrumbs.Separator />
								<Breadcrumbs.Current loading={currentFolderLoading}>
									<span dir="auto" className="inline-block max-w-full truncate align-bottom">
										{currentFolder?.name ?? ""}
									</span>
								</Breadcrumbs.Current>
							</Breadcrumbs>
						</nav>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
					{activeProvider === "local" && !folderId && folderActionsAvailable && (
						<Button
							variant="secondary"
							size="base"
							icon={<Plus className="hidden sm:block" aria-hidden="true" />}
							aria-label={t`Add new folder`}
							onClick={openCreateFolder}
							className="shrink-0"
						>
							<span className="sm:hidden">{t`New folder`}</span>
							<span className="hidden sm:inline">{t`Add new folder`}</span>
						</Button>
					)}
					{canUploadHere && (
						<Button
							onClick={openUploadDialog}
							size="base"
							icon={<Upload className="hidden sm:block" aria-hidden="true" />}
							aria-label={uploadActionLabel}
							className="shrink-0"
						>
							<span className="sm:hidden">{t`Upload`}</span>
							<span className="hidden sm:inline">{uploadActionLabel}</span>
						</Button>
					)}
				</div>
			</div>
			{activeProvider === "local" && setupIncomplete ? (
				<Banner
					variant="alert"
					title={
						setupStatus.state === "expanded"
							? t`Set up media usage tracking`
							: progressQuery.isError || setupProgress?.status === "needs_attention"
								? t`Media usage tracking needs attention`
								: setupStatus.state === "active"
									? t`Media usage tracking is indexing existing content`
									: t`Media usage tracking is setting up`
					}
					description={t`Index existing content and keep Used in results up to date.`}
					action={
						<RouterLinkButton to="/settings/media-usage" size="sm" variant="secondary">
							{setupStatus.state === "expanded" ? t`Open setup` : t`View setup`}
						</RouterLinkButton>
					}
				/>
			) : null}

			{/* Provider tabs (only when an external provider is configured) */}
			{providerTabs.length > 1 && (
				<Tabs
					variant="underline"
					value={activeProvider}
					onValueChange={(v) => {
						if (!v) return;
						cancelPendingDetailOpen();
						setActiveProvider(v);
						onActiveProviderChange?.(v);
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

			{/* Toolbar: search + type filter (start) · view toggle (end).
			    Local library search/filter is handled server-side. */}
			{showToolbar && (
				<TableToolbar
					className="flex-row flex-nowrap gap-2"
					trailing={
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
					}
				>
					{(canSearch || activeProvider === "local") && (
						<TableToolbarSearch
							size="base"
							placeholder={activeProvider === "local" ? t`Search by filename...` : t`Search...`}
							aria-label={t`Search media`}
							value={searchQuery}
							onChange={handleSearchChange}
							maxLength={MEDIA_SEARCH_MAX_LENGTH}
							className="w-auto flex-1 sm:w-72"
						/>
					)}
					{activeProvider === "local" && (
						<Select
							size="base"
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
				</TableToolbar>
			)}

			{activeProvider === "local" && (
				<span aria-live="polite" aria-atomic="true" className="sr-only">
					{!hasFolderSurface || foldersError
						? ""
						: foldersLoading || isLoadingMoreFolders
							? t`Loading folders`
							: plural(visibleFolders.length, {
									one: "# folder loaded",
									other: "# folders loaded",
								})}
				</span>
			)}

			{hasFolderSurface && viewMode === "grid" && (
				<section
					aria-labelledby="media-folders-heading"
					aria-busy={Boolean(foldersLoading || isLoadingMoreFolders) || undefined}
					className="space-y-3"
				>
					<div className="flex items-center justify-between gap-3">
						<h2 id="media-folders-heading" className="text-lg font-semibold">
							{t`Folders`}
						</h2>
						{foldersError && onRetryFolders && (
							<Button variant="outline" size="sm" onClick={onRetryFolders}>
								{t`Retry`}
							</Button>
						)}
					</div>
					{foldersError && (
						<div role="alert" className="rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
							{t`Folders could not be loaded.`}
						</div>
					)}
					{foldersLoading && visibleFolders.length === 0 ? (
						<div className="flex justify-center py-6">
							<Loader />
						</div>
					) : (
						<Grid variant="4up" gap="sm" className="2xl:grid-cols-6">
							{visibleFolders.map((folder) => (
								<MediaFolderCard
									key={folder.id}
									folder={folder}
									canEdit={folderActionsAvailable}
									canDrop={dragDropAvailable && !moveMutation.isPending}
									activeDragItem={activeDragItem}
									onOpen={onOpenFolder ? () => openFolder(folder) : undefined}
									onEdit={(trigger) => openEditFolder(folder, trigger)}
								/>
							))}
						</Grid>
					)}
					{hasMoreFolders && onLoadMoreFolders && (
						<div className="flex justify-center">
							<Button
								variant="outline"
								onClick={onLoadMoreFolders}
								disabled={isLoadingMoreFolders}
								loading={isLoadingMoreFolders}
							>
								{t`Load more folders`}
							</Button>
						</div>
					)}
					{visibleFolders.length > 0 && currentItems.length > 0 && (
						<div className="border-t border-kumo-line" />
					)}
				</section>
			)}

			{/* Content */}
			{currentLoading && currentItems.length === 0 && currentProviderItems.length === 0 ? (
				<div className="flex items-center justify-center py-12">
					<Loader />
				</div>
			) : activeProvider === "local" && currentItems.length === 0 && !folderResultsMayFillView ? (
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
				) : folderId ? (
					<MediaEmptyState
						hero={Folder}
						title={t`This folder is empty`}
						description={t`Move media here from Media Details.`}
						action={
							<Button variant="outline" onClick={backToMain}>
								{t`Back to Main library`}
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
				<Grid
					variant="4up"
					gap="sm"
					className="2xl:grid-cols-6"
					data-media-grid
					inert={currentLoading || undefined}
				>
					{activeProvider === "local"
						? currentItems.map((item) => (
								<MediaGridItem
									key={item.id}
									item={item}
									selected={detailItem?.id === item.id}
									draggable={
										dragDropAvailable &&
										!moveMutation.isPending &&
										isLocalMediaItem(item) &&
										canMoveMedia?.(item) === true
									}
									isMoving={moveMutation.isPending && moveMutation.variables?.item.id === item.id}
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
				</Grid>
			) : (
				<div
					inert={currentLoading || undefined}
					className="rounded-md border bg-kumo-base overflow-x-auto"
				>
					<table
						className="w-full"
						aria-busy={
							(showFolderResults && Boolean(foldersLoading || isLoadingMoreFolders)) || undefined
						}
					>
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
							{showFolderResults && foldersLoading && visibleFolders.length === 0 && (
								<tr>
									<td colSpan={5} className="px-4 py-6">
										<div className="flex items-center justify-center gap-2 text-sm text-kumo-subtle">
											<Loader />
											<span>{t`Loading folders`}</span>
										</div>
									</td>
								</tr>
							)}
							{showFolderResults && foldersError && visibleFolders.length === 0 && (
								<MediaFolderErrorRow onRetry={onRetryFolders} />
							)}
							{activeProvider === "local" &&
								visibleFolders.map((folder) => (
									<MediaFolderListItem
										key={folder.id}
										folder={folder}
										canEdit={folderActionsAvailable}
										canDrop={dragDropAvailable && !moveMutation.isPending}
										activeDragItem={activeDragItem}
										onOpen={onOpenFolder ? () => openFolder(folder) : undefined}
										onEdit={(trigger) => openEditFolder(folder, trigger)}
									/>
								))}
							{showFolderResults && foldersError && visibleFolders.length > 0 && (
								<MediaFolderErrorRow onRetry={onRetryFolders} />
							)}
							{showFolderResults && hasMoreFolders && onLoadMoreFolders && (
								<tr>
									<td colSpan={5} className="px-4 py-3 text-center">
										<Button
											variant="outline"
											onClick={onLoadMoreFolders}
											disabled={isLoadingMoreFolders}
											loading={isLoadingMoreFolders}
										>
											{t`Load more folders`}
										</Button>
									</td>
								</tr>
							)}
							{activeProvider === "local"
								? currentItems.map((item) => (
										<MediaListItem
											key={item.id}
											item={item}
											selected={detailItem?.id === item.id}
											draggable={
												dragDropAvailable &&
												!moveMutation.isPending &&
												isLocalMediaItem(item) &&
												canMoveMedia?.(item) === true
											}
											isMoving={
												moveMutation.isPending && moveMutation.variables?.item.id === item.id
											}
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

			{activeProvider === "local" && pagination && pagination.totalCount > 0 && (
				<div ref={paginationRootRef} className="min-w-0">
					<Pagination
						page={pagination.page}
						setPage={requestPage}
						perPage={pagination.perPage}
						totalCount={pagination.totalCount}
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
							{({ pageShowingRange, totalCount }) => (
								<span role="status">{t`Showing ${pageShowingRange} of ${totalCount ?? 0}`}</span>
							)}
						</Pagination.Info>
						<Pagination.Separator className="hidden sm:block" />
						<div inert={pagination.isPending || undefined} className="contents">
							<Pagination.PageSize
								value={pagination.perPage}
								onChange={requestPageSize}
								options={MEDIA_PAGE_SIZE_OPTIONS}
								label={t`Per page`}
							/>
							<Pagination.Controls
								pageSelector={
									Math.ceil(pagination.totalCount / pagination.perPage) <= MAX_DROPDOWN_PAGE_COUNT
										? "dropdown"
										: "input"
								}
								className="basis-full sm:basis-auto rtl:[&_svg]:-scale-x-100"
							/>
						</div>
					</Pagination>
				</div>
			)}

			{activeProvider === "local" && !pagination && hasMore && onLoadMore && (
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
					canMoveLocation={isLocalMediaItem(detailItem) ? canMoveMedia?.(detailItem) : undefined}
					canCropOriginal={Boolean(
						isLocalMediaItem(detailItem) &&
						currentUser &&
						(currentUser.role >= 40 ||
							(currentUser.role >= 30 && detailItem.authorId === currentUser.id)),
					)}
					canDuplicateCrop={Boolean(isLocalMediaItem(detailItem) && (currentUser?.role ?? 0) >= 20)}
					restoreFocusTargetRef={mediaHeadingRef}
					onClose={closeDetail}
					onClosed={handleDetailClosed}
					onUpdated={onItemUpdated}
					onItemRefreshed={handleDetailItemRefreshed}
					onCroppedCopyCreated={() => {
						toastManager.add({
							title: t`Cropped copy created.`,
							variant: "success",
							timeout: 3000,
						});
					}}
					onDeleted={detailItem.provider ? undefined : onItemUpdated}
				/>
			)}

			{folderActionsAvailable && onCreateFolder && onRenameFolder && onDeleteFolder && (
				<MediaFolderDialog
					open={folderDialogOpen}
					folder={editingFolder}
					onClose={closeFolderDialog}
					onCreate={onCreateFolder}
					onRename={onRenameFolder}
					onDelete={onDeleteFolder}
				/>
			)}
		</div>,
		<DragOverlay dropAnimation={null} modifiers={MEDIA_DRAG_OVERLAY_MODIFIERS}>
			{activeDragItem ? <MediaDragOverlay item={activeDragItem} /> : null}
		</DragOverlay>,
	);
}

function MediaFolderCard({
	folder,
	canEdit,
	canDrop,
	activeDragItem,
	onOpen,
	onEdit,
}: {
	folder: MediaFolder;
	canEdit: boolean;
	canDrop: boolean;
	activeDragItem: LocalMediaItem | null;
	onOpen?: () => void;
	onEdit: (trigger: HTMLElement) => void;
}) {
	const { t } = useLingui();
	const { setNodeRef, isOver } = useDroppable({
		id: folderDropId(folder.id),
		data: { kind: "media-folder-target", folder } satisfies MediaFolderTargetData,
		disabled: !canDrop,
	});
	const isValidTarget = isOver && activeDragItem?.folderId !== folder.id;
	return (
		<LayerCard
			ref={setNodeRef}
			className={cn(
				"group isolate flex min-w-0 items-center gap-3 p-3 hover:bg-kumo-tint focus-within:bg-kumo-tint",
				isValidTarget &&
					"bg-kumo-tint outline-2 outline-dashed outline-offset-2 outline-kumo-brand",
			)}
			data-media-folder-card
			data-media-folder-drop-target={canDrop || undefined}
			data-drop-active={isValidTarget || undefined}
		>
			<RouterLinkButton
				to="/media"
				search={{ folder: folder.id }}
				variant="ghost"
				className="relative z-0 h-auto min-h-10 min-w-0 flex-1 justify-start gap-3 p-0 text-start hover:bg-transparent"
				aria-label={t`Open folder ${folder.name}`}
				onClick={(event) => handleNavigationClick(event, onOpen)}
			>
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-kumo-tint text-emdash-media-folder">
					<Folder className="h-5 w-5" weight="fill" aria-hidden="true" />
				</div>
				<span dir="auto" className="min-w-0 truncate font-semibold">
					{folder.name}
				</span>
			</RouterLinkButton>
			{canEdit && (
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					className="relative z-10 shrink-0 opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
					aria-label={t`Edit folder ${folder.name}`}
					onClick={(event) => onEdit(event.currentTarget)}
				>
					<PencilSimple className="h-4 w-4" aria-hidden="true" />
				</Button>
			)}
		</LayerCard>
	);
}

function MediaFolderListItem({
	folder,
	canEdit,
	canDrop,
	activeDragItem,
	onOpen,
	onEdit,
}: {
	folder: MediaFolder;
	canEdit: boolean;
	canDrop: boolean;
	activeDragItem: LocalMediaItem | null;
	onOpen?: () => void;
	onEdit: (trigger: HTMLElement) => void;
}) {
	const { t } = useLingui();
	const { setNodeRef, isOver } = useDroppable({
		id: folderDropId(folder.id),
		data: { kind: "media-folder-target", folder } satisfies MediaFolderTargetData,
		disabled: !canDrop,
	});
	const isValidTarget = isOver && activeDragItem?.folderId !== folder.id;
	return (
		<tr
			ref={setNodeRef}
			className={cn(
				"hover:bg-kumo-tint/25",
				isValidTarget &&
					"bg-kumo-tint outline-2 outline-dashed -outline-offset-2 outline-kumo-brand",
			)}
			data-media-folder-drop-target={canDrop || undefined}
			data-drop-active={isValidTarget || undefined}
		>
			<td className="px-4 py-3">
				<div className="flex h-10 w-10 items-center justify-center rounded bg-kumo-tint text-emdash-media-folder">
					<Folder className="h-5 w-5" weight="fill" aria-hidden="true" />
				</div>
			</td>
			<td className="px-4 py-3">
				<div className="flex items-center justify-start gap-2">
					<RouterLinkButton
						to="/media"
						search={{ folder: folder.id }}
						variant="ghost"
						className="max-w-64 min-w-0 justify-start px-0"
						aria-label={t`Open folder ${folder.name}`}
						onClick={(event) => handleNavigationClick(event, onOpen)}
					>
						<span dir="auto" className="truncate">
							{folder.name}
						</span>
					</RouterLinkButton>
					{canEdit && (
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							aria-label={t`Edit folder ${folder.name}`}
							onClick={(event) => onEdit(event.currentTarget)}
						>
							<PencilSimple className="h-4 w-4" aria-hidden="true" />
						</Button>
					)}
				</div>
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">
				<span aria-hidden="true">—</span>
				<span className="sr-only">{t`Type: Folder`}</span>
			</td>
			<td className="px-4 py-3 text-sm text-kumo-subtle">
				<span aria-hidden="true">—</span>
				<span className="sr-only">{t`Size is not applicable to folders`}</span>
			</td>
			<td className="px-4 py-3 text-end text-sm text-kumo-subtle">
				<span aria-hidden="true">—</span>
				<span className="sr-only">{t`Alt text is not applicable to folders`}</span>
			</td>
		</tr>
	);
}

function MediaFolderErrorRow({ onRetry }: { onRetry?: () => void }) {
	const { t } = useLingui();
	return (
		<tr>
			<td colSpan={5} className="px-4 py-3">
				<div className="flex flex-wrap items-center justify-start gap-3 rounded-md bg-kumo-danger/10 p-3 text-sm text-kumo-danger">
					<span role="alert">{t`Folders could not be loaded.`}</span>
					{onRetry && (
						<Button variant="outline" size="sm" onClick={onRetry}>
							{t`Retry`}
						</Button>
					)}
				</div>
			</td>
		</tr>
	);
}

function handleNavigationClick(
	event: React.MouseEvent<HTMLAnchorElement>,
	navigate: (() => void) | undefined,
) {
	if (
		!navigate ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	)
		return;
	event.preventDefault();
	navigate();
}

function isLocalMediaItem(item: MediaItem): item is LocalMediaItem {
	return (
		!item.provider &&
		"folderId" in item &&
		"authorId" in item &&
		typeof item.storageKey === "string"
	);
}

function formatFileFormat(mimeType: string): string {
	return (mimeType.split("/").at(-1)?.split("+")[0] || mimeType).toUpperCase();
}

function MediaDragOverlay({ item }: { item: LocalMediaItem }) {
	return (
		<div aria-hidden="true" className="max-w-[calc(100vw-2rem)]" data-media-drag-overlay>
			<LayerCard className="flex max-w-96 cursor-grabbing items-center gap-2 px-3 py-2 ring-2 ring-kumo-brand">
				<FileIcon className="h-5 w-5 shrink-0 text-kumo-subtle" aria-hidden="true" />
				<span dir="auto" className="min-w-0 truncate text-sm font-semibold">
					{item.filename}
				</span>
			</LayerCard>
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
	draggable?: boolean;
	isMoving?: boolean;
	onClick?: () => void;
}

function MediaGridItem({ item, selected, draggable, isMoving, onClick }: MediaGridItemProps) {
	const isImage = item.mimeType.startsWith("image/");
	const localItem = isLocalMediaItem(item) ? item : null;
	const previewUrl = getMediaPreviewUrl(item.url, item.contentHash);
	const { setNodeRef, listeners, isDragging } = useDraggable({
		id: mediaDragId(item.id),
		data: localItem
			? ({ kind: "local-media", item: localItem } satisfies MediaDragData)
			: undefined,
		disabled: !draggable || !localItem,
	});

	return (
		<LayerCard
			ref={setNodeRef}
			{...listeners}
			render={<button type="button" />}
			onClick={onClick}
			aria-label={item.filename}
			aria-busy={isMoving || undefined}
			data-media-draggable={draggable || undefined}
			className={cn(
				"group w-full min-w-0 text-start transition-opacity focus-visible:ring-2 focus-visible:ring-kumo-brand",
				selected ? "ring-2 ring-kumo-brand" : "hover:ring-kumo-brand/50",
				draggable && "cursor-grab touch-manipulation active:cursor-grabbing",
				(isDragging || isMoving) && "opacity-40",
			)}
		>
			<LayerCard.Primary className="aspect-video p-0">
				{isImage ? (
					<img
						src={getMediaThumbnailUrl(
							item.url,
							item.mimeType,
							MEDIA_THUMBNAIL_WIDTH,
							item.contentHash,
						)}
						alt={item.alt || item.filename}
						draggable={false}
						className="emdash-media-transparency-grid h-full w-full object-cover"
						style={{ objectPosition: getMediaObjectPosition(item) }}
						onError={(e) => fallbackToOriginalThumbnail(e.currentTarget, previewUrl)}
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
						<span className="text-4xl">{getFileIcon(item.mimeType)}</span>
					</div>
				)}
			</LayerCard.Primary>
			<LayerCard.Secondary className="my-0 min-w-0 justify-between px-3 py-2.5 text-sm text-kumo-default">
				<span
					dir="auto"
					title={item.filename}
					className="min-w-0 flex-1 truncate font-medium leading-5"
				>
					{item.filename}
				</span>
				<Badge variant="secondary" className="h-5 min-w-11 justify-center rounded-md px-2 py-0">
					<span className="text-[11px] leading-none text-kumo-default/75">
						{formatFileFormat(item.mimeType)}
					</span>
				</Badge>
			</LayerCard.Secondary>
		</LayerCard>
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
		<LayerCard
			render={<button type="button" />}
			onClick={onClick}
			aria-label={item.filename}
			className={cn(
				"group w-full min-w-0 text-start focus-visible:ring-2 focus-visible:ring-kumo-brand",
				selected ? "ring-2 ring-kumo-brand" : "hover:ring-kumo-brand/50",
			)}
		>
			<LayerCard.Primary className="aspect-[4/3] p-0">
				{item.previewUrl ? (
					<img
						src={item.previewUrl}
						alt={item.alt || item.filename}
						className="emdash-media-transparency-grid h-full w-full object-cover"
						onLoad={handleImageLoad}
					/>
				) : (
					<div className="flex h-full w-full items-center justify-center bg-kumo-tint">
						<span className="text-4xl">{getFileIcon(item.mimeType)}</span>
					</div>
				)}
			</LayerCard.Primary>
			<LayerCard.Secondary className="my-0 min-w-0 justify-between px-3 py-2.5 text-sm text-kumo-default">
				<span
					dir="auto"
					title={item.filename}
					className="min-w-0 flex-1 truncate font-medium leading-5"
				>
					{item.filename}
				</span>
				<Badge variant="secondary" className="h-5 min-w-11 justify-center rounded-md px-2 py-0">
					<span className="text-[11px] leading-none text-kumo-default/75">
						{formatFileFormat(item.mimeType)}
					</span>
				</Badge>
			</LayerCard.Secondary>
		</LayerCard>
	);
}

interface MediaListItemProps {
	item: MediaItem;
	selected?: boolean;
	draggable?: boolean;
	isMoving?: boolean;
	onClick?: () => void;
}

function MediaListItem({ item, selected, draggable, isMoving, onClick }: MediaListItemProps) {
	const { t } = useLingui();
	const isImage = item.mimeType.startsWith("image/");
	const localItem = isLocalMediaItem(item) ? item : null;
	const previewUrl = getMediaPreviewUrl(item.url, item.contentHash);
	const { setNodeRef, listeners, isDragging } = useDraggable({
		id: mediaDragId(item.id),
		data: localItem
			? ({ kind: "local-media", item: localItem } satisfies MediaDragData)
			: undefined,
		disabled: !draggable || !localItem,
	});

	return (
		<tr
			ref={setNodeRef}
			{...listeners}
			aria-busy={isMoving || undefined}
			data-media-draggable={draggable || undefined}
			className={cn(
				"cursor-pointer",
				selected ? "bg-kumo-brand/10" : "hover:bg-kumo-tint/25",
				draggable && "cursor-grab touch-manipulation active:cursor-grabbing",
				(isDragging || isMoving) && "opacity-40",
			)}
			onClick={onClick}
		>
			<td className="px-4 py-3">
				<div className="h-10 w-10 overflow-hidden rounded">
					{isImage ? (
						<img
							src={getMediaThumbnailUrl(item.url, item.mimeType, 80, item.contentHash)}
							alt={item.alt || item.filename}
							draggable={false}
							className="emdash-media-transparency-grid h-full w-full object-cover"
							style={{ objectPosition: getMediaObjectPosition(item) }}
							onError={(e) => fallbackToOriginalThumbnail(e.currentTarget, previewUrl)}
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
							className="emdash-media-transparency-grid h-full w-full object-cover"
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
