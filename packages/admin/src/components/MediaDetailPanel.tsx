/**
 * Media Detail Dialog
 *
 * A centered dialog for viewing and editing media item metadata.
 * Opens when clicking an item in the MediaLibrary.
 */

import {
	Banner,
	Button,
	ClipboardText,
	Combobox,
	Dialog,
	Input,
	InputArea,
	Select,
	Tabs,
	Tooltip,
	inputVariants,
} from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowCounterClockwise,
	X,
	Trash,
	Calendar,
	CaretDown,
	File,
	Folder,
	HardDrive,
	ImagesSquare,
	LinkSimple,
	Ruler,
	Info,
	WarningCircle,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { flushSync } from "react-dom";

import {
	ApiResponseError,
	updateMedia,
	replaceMediaImage,
	uploadMedia,
	deleteMedia,
	deleteFromProvider,
	fetchMediaFolder,
	fetchMediaFolders,
	fetchMediaItem,
	type LocalMediaItem,
	type MediaFolder,
	type MediaItem,
	type MediaUpdateInput,
	type MediaUsageEntryDetail,
} from "../lib/api";
import {
	createCroppedFilename,
	createCroppedImageFile,
	type CropAspectMode,
	type PixelCrop,
} from "../lib/crop-image.js";
import { useDebouncedValue, useStableCallback } from "../lib/hooks";
import {
	getFileIcon,
	formatFileSize,
	getMediaPreviewUrl,
	metaPlayback,
	normalizeMediaFocalPoint,
	type MediaFocalPoint,
} from "../lib/media-utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogError, getMutationError } from "./DialogError.js";
import { FocalPointEditor, FocalPointPreviews } from "./FocalPointEditor.js";
import { MediaImageCropper, type MediaCropSelection } from "./MediaImageCropper.js";
import { MediaUsedIn } from "./MediaUsedIn.js";

const CLOSE_FALLBACK_MS = 500;
const DIALOG_RESIZE_DURATION_MS = 340;
const DIALOG_RESIZE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
type MediaDetailTab = "details" | "used-in" | "edit-image";
type ImageEditMode = "focal-point" | "crop";
type CropAction = "duplicate" | "replace";

interface CropViewportSize {
	width: number;
	height: number;
}

class CropFileCreationError extends Error {}

let cropPreviewFallbackId = 0;

function createCropPreviewKey(): string {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${(cropPreviewFallbackId += 1)}`;
}

function cacheBustMediaUrl(url: string, key: string): string {
	const result = new URL(url, window.location.origin);
	if (result.protocol !== "http:" && result.protocol !== "https:") {
		result.hash = `_emdash_crop=${encodeURIComponent(key)}`;
		return result.href;
	}
	result.searchParams.set("_emdash_crop", key);
	return result.href;
}

function normalizeCropMime(mimeType: string): string {
	const normalized = mimeType.split(";")[0]!.trim().toLowerCase();
	return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function isCropAspectMode(value: string | null): value is CropAspectMode {
	return ["original", "freeform", "square", "4:3", "3:2", "16:9"].includes(value ?? "");
}

function cropAspectRatio(mode: CropAspectMode, source: CropViewportSize | null): number {
	switch (mode) {
		case "square":
			return 1;
		case "4:3":
			return 4 / 3;
		case "3:2":
			return 3 / 2;
		case "16:9":
			return 16 / 9;
		default:
			return source && source.width > 0 && source.height > 0 ? source.width / source.height : 1;
	}
}

interface MediaLocationOption {
	id: string | null;
	name: string;
}

export interface MediaDetailPanelProps {
	open: boolean;
	item: MediaItem;
	providerName?: string;
	canDelete?: boolean;
	canMoveLocation?: boolean;
	canCropOriginal?: boolean;
	canDuplicateCrop?: boolean;
	restoreFocusTargetRef?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
	onClosed?: () => void;
	onUpdated?: () => void;
	onItemRefreshed?: (item: LocalMediaItem) => void;
	onCroppedCopyCreated?: () => void;
	onDeleted?: () => void;
}

/**
 * Centered dialog for viewing and editing media metadata.
 */
export function MediaDetailPanel({
	open,
	item,
	providerName,
	canDelete: canDeleteProp,
	canMoveLocation: canMoveLocationProp,
	canCropOriginal = false,
	canDuplicateCrop = false,
	restoreFocusTargetRef,
	onClose,
	onClosed,
	onUpdated,
	onItemRefreshed,
	onCroppedCopyCreated,
	onDeleted,
}: MediaDetailPanelProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const restoreFocusAfterDeleteRef = React.useRef(false);
	const savePendingRef = React.useRef(false);
	const closeFallbackTimerRef = React.useRef<number | null>(null);
	const closeFinishedRef = React.useRef(false);
	const cropPendingRef = React.useRef(false);
	const cropImageRef = React.useRef<HTMLImageElement | null>(null);
	const dialogBodyRef = React.useRef<HTMLDivElement | null>(null);
	const dialogResizeAnimationRef = React.useRef<Animation | null>(null);
	const imageModeOverflowFrameRef = React.useRef<number | null>(null);
	const focalEditorFrameRef = React.useRef<HTMLDivElement | null>(null);
	const focalPreviewFrameRef = React.useRef<HTMLDivElement | null>(null);
	const focalPreviewSectionRef = React.useRef<HTMLElement | null>(null);

	const isProviderAsset = Boolean(item.provider);
	const isImage = item.mimeType.startsWith("image/");
	const isVideo = item.mimeType.startsWith("video/");
	const isAudio = item.mimeType.startsWith("audio/");
	// Present when the item streams rather than resolving to a playable file.
	const playback = metaPlayback(item.meta);
	const canEditMetadata = !isProviderAsset && isImage;
	const hasUsage = !isProviderAsset;
	const canDelete = !isProviderAsset || Boolean(canDeleteProp);
	const localItem = isLocalMediaItem(item) ? item : null;
	const canMoveLocation = Boolean(localItem && canMoveLocationProp);
	const cropMime = normalizeCropMime(item.mimeType);
	const canShowCrop = Boolean(
		localItem &&
		item.status === "ready" &&
		["image/jpeg", "image/png", "image/webp"].includes(cropMime) &&
		(canCropOriginal || canDuplicateCrop),
	);

	const [filename, setFilename] = React.useState(item.filename);
	const [alt, setAlt] = React.useState(item.alt ?? "");
	const [caption, setCaption] = React.useState(item.caption ?? "");
	const [folderId, setFolderId] = React.useState<string | null>(localItem?.folderId ?? null);
	const [selectedFolder, setSelectedFolder] = React.useState<MediaFolder | null>(null);
	const [locationOpen, setLocationOpen] = React.useState(false);
	const [locationSearch, setLocationSearch] = React.useState("");
	const [focalPoint, setFocalPoint] = React.useState<MediaFocalPoint | null>(() =>
		normalizeMediaFocalPoint(item),
	);
	const [focalPreviewOffset, setFocalPreviewOffset] = React.useState(0);
	const [activeTab, setActiveTab] = React.useState<MediaDetailTab>("details");
	const [imageEditMode, setImageEditMode] = React.useState<ImageEditMode>(
		canShowCrop ? "crop" : "focal-point",
	);
	const [suppressImageModeOverflow, setSuppressImageModeOverflow] = React.useState(false);
	const [suppressDialogResizeOverflow, setSuppressDialogResizeOverflow] = React.useState(false);
	const [cropAspectMode, setCropAspectMode] = React.useState<CropAspectMode>("original");
	const [cropSelection, setCropSelection] = React.useState<MediaCropSelection>();
	const [cropPixels, setCropPixels] = React.useState<PixelCrop | null>(null);
	const [cropSourceSize, setCropSourceSize] = React.useState<{
		width: number;
		height: number;
	} | null>(null);
	const [cropSourceFailed, setCropSourceFailed] = React.useState(false);
	const [cropPreviewKey, setCropPreviewKey] = React.useState(createCropPreviewKey);
	const [cropStatus, setCropStatus] = React.useState("");
	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
	const [showDiscardConfirm, setShowDiscardConfirm] = React.useState(false);
	const [showCropConfirm, setShowCropConfirm] = React.useState(false);
	const [pendingUsageEntry, setPendingUsageEntry] = React.useState<MediaUsageEntryDetail | null>(
		null,
	);
	const focalPointDescriptionId = React.useId();

	React.useEffect(() => {
		if (!open) return;
		if (closeFallbackTimerRef.current !== null) {
			window.clearTimeout(closeFallbackTimerRef.current);
			closeFallbackTimerRef.current = null;
		}
		closeFinishedRef.current = false;
		restoreFocusAfterDeleteRef.current = false;
		savePendingRef.current = false;
		cropPendingRef.current = false;
		cropImageRef.current = null;
		if (imageModeOverflowFrameRef.current !== null) {
			window.cancelAnimationFrame(imageModeOverflowFrameRef.current);
			imageModeOverflowFrameRef.current = null;
		}
		setSuppressImageModeOverflow(false);
		setSuppressDialogResizeOverflow(false);
		setFilename(item.filename);
		setAlt(item.alt ?? "");
		setCaption(item.caption ?? "");
		setFolderId(localItem?.folderId ?? null);
		setSelectedFolder(null);
		setLocationOpen(false);
		setLocationSearch("");
		setFocalPoint(normalizeMediaFocalPoint(item));
		setFocalPreviewOffset(0);
		setActiveTab("details");
		setImageEditMode(canShowCrop ? "crop" : "focal-point");
		setCropAspectMode("original");
		setCropSelection(undefined);
		setCropPixels(null);
		setCropSourceSize(null);
		setCropSourceFailed(false);
		setCropPreviewKey(createCropPreviewKey());
		setCropStatus("");
		setShowDeleteConfirm(false);
		setShowDiscardConfirm(false);
		setShowCropConfirm(false);
		setPendingUsageEntry(null);
	}, [item.id, localItem?.folderId, open]);

	React.useLayoutEffect(() => {
		if (!open || activeTab !== "edit-image" || imageEditMode !== "focal-point") return;
		const editorFrame = focalEditorFrameRef.current;
		const previewFrame = focalPreviewFrameRef.current;
		const previewSection = focalPreviewSectionRef.current;
		if (!editorFrame || !previewFrame || !previewSection) return;

		const desktop = window.matchMedia("(min-width: 48rem)");
		let alignmentFrame = 0;
		let resizeAnimation: Animation | null = null;
		const updateOffset = () => {
			if (!desktop.matches) {
				setFocalPreviewOffset(0);
				return;
			}
			const delta =
				editorFrame.getBoundingClientRect().bottom - previewFrame.getBoundingClientRect().bottom;
			if (Math.abs(delta) < 0.5) return;
			const transform = getComputedStyle(previewSection).transform;
			const renderedOffset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
			setFocalPreviewOffset(Math.round(renderedOffset + delta));
		};
		const alignPreview = () => {
			window.cancelAnimationFrame(alignmentFrame);
			alignmentFrame = window.requestAnimationFrame(() => {
				if (dialogResizeAnimationRef.current) return;
				updateOffset();
			});
		};

		updateOffset();
		const animationListenerFrame = window.requestAnimationFrame(() => {
			resizeAnimation = dialogResizeAnimationRef.current;
			resizeAnimation?.addEventListener("finish", alignPreview, { once: true });
		});
		const observer = new ResizeObserver(alignPreview);
		observer.observe(editorFrame);
		observer.observe(previewFrame);
		desktop.addEventListener("change", alignPreview);
		window.addEventListener("resize", alignPreview);
		return () => {
			window.cancelAnimationFrame(alignmentFrame);
			window.cancelAnimationFrame(animationListenerFrame);
			resizeAnimation?.removeEventListener("finish", alignPreview);
			observer.disconnect();
			desktop.removeEventListener("change", alignPreview);
			window.removeEventListener("resize", alignPreview);
		};
	}, [activeTab, imageEditMode, open]);

	React.useEffect(() => {
		return () => {
			dialogResizeAnimationRef.current?.cancel();
			if (imageModeOverflowFrameRef.current !== null) {
				window.cancelAnimationFrame(imageModeOverflowFrameRef.current);
			}
			if (closeFallbackTimerRef.current !== null) {
				window.clearTimeout(closeFallbackTimerRef.current);
			}
		};
	}, []);

	const finishClose = React.useCallback(() => {
		if (closeFinishedRef.current) return;
		closeFinishedRef.current = true;
		if (closeFallbackTimerRef.current !== null) {
			window.clearTimeout(closeFallbackTimerRef.current);
			closeFallbackTimerRef.current = null;
		}
		const shouldRestoreFocus = restoreFocusAfterDeleteRef.current;
		restoreFocusAfterDeleteRef.current = false;
		onClosed?.();
		if (shouldRestoreFocus) {
			window.setTimeout(() => {
				restoreFocusTargetRef?.current?.focus({ preventScroll: true });
			}, 0);
		}
	}, [onClosed, restoreFocusTargetRef]);

	const closeDialog = React.useCallback(() => {
		onClose();
		if (closeFallbackTimerRef.current !== null) {
			window.clearTimeout(closeFallbackTimerRef.current);
		}
		closeFallbackTimerRef.current = window.setTimeout(finishClose, CLOSE_FALLBACK_MS);
	}, [finishClose, onClose]);

	const originalFocalPoint = normalizeMediaFocalPoint(item);
	const focalPointChanged =
		focalPoint?.focalX !== originalFocalPoint?.focalX ||
		focalPoint?.focalY !== originalFocalPoint?.focalY;
	const metadataChanged =
		canEditMetadata &&
		(alt !== (item.alt ?? "") || caption !== (item.caption ?? "") || focalPointChanged);
	const locationChanged = canMoveLocation && folderId !== localItem?.folderId;
	const canEdit = canEditMetadata || canMoveLocation;
	const hasTabs = canEditMetadata || hasUsage;
	const hasChanges = metadataChanged || locationChanged;
	const isConfirmOpen = showDeleteConfirm || showDiscardConfirm || showCropConfirm;
	const mediaPreviewUrl = localItem
		? getMediaPreviewUrl(item.url, item.contentHash ?? cropPreviewKey)
		: item.url;
	const cropPreviewUrl = canShowCrop
		? cacheBustMediaUrl(item.url, cropPreviewKey)
		: mediaPreviewUrl;
	const cropAspectSource =
		cropSourceSize ??
		(item.width && item.height ? { width: item.width, height: item.height } : null);
	const cropAspect = cropAspectRatio(cropAspectMode, cropAspectSource);
	const cropChanged = Boolean(
		cropPixels &&
		cropSourceSize &&
		(cropPixels.width < cropSourceSize.width || cropPixels.height < cropSourceSize.height),
	);
	const publicFileUrl =
		!isProviderAsset && item.url ? new URL(item.url, window.location.origin).href : "";
	const publicFilePath = publicFileUrl ? new URL(publicFileUrl).pathname : "";
	const filenameHelp = t`Filename cannot be changed after upload`;
	const filenameHelpLabel = t`Why can't this be changed?`;
	const altTextHelp = t`Used by screen readers and when image fails to load`;
	const altTextHelpLabel = t`Why is this important?`;
	const focalPointHelp = t`Move the focal point to choose what stays visible in cropped images.`;
	const focalPointHelpLabel = t`About focal point`;
	const cropAspectOptions = React.useMemo(
		() => ({
			original: t`Original`,
			freeform: t`Freeform`,
			square: t`Square (1:1)`,
			"4:3": t`4:3`,
			"3:2": t`3:2`,
			"16:9": t`16:9`,
		}),
		[t],
	);
	const debouncedLocationSearch = useDebouncedValue(locationSearch, 300);
	const currentFolderQuery = useQuery({
		queryKey: ["media-folder", localItem?.folderId],
		queryFn: () => fetchMediaFolder(localItem!.folderId!),
		enabled: open && Boolean(localItem?.folderId),
		retry: (failureCount, error) =>
			!(error instanceof ApiResponseError && error.code === "NOT_FOUND") && failureCount < 2,
	});
	const currentFolderMissing =
		currentFolderQuery.error instanceof ApiResponseError &&
		currentFolderQuery.error.code === "NOT_FOUND";
	const locationListQuery = useInfiniteQuery({
		queryKey: ["media-folders", "location", { search: debouncedLocationSearch.trim() }],
		queryFn: ({ pageParam }) =>
			fetchMediaFolders({
				limit: 100,
				cursor: pageParam,
				search: debouncedLocationSearch.trim() || undefined,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		enabled: open && canMoveLocation && locationOpen,
	});
	const locationFolders = React.useMemo(
		() => locationListQuery.data?.pages.flatMap((page) => page.items) ?? [],
		[locationListQuery.data?.pages],
	);
	const mainLocation = React.useMemo<MediaLocationOption>(
		() => ({ id: null, name: t`Main library` }),
		[t],
	);
	const locationOptions = React.useMemo<MediaLocationOption[]>(() => {
		const foldersById = new Map<string, MediaFolder>();
		for (const folder of locationFolders) foldersById.set(folder.id, folder);
		if (currentFolderQuery.data && !currentFolderMissing)
			foldersById.set(currentFolderQuery.data.id, currentFolderQuery.data);
		if (selectedFolder) foldersById.set(selectedFolder.id, selectedFolder);
		return [
			mainLocation,
			...[...foldersById.values()]
				.toSorted(
					(left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
				)
				.map((folder) => ({ id: folder.id, name: folder.name })),
		];
	}, [
		currentFolderMissing,
		currentFolderQuery.data,
		locationFolders,
		mainLocation,
		selectedFolder,
	]);
	const selectedLocation = React.useMemo<MediaLocationOption>(() => {
		if (folderId === null) return mainLocation;
		return (
			locationOptions.find((option) => option.id === folderId) ?? {
				id: folderId,
				name:
					currentFolderQuery.isLoading || currentFolderMissing
						? t`Loading...`
						: t`Location unavailable`,
			}
		);
	}, [
		currentFolderMissing,
		currentFolderQuery.isLoading,
		folderId,
		locationOptions,
		mainLocation,
		t,
	]);
	const currentLocationName =
		localItem?.folderId === null
			? mainLocation.name
			: currentFolderMissing
				? t`Loading...`
				: (currentFolderQuery.data?.name ??
					(currentFolderQuery.isLoading ? t`Loading...` : t`Location unavailable`));
	const recoveryPendingRef = React.useRef(false);
	const recoveredFolderRef = React.useRef<string | null>(null);
	const recoverMediaMutation = useMutation({
		mutationFn: () => fetchMediaItem(item.id),
		onSuccess: (refreshed) => {
			onItemRefreshed?.(refreshed);
			void queryClient.invalidateQueries({ queryKey: ["media"] });
		},
		onError: () => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
		},
		onSettled: () => {
			recoveryPendingRef.current = false;
		},
	});
	const recoverMediaItem = useStableCallback(() => {
		if (!localItem || recoveryPendingRef.current) return;
		recoveryPendingRef.current = true;
		recoverMediaMutation.mutate();
	});
	React.useEffect(() => {
		recoveryPendingRef.current = false;
		recoveredFolderRef.current = null;
		recoverMediaMutation.reset();
	}, [item.id, localItem?.folderId]);
	React.useEffect(() => {
		if (!currentFolderMissing || !localItem?.folderId) return;
		const recoveryKey = `${localItem.id}:${localItem.folderId}`;
		if (recoveredFolderRef.current === recoveryKey) return;
		recoveredFolderRef.current = recoveryKey;
		recoverMediaItem();
	}, [currentFolderMissing, localItem?.folderId, localItem?.id, recoverMediaItem]);
	React.useEffect(() => {
		if (!open) recoveredFolderRef.current = null;
	}, [open]);

	const updateMutation = useMutation({
		mutationFn: (data: MediaUpdateInput) => updateMedia(item.id, data),
		onSuccess: (updatedItem) => {
			if (locationChanged) restoreFocusAfterDeleteRef.current = true;
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			onItemRefreshed?.(
				localItem
					? {
							...localItem,
							...updatedItem,
							url: updatedItem.url || localItem.url,
						}
					: updatedItem,
			);
			onUpdated?.();
		},
		onError: (error) => {
			if (error instanceof ApiResponseError && error.code === "NOT_FOUND") recoverMediaItem();
		},
		onSettled: () => {
			savePendingRef.current = false;
		},
	});

	const deleteMutation = useMutation({
		mutationFn: () =>
			item.provider ? deleteFromProvider(item.provider, item.id) : deleteMedia(item.id),
		onSuccess: () => {
			if (item.provider) {
				void queryClient.invalidateQueries({ queryKey: ["provider-media", item.provider] });
			} else {
				void queryClient.invalidateQueries({ queryKey: ["media"] });
			}
			restoreFocusAfterDeleteRef.current = true;
			setShowDeleteConfirm(false);
			onDeleted?.();
			closeDialog();
		},
	});
	const cropMutation = useMutation({
		mutationFn: async (action: CropAction) => {
			const image = cropImageRef.current;
			const pixels = cropPixels;
			if (!image || !pixels) throw new CropFileCreationError();
			let file: File;
			try {
				file = await createCroppedImageFile(
					image,
					pixels,
					action === "duplicate"
						? createCroppedFilename(item.filename, cropAspectMode, pixels)
						: item.filename,
					cropMime,
				);
			} catch {
				throw new CropFileCreationError();
			}

			if (action === "duplicate") {
				return {
					action,
					item: await uploadMedia(file, {
						deduplicate: false,
						ensureUniqueFilename: true,
						folderId: localItem?.folderId ?? null,
					}),
				};
			}
			return {
				action,
				item: await replaceMediaImage(item.id, file, {
					width: pixels.width,
					height: pixels.height,
				}),
			};
		},
		onSuccess: ({ action, item: croppedItem }) => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			if (action === "duplicate") {
				onCroppedCopyCreated?.();
				onUpdated?.();
				setCropAspectMode("original");
				setCropSelection(undefined);
				setCropPixels(null);
				setCropStatus(t`Cropped copy created.`);
				closeDialog();
				return;
			}

			onItemRefreshed?.(croppedItem);
			setFocalPoint(null);
			setCropAspectMode("original");
			setCropSelection(undefined);
			setCropPixels(null);
			setCropSourceSize(null);
			setCropSourceFailed(false);
			setCropPreviewKey(createCropPreviewKey());
			setShowCropConfirm(false);
			setCropStatus(t`Original image cropped.`);
		},
		onError: (_error, action) => {
			setCropStatus("");
			if (action === "replace") setShowCropConfirm(false);
		},
		onSettled: () => {
			cropPendingRef.current = false;
		},
	});
	React.useEffect(() => {
		cropMutation.reset();
	}, [item.id, open]);
	const isSaving = updateMutation.isPending;
	const isDeleting = deleteMutation.isPending;
	const isRecovering = recoverMediaMutation.isPending;
	const isCropping = cropMutation.isPending;
	const mediaUnavailable =
		recoverMediaMutation.error instanceof ApiResponseError &&
		recoverMediaMutation.error.code === "NOT_FOUND";
	const isBusy = isSaving || isDeleting || isRecovering || isCropping;
	const cropFooterActive = activeTab === "edit-image" && imageEditMode === "crop" && canShowCrop;
	const cropActionDisabled =
		!cropChanged || cropSourceFailed || hasChanges || isBusy || mediaUnavailable;
	const updateNotFound =
		updateMutation.error instanceof ApiResponseError && updateMutation.error.code === "NOT_FOUND";
	const updateErrorMessage = mediaUnavailable
		? t`This media item no longer exists.`
		: updateNotFound
			? isRecovering
				? null
				: recoverMediaMutation.error
					? t`Couldn’t confirm whether the media item or selected folder still exists. Try again.`
					: t`The selected folder no longer exists. Choose another location and save again.`
			: getMutationError(updateMutation.error) || getMutationError(recoverMediaMutation.error);
	const cropErrorMessage =
		cropMutation.error instanceof CropFileCreationError
			? t`The cropped image could not be created.`
			: getMutationError(cropMutation.error);

	const requestClose = React.useCallback(() => {
		if (isBusy) return;
		if (isConfirmOpen) return;
		setPendingUsageEntry(null);
		if (hasChanges) {
			setShowDiscardConfirm(true);
			return;
		}
		closeDialog();
	}, [closeDialog, hasChanges, isBusy, isConfirmOpen]);

	const handleSave = () => {
		if (!canEdit || !hasChanges || isBusy || mediaUnavailable || savePendingRef.current) return;
		savePendingRef.current = true;
		const changes: MediaUpdateInput = {};
		if (canEditMetadata) {
			if (alt !== (item.alt ?? "")) changes.alt = alt;
			if (caption !== (item.caption ?? "")) changes.caption = caption;
			if (focalPointChanged) {
				changes.focalX = focalPoint?.focalX ?? null;
				changes.focalY = focalPoint?.focalY ?? null;
			}
		}
		if (locationChanged) changes.folderId = folderId;
		updateMutation.mutate(changes);
	};

	const handleDelete = () => {
		if (!canDelete || isBusy) return;
		setShowDeleteConfirm(true);
	};

	const startCrop = (action: CropAction) => {
		if (
			!canShowCrop ||
			!cropChanged ||
			cropSourceFailed ||
			hasChanges ||
			isBusy ||
			mediaUnavailable ||
			cropPendingRef.current
		) {
			return;
		}
		if (action === "replace" && (!canCropOriginal || cropAspectMode !== "original")) return;
		if (action === "duplicate" && !canDuplicateCrop) return;
		cropPendingRef.current = true;
		setCropStatus(action === "duplicate" ? t`Creating cropped copy...` : t`Replacing original...`);
		cropMutation.mutate(action);
	};

	const changeCropAspect = (value: string | null) => {
		if (!isCropAspectMode(value) || isBusy) return;
		setCropAspectMode(value);
		setCropSelection(undefined);
		setCropPixels(null);
		setCropStatus("");
		cropMutation.reset();
	};
	const resetCrop = () => {
		if (isBusy) return;
		setCropAspectMode("original");
		setCropSelection(undefined);
		setCropPixels(null);
		setCropStatus("");
		cropMutation.reset();
	};
	const transitionDialogLayout = (update: () => void) => {
		const dialog = dialogBodyRef.current?.closest<HTMLDivElement>('[role="dialog"]') ?? null;
		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		if (!dialog || reduceMotion || typeof dialog.animate !== "function") {
			dialogResizeAnimationRef.current?.cancel();
			dialogResizeAnimationRef.current = null;
			if (dialog) dialog.style.height = "";
			setSuppressDialogResizeOverflow(false);
			update();
			return;
		}

		const startHeight = dialog.getBoundingClientRect().height;
		dialogResizeAnimationRef.current?.cancel();
		dialogResizeAnimationRef.current = null;
		dialog.style.height = `${startHeight}px`;
		flushSync(() => {
			setSuppressDialogResizeOverflow(true);
			update();
		});
		dialog.style.height = "auto";
		const endHeight = dialog.getBoundingClientRect().height;
		if (Math.abs(endHeight - startHeight) < 1) {
			dialog.style.height = "";
			setSuppressDialogResizeOverflow(false);
			return;
		}

		dialog.style.height = `${startHeight}px`;
		const animation = dialog.animate(
			[{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
			{
				duration: DIALOG_RESIZE_DURATION_MS,
				easing: DIALOG_RESIZE_EASING,
				fill: "forwards",
			},
		);
		dialogResizeAnimationRef.current = animation;
		animation.addEventListener(
			"finish",
			() => {
				if (dialogResizeAnimationRef.current !== animation) return;
				dialogResizeAnimationRef.current = null;
				dialog.style.height = "";
				setSuppressDialogResizeOverflow(false);
				animation.cancel();
			},
			{ once: true },
		);
	};
	const changeImageEditMode = (mode: ImageEditMode) => {
		if (mode === imageEditMode || isBusy || (mode === "crop" && !canShowCrop)) return;
		if (imageModeOverflowFrameRef.current !== null) {
			window.cancelAnimationFrame(imageModeOverflowFrameRef.current);
		}
		setSuppressImageModeOverflow(true);
		transitionDialogLayout(() => {
			setImageEditMode(mode);
			cropMutation.reset();
			if (mode === "crop" && cropSourceFailed) {
				setCropSourceFailed(false);
				setCropPreviewKey(createCropPreviewKey());
			}
		});
		imageModeOverflowFrameRef.current = window.requestAnimationFrame(() => {
			imageModeOverflowFrameRef.current = window.requestAnimationFrame(() => {
				imageModeOverflowFrameRef.current = null;
				setSuppressImageModeOverflow(false);
			});
		});
	};

	const handleDiscardConfirm = () => {
		const usageEntry = pendingUsageEntry;
		setShowDiscardConfirm(false);
		setPendingUsageEntry(null);
		closeDialog();
		if (usageEntry) {
			void navigate({
				to: "/content/$collection/$id",
				params: { collection: usageEntry.collection, id: usageEntry.contentId },
				search: { locale: usageEntry.locale ?? undefined },
			});
		}
	};

	const handleUsageEntryClick = (
		event: React.MouseEvent<HTMLAnchorElement>,
		entry: MediaUsageEntryDetail,
	) => {
		if (isBusy) {
			event.preventDefault();
			return;
		}
		if (!hasChanges || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

		event.preventDefault();
		setPendingUsageEntry(entry);
		setShowDiscardConfirm(true);
	};

	const stableHandleSave = useStableCallback(handleSave);
	React.useEffect(() => {
		if (!open) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (isConfirmOpen) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				if (!canEdit || !hasChanges || isBusy || mediaUnavailable) return;
				event.preventDefault();
				stableHandleSave();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [canEdit, hasChanges, isBusy, isConfirmOpen, mediaUnavailable, open, stableHandleSave]);

	return (
		<>
			<Dialog.Root
				open={open}
				onOpenChange={(nextOpen) => {
					if (!nextOpen && !isConfirmOpen) requestClose();
				}}
				onOpenChangeComplete={(nextOpen) => {
					if (nextOpen) return;
					finishClose();
				}}
			>
				<Dialog
					size="xl"
					className="min-w-0 flex flex-col overflow-hidden p-0"
					style={{ width: "min(94vw, 68rem)", maxHeight: "min(88dvh, 43.5rem)" }}
				>
					<div
						className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line"
						style={{ padding: "1.25rem 2rem" }}
						data-testid="media-detail-dialog-header"
					>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="truncate text-lg font-semibold leading-none">
								{t`Media details`}
							</Dialog.Title>
							<p className="mt-1 truncate text-sm text-kumo-subtle">{item.filename}</p>
						</div>
						<Button
							variant="ghost"
							shape="square"
							aria-label={t`Close`}
							onClick={requestClose}
							disabled={isBusy}
						>
							<X className="h-4 w-4" aria-hidden="true" />
						</Button>
					</div>

					{hasTabs && (
						<div className="shrink-0 border-b border-kumo-line px-6 py-4 md:px-8">
							<Tabs
								variant="segmented"
								className="w-full max-w-lg"
								value={activeTab}
								onValueChange={(value) => {
									if (isBusy) return;
									if (
										value === "details" ||
										(value === "used-in" && hasUsage) ||
										(value === "edit-image" && canEditMetadata)
									) {
										transitionDialogLayout(() => {
											setActiveTab(value);
											cropMutation.reset();
										});
									}
								}}
								tabs={[
									{ value: "details", label: t`Details`, className: "flex-1 justify-center" },
									...(canEditMetadata
										? [
												{
													value: "edit-image",
													label: t`Edit image`,
													className: "flex-1 justify-center",
												},
											]
										: []),
									...(hasUsage
										? [{ value: "used-in", label: t`Used in`, className: "flex-1 justify-center" }]
										: []),
								]}
							/>
						</div>
					)}

					<div
						ref={dialogBodyRef}
						className={
							activeTab === "used-in"
								? "min-h-0 shrink overflow-hidden"
								: "grid min-h-0 shrink grid-cols-1 overflow-y-auto md:grid-cols-2 md:overflow-hidden"
						}
						style={
							activeTab === "used-in"
								? {
										flexGrow: 1,
										height: "min(16rem, calc(88dvh - 12.5rem))",
										overflowY: suppressDialogResizeOverflow ? "hidden" : undefined,
									}
								: {
										flexGrow: 1,
										overflowY: suppressDialogResizeOverflow ? "hidden" : undefined,
									}
						}
						data-testid="media-detail-dialog-body"
						role={hasTabs ? "tabpanel" : undefined}
						aria-label={
							hasTabs
								? activeTab === "details"
									? t`Details`
									: activeTab === "used-in"
										? t`Used in`
										: t`Edit image`
								: undefined
						}
					>
						<div
							className={`border-b border-kumo-line p-6 md:min-h-0 md:overflow-y-auto md:border-e md:border-b-0 ${activeTab === "edit-image" ? "flex flex-col" : "space-y-5"}`}
							data-testid="media-detail-dialog-preview-column"
							hidden={activeTab === "used-in"}
							style={{
								overflowY: suppressDialogResizeOverflow ? "hidden" : undefined,
							}}
						>
							{isImage ? (
								activeTab === "edit-image" && imageEditMode === "crop" && canShowCrop ? (
									cropSourceFailed ? (
										<FocalPointEditor
											key={`${item.id}:${item.url}:crop-fallback`}
											src={mediaPreviewUrl}
											sourceSize={cropAspectSource ?? undefined}
											alt={item.alt || item.filename}
											editing={false}
											disabled
											point={focalPoint}
											descriptionId={focalPointDescriptionId}
											onChange={setFocalPoint}
										/>
									) : (
										<MediaImageCropper
											key={cropPreviewKey}
											src={cropPreviewUrl}
											sourceSize={cropAspectSource ?? undefined}
											crop={cropSelection}
											aspect={
												cropAspectMode === "freeform" ||
												(cropAspectMode === "original" && !cropSourceSize)
													? undefined
													: cropAspect
											}
											disabled={isBusy}
											onCropChange={setCropSelection}
											onCropComplete={setCropPixels}
											onSourceReady={setCropSourceSize}
											onSourceError={() => setCropSourceFailed(true)}
											onImageReady={(image) => {
												cropImageRef.current = image;
											}}
										/>
									)
								) : (
									<FocalPointEditor
										key={`${item.id}:${item.url}`}
										src={
											activeTab === "edit-image" && canShowCrop ? cropPreviewUrl : mediaPreviewUrl
										}
										sourceSize={cropAspectSource ?? undefined}
										alt={item.alt || item.filename}
										editing={activeTab === "edit-image"}
										disabled={isBusy}
										point={focalPoint}
										descriptionId={focalPointDescriptionId}
										onChange={setFocalPoint}
										editorFrameRef={focalEditorFrameRef}
									/>
								)
							) : (
								<div className="flex h-64 items-center justify-center overflow-hidden rounded-xl bg-kumo-tint ring ring-kumo-line md:h-80">
									{isVideo && playback ? (
										<video
											poster={item.url || undefined}
											controls
											preload="metadata"
											className="max-h-full max-w-full"
										>
											{playback.hls && <source src={playback.hls} type="application/x-mpegURL" />}
											{playback.dash && <source src={playback.dash} type="application/dash+xml" />}
										</video>
									) : isVideo ? (
										<video
											src={item.url}
											controls
											preload="metadata"
											className="max-h-full max-w-full"
										/>
									) : isAudio ? (
										<audio src={item.url} controls preload="metadata" className="w-full" />
									) : (
										<div className="p-4 text-center">
											<span className="text-5xl" aria-hidden="true">
												{getFileIcon(item.mimeType)}
											</span>
											<p className="mt-3 text-sm text-kumo-subtle">{item.mimeType}</p>
										</div>
									)}
								</div>
							)}

							<div
								className="grid gap-x-6 gap-y-3"
								data-testid="media-detail-dialog-file-facts"
								hidden={activeTab !== "details"}
								style={{
									gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
								}}
							>
								<div className="flex min-w-0 items-start gap-2 text-sm">
									<span className="flex h-lh shrink-0 items-center text-kumo-subtle">
										<HardDrive className="h-4 w-4 translate-y-[2px]" aria-hidden="true" />
									</span>
									<p className="flex min-w-0 flex-nowrap items-baseline gap-1 whitespace-nowrap leading-5">
										<span className="text-kumo-subtle">{t`Size:`}</span>
										<span className="tabular-nums">{formatFileSize(item.size)}</span>
									</p>
								</div>
								{item.width && item.height && (
									<div className="flex min-w-0 items-start gap-2 text-sm">
										<span className="flex h-lh shrink-0 items-center text-kumo-subtle">
											<Ruler className="h-4 w-4 translate-y-[2px]" aria-hidden="true" />
										</span>
										<p className="flex min-w-0 flex-nowrap items-baseline gap-1 whitespace-nowrap leading-5">
											<span className="text-kumo-subtle">{t`Dimensions:`}</span>
											<span className="tabular-nums">
												{item.width} × {item.height}
											</span>
										</p>
									</div>
								)}
								{!isProviderAsset && (
									<div className="flex min-w-0 items-start gap-2 text-sm">
										<span className="flex h-lh shrink-0 items-center text-kumo-subtle">
											<Calendar className="h-4 w-4 translate-y-[2px]" aria-hidden="true" />
										</span>
										<p className="flex min-w-0 flex-nowrap items-baseline gap-1 overflow-hidden whitespace-nowrap leading-5">
											<span className="shrink-0 text-kumo-subtle">{t`Uploaded:`}</span>
											<span
												className="min-w-0 truncate tabular-nums"
												title={formatDate(item.createdAt)}
											>
												{formatDate(item.createdAt)}
											</span>
										</p>
									</div>
								)}
								<div className="flex min-w-0 items-start gap-2 text-sm">
									<span className="flex h-lh shrink-0 items-center text-kumo-subtle">
										<File className="h-4 w-4 translate-y-[2px]" aria-hidden="true" />
									</span>
									<p className="flex min-w-0 flex-nowrap items-baseline gap-1 whitespace-nowrap leading-5">
										<span className="text-kumo-subtle">{t`Format:`}</span>
										<span>{formatFileFormat(item.mimeType)}</span>
									</p>
								</div>
								<div
									className="col-span-full flex min-w-0 items-center gap-2 text-sm"
									data-testid="media-detail-dialog-file-url"
								>
									<LinkSimple
										className="h-4 w-4 shrink-0 translate-y-[2px] text-kumo-subtle"
										aria-hidden="true"
									/>
									<span className="shrink-0 text-kumo-subtle">{t`URL:`}</span>
									{publicFileUrl ? (
										<ClipboardText
											text={publicFilePath}
											textToCopy={publicFileUrl}
											size="sm"
											className="w-full min-w-0 max-w-none flex-1"
											labels={{ copyAction: t`Copy URL` }}
										/>
									) : (
										<span className="min-w-0 text-kumo-subtle">{t`No public URL available`}</span>
									)}
								</div>
							</div>
						</div>

						<div
							className="grid content-start gap-5 p-6 md:min-h-0 md:overflow-y-auto"
							data-testid="media-detail-dialog-details-column"
							hidden={activeTab === "used-in"}
							style={
								canEditMetadata
									? {
											gridTemplateAreas: updateErrorMessage ? '"panel" "error"' : '"panel"',
											overflowY:
												suppressImageModeOverflow || suppressDialogResizeOverflow
													? "hidden"
													: undefined,
											gridTemplateRows:
												activeTab === "edit-image"
													? updateErrorMessage
														? "minmax(0, 1fr) auto"
														: "minmax(0, 1fr)"
													: undefined,
										}
									: undefined
							}
						>
							{isProviderAsset && activeTab === "details" && (
								<p className="rounded-lg bg-kumo-tint p-3 text-sm text-kumo-subtle">
									{providerName
										? t`Managed by ${providerName}`
										: t`Managed by an external media provider`}
								</p>
							)}

							<div
								className="space-y-4"
								hidden={activeTab !== "details"}
								style={{
									gridArea: canEditMetadata ? "panel" : undefined,
								}}
							>
								<div className="w-full space-y-2">
									<div className="flex items-center gap-1.5">
										<span className="text-[14px] font-medium text-kumo-default">{t`Filename`}</span>
										<Tooltip
											content={filenameHelp}
											delay={0}
											closeDelay={0}
											render={
												<button
													type="button"
													className="inline-flex cursor-help rounded-full text-kumo-subtle hover:text-kumo-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
													aria-label={filenameHelpLabel}
												>
													<Info className="h-4 w-4" aria-hidden="true" />
												</button>
											}
										/>
									</div>
									<Input
										aria-label={t`Filename`}
										value={filename}
										onChange={(event) => setFilename(event.target.value)}
										disabled
										className="w-full bg-kumo-tint text-kumo-subtle"
									/>
								</div>

								{localItem &&
									(canMoveLocation ? (
										<Combobox<MediaLocationOption>
											label={t`Location`}
											items={locationOptions}
											filter={null}
											value={selectedLocation}
											inputValue={locationSearch}
											isItemEqualToValue={(option, value) => option.id === value.id}
											itemToStringLabel={(option) => option.name}
											itemToStringValue={(option) => option.id ?? "main"}
											disabled={isBusy || mediaUnavailable}
											onOpenChange={(nextOpen) => {
												setLocationOpen(nextOpen);
												if (!nextOpen) setLocationSearch("");
											}}
											onInputValueChange={(value, eventDetails) => {
												if (
													eventDetails.reason === "input-change" ||
													eventDetails.reason === "input-clear" ||
													eventDetails.reason === "clear-press"
												) {
													setLocationSearch(value);
												}
											}}
											onValueChange={(option) => {
												setFolderId(option?.id ?? null);
												setSelectedFolder(option?.id ? { id: option.id, name: option.name } : null);
											}}
										>
											<Combobox.Trigger
												aria-label={t`Location`}
												className={`${inputVariants()} relative flex w-full items-center pe-8 text-start`}
											>
												<Combobox.Value>
													{(option) =>
														option ? (
															<span className="flex min-w-0 items-center gap-2">
																<MediaLocationIcon folderId={option.id} />
																<span className="truncate" dir="auto">
																	{option.name}
																</span>
															</span>
														) : (
															<span>{t`Select a location`}</span>
														)
													}
												</Combobox.Value>
												<Combobox.Icon className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center text-kumo-subtle">
													<CaretDown className="h-4 w-4" aria-hidden="true" />
												</Combobox.Icon>
											</Combobox.Trigger>
											<Combobox.Content>
												<Combobox.Input
													aria-label={t`Search folders`}
													placeholder={t`Search folders`}
												/>
												<div
													className={
														locationListQuery.isFetching
															? "p-2 text-center text-sm text-kumo-subtle"
															: "sr-only"
													}
													role="status"
												>
													{locationListQuery.isFetching
														? t`Loading folders...`
														: locationListQuery.data
															? plural(locationFolders.length, {
																	one: "# folder loaded",
																	other: "# folders loaded",
																})
															: ""}
												</div>
												<Combobox.Empty>{t`No folders found`}</Combobox.Empty>
												<Combobox.List
													aria-busy={locationListQuery.isFetching || undefined}
													style={{ maxHeight: "5rem" }}
												>
													{(option) => (
														<Combobox.Item key={option.id ?? "main"} value={option}>
															<span className="flex min-w-0 items-center gap-2">
																<MediaLocationIcon folderId={option.id} />
																<span className="truncate" dir="auto">
																	{option.name}
																</span>
															</span>
														</Combobox.Item>
													)}
												</Combobox.List>
												{locationListQuery.error && (
													<div
														className="space-y-2 border-t border-kumo-line p-2 text-sm text-kumo-danger"
														role="alert"
													>
														<p>{t`Folders could not be loaded.`}</p>
														<Button
															variant="outline"
															size="sm"
															onClick={() => void locationListQuery.refetch()}
														>
															{t`Retry`}
														</Button>
													</div>
												)}
												{locationListQuery.hasNextPage && (
													<div className="border-t border-kumo-line p-2">
														<Button
															variant="ghost"
															size="sm"
															className="w-full justify-center"
															disabled={locationListQuery.isFetchingNextPage}
															onClick={() => void locationListQuery.fetchNextPage()}
														>
															{t`Load more folders`}
														</Button>
													</div>
												)}
											</Combobox.Content>
										</Combobox>
									) : (
										<div className="space-y-1">
											<p className="text-sm font-medium text-kumo-default">{t`Location`}</p>
											<p
												className="flex items-center gap-2 text-sm text-kumo-subtle"
												aria-live="polite"
											>
												<MediaLocationIcon folderId={localItem.folderId} />
												<span className="min-w-0 truncate" dir="auto">
													{currentLocationName}
												</span>
											</p>
										</div>
									))}

								{canEditMetadata && (
									<>
										<div className="w-full space-y-2">
											<div className="flex items-center gap-1.5">
												<span className="text-[14px] font-medium text-kumo-default">{t`Alt Text`}</span>
												<Tooltip
													content={altTextHelp}
													delay={0}
													closeDelay={0}
													render={
														<button
															type="button"
															className="inline-flex cursor-help rounded-full text-kumo-subtle hover:text-kumo-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
															aria-label={altTextHelpLabel}
														>
															<Info className="h-4 w-4" aria-hidden="true" />
														</button>
													}
												/>
											</div>
											<InputArea
												aria-label={t`Alt Text`}
												value={alt}
												onChange={(event) => setAlt(event.target.value)}
												placeholder={t`Describe this image for accessibility`}
												rows={2}
												disabled={isBusy || mediaUnavailable}
												className="w-full"
											/>
										</div>

										<InputArea
											label={t`Caption`}
											value={caption}
											onChange={(event) => setCaption(event.target.value)}
											placeholder={t`Optional caption for display`}
											rows={4}
											disabled={isBusy || mediaUnavailable}
										/>
									</>
								)}
							</div>
							{canEditMetadata && activeTab === "edit-image" ? (
								<div className="flex h-full min-h-0 flex-col gap-4" style={{ gridArea: "panel" }}>
									{canShowCrop ? (
										<Tabs
											variant="segmented"
											className="w-full"
											value={imageEditMode}
											onValueChange={(value) => {
												if (value === "focal-point" || value === "crop") {
													changeImageEditMode(value);
												}
											}}
											tabs={[
												{
													value: "crop",
													label: t`Crop`,
													className: "flex-1 justify-center",
												},
												{
													value: "focal-point",
													label: t`Focal point`,
													className: "flex-1 justify-center",
												},
											]}
										/>
									) : null}

									{imageEditMode === "focal-point" ? (
										<>
											<div className="flex items-center justify-between gap-3">
												<div className="flex min-w-0 items-center gap-1.5">
													<h3 className="text-sm font-semibold">{t`Focal point`}</h3>
													<Tooltip
														content={focalPointHelp}
														delay={0}
														closeDelay={0}
														render={
															<Button
																type="button"
																variant="ghost"
																shape="square"
																size="xs"
																aria-label={focalPointHelpLabel}
																icon={<Info className="h-4 w-4" aria-hidden="true" />}
															/>
														}
													/>
												</div>
												<p id={focalPointDescriptionId} className="sr-only">
													{focalPointHelp}
												</p>
												<Button
													type="button"
													variant="outline"
													size="sm"
													icon={
														<ArrowCounterClockwise
															className="h-4 w-4"
															weight="bold"
															aria-hidden="true"
														/>
													}
													className="shrink-0"
													onClick={() => setFocalPoint(null)}
													disabled={!focalPoint || isBusy}
												>
													{t`Reset`}
												</Button>
											</div>
											<section
												ref={focalPreviewSectionRef}
												className="mt-auto grid gap-2 border-t border-kumo-line pt-4 md:pt-2"
												style={{ transform: `translateY(${focalPreviewOffset}px)` }}
											>
												<h3 className="text-sm font-semibold">{t`Preview`}</h3>
												<FocalPointPreviews
													src={mediaPreviewUrl}
													point={focalPoint}
													firstPreviewRef={focalPreviewFrameRef}
												/>
											</section>
										</>
									) : (
										<div className="grid w-full gap-4">
											<div className="grid gap-2">
												<div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
													<div className="min-w-0">
														<Select
															label={t`Aspect ratio`}
															value={cropAspectMode}
															items={cropAspectOptions}
															className="w-full"
															size="lg"
															disabled={isBusy || cropSourceFailed}
															onValueChange={changeCropAspect}
														/>
													</div>
													<Button
														variant="outline"
														size="lg"
														aria-label={t`Reset crop`}
														icon={
															<ArrowCounterClockwise
																className="h-4 w-4"
																weight="bold"
																aria-hidden="true"
															/>
														}
														disabled={
															isBusy ||
															cropSourceFailed ||
															(cropAspectMode === "original" && !cropChanged)
														}
														onClick={resetCrop}
													>
														{t`Reset`}
													</Button>
												</div>
												<div className="flex min-h-9 items-center justify-between gap-3 rounded-lg bg-kumo-tint px-3 text-sm ring ring-kumo-line">
													<span className="text-kumo-subtle">{t`Output size`}</span>
													<output
														aria-label={t`Crop output dimensions`}
														className="shrink-0 font-medium tabular-nums text-kumo-default"
													>
														{cropPixels
															? `${cropPixels.width} × ${cropPixels.height}`
															: t`Loading...`}
													</output>
												</div>
												{canCropOriginal && cropAspectMode !== "original" ? (
													<p className="text-sm text-kumo-subtle">
														{t`Replace original is available with the Original aspect ratio.`}
													</p>
												) : null}
											</div>
											{cropSourceFailed ? (
												<DialogError message={t`This image could not be loaded for cropping.`} />
											) : null}
											{cropErrorMessage ? <DialogError message={cropErrorMessage} /> : null}
											{hasChanges ? (
												<p className="text-sm text-kumo-warning">
													{t`Save or discard the other changes before cropping.`}
												</p>
											) : null}
											{cropMime === "image/webp" ? (
												<p className="text-sm text-kumo-subtle">
													{t`Animated WebP files become still images when cropped.`}
												</p>
											) : null}
										</div>
									)}
								</div>
							) : null}
							{updateErrorMessage && (
								<div style={{ gridArea: canEditMetadata ? "error" : undefined }}>
									<DialogError message={updateErrorMessage} />
								</div>
							)}
						</div>
						{activeTab === "used-in" && (
							<div className="h-full min-h-0 w-full overflow-hidden p-6">
								<MediaUsedIn
									mediaId={item.id}
									open={open}
									navigationBlocked={isBusy}
									onEntryClick={handleUsageEntryClick}
								/>
							</div>
						)}
					</div>

					<p role="status" className="sr-only">
						{cropStatus}
					</p>
					<div
						className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-kumo-line"
						style={{ padding: "1rem 1.5rem" }}
						data-testid="media-detail-dialog-footer"
					>
						<div>
							{canDelete && !cropFooterActive && (
								<Button
									variant="destructive"
									icon={<Trash />}
									onClick={handleDelete}
									disabled={isBusy || mediaUnavailable}
								>
									{isDeleting ? t`Deleting...` : t`Delete`}
								</Button>
							)}
						</div>
						<div className="flex flex-wrap justify-end gap-2">
							<Button variant="outline" onClick={requestClose} disabled={isBusy}>
								{canEdit && (activeTab !== "used-in" || hasChanges) ? t`Cancel` : t`Close`}
							</Button>
							{cropFooterActive ? (
								<>
									{canCropOriginal ? (
										<Button
											variant="secondary-destructive"
											disabled={cropActionDisabled || cropAspectMode !== "original"}
											onClick={() => setShowCropConfirm(true)}
										>
											{t`Replace original`}
										</Button>
									) : null}
									{canDuplicateCrop ? (
										<Button
											variant="primary"
											loading={isCropping && cropMutation.variables === "duplicate"}
											disabled={cropActionDisabled}
											onClick={() => startCrop("duplicate")}
										>
											{t`Create cropped copy`}
										</Button>
									) : null}
								</>
							) : canEdit && (activeTab !== "used-in" || hasChanges) ? (
								<Button
									variant="primary"
									onClick={handleSave}
									disabled={!hasChanges || isBusy || mediaUnavailable}
								>
									{isSaving ? t`Saving...` : t`Save`}
								</Button>
							) : null}
						</div>
					</div>
				</Dialog>
			</Dialog.Root>

			<ConfirmDialog
				open={showDiscardConfirm}
				onClose={() => {
					setShowDiscardConfirm(false);
					setPendingUsageEntry(null);
				}}
				title={t`Discard changes?`}
				description={t`Your unsaved media changes will be lost.`}
				confirmLabel={t`Discard`}
				pendingLabel={t`Discarding...`}
				isPending={false}
				error={null}
				onConfirm={handleDiscardConfirm}
			/>

			<ConfirmDialog
				open={showDeleteConfirm}
				onClose={() => {
					setShowDeleteConfirm(false);
					deleteMutation.reset();
				}}
				role="alertdialog"
				title={t`Delete media?`}
				titleClassName="text-[18px] font-semibold leading-6"
				description={
					<span className="text-[14px] leading-5">
						{isProviderAsset
							? providerName
								? t`"${item.filename}" will be deleted from ${providerName}.`
								: t`"${item.filename}" will be deleted from its media provider.`
							: t`"${item.filename}" will be permanently deleted.`}
					</span>
				}
				descriptionClassName="text-pretty text-[14px] leading-5 text-kumo-subtle"
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				compact
				error={deleteMutation.error}
				onConfirm={() => deleteMutation.mutate()}
			>
				{!isProviderAsset ? (
					<Banner
						variant="error"
						icon={<WarningCircle className="h-4 w-4" aria-hidden="true" />}
						title={t`This cannot be undone`}
						description={
							<span className="text-[14px] leading-5">
								{t`Content using this media item may show a broken reference.`}
							</span>
						}
						className="mt-4 text-[14px]"
						role="note"
					/>
				) : null}
			</ConfirmDialog>

			<ConfirmDialog
				open={showCropConfirm}
				onClose={() => setShowCropConfirm(false)}
				role="alertdialog"
				title={t`Replace original image?`}
				titleClassName="text-[18px] font-semibold leading-6"
				description={
					<span className="text-[14px] leading-5">
						{t`Every place using this image will update to the cropped version.`}
					</span>
				}
				descriptionClassName="text-pretty text-[14px] leading-5 text-kumo-subtle"
				confirmLabel={t`Replace original`}
				pendingLabel={t`Replacing original...`}
				isPending={isCropping && cropMutation.variables === "replace"}
				compact
				preventCloseWhilePending
				error={null}
				onConfirm={() => startCrop("replace")}
			>
				<Banner
					variant="error"
					icon={<WarningCircle className="h-4 w-4" aria-hidden="true" />}
					title={t`This cannot be undone`}
					description={
						<span className="text-[14px] leading-5">
							{t`EmDash does not keep the uncropped image.`}
						</span>
					}
					className="mt-4 text-[14px]"
					role="note"
				/>
				<p role="status" className="sr-only">
					{isCropping && cropMutation.variables === "replace" ? t`Replacing original...` : ""}
				</p>
			</ConfirmDialog>
		</>
	);
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatFileFormat(mimeType: string): string {
	return (mimeType.split("/").at(-1)?.split("+")[0] || mimeType).toUpperCase();
}

function isLocalMediaItem(item: MediaItem): item is LocalMediaItem {
	return (
		!item.provider &&
		"folderId" in item &&
		"authorId" in item &&
		typeof item.storageKey === "string"
	);
}

function MediaLocationIcon({ folderId }: { folderId: string | null }) {
	const LocationIcon = folderId === null ? ImagesSquare : Folder;
	return (
		<LocationIcon
			className="h-4 w-4 shrink-0 text-kumo-subtle"
			aria-hidden="true"
			data-testid="media-location-icon"
		/>
	);
}

export default MediaDetailPanel;
