/**
 * Media Detail Dialog
 *
 * A centered dialog for viewing and editing media item metadata.
 * Opens when clicking an item in the MediaLibrary.
 */

import {
	Button,
	ClipboardText,
	Combobox,
	Dialog,
	Input,
	InputArea,
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
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	ApiResponseError,
	updateMedia,
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
import { useDebouncedValue, useStableCallback } from "../lib/hooks";
import {
	getFileIcon,
	formatFileSize,
	metaPlayback,
	normalizeMediaFocalPoint,
	type MediaFocalPoint,
} from "../lib/media-utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogError, getMutationError } from "./DialogError.js";
import { FocalPointEditor, FocalPointPreviews } from "./FocalPointEditor.js";
import { MediaUsedIn } from "./MediaUsedIn.js";

const CLOSE_FALLBACK_MS = 500;
type MediaDetailTab = "details" | "used-in" | "edit-image";

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
	restoreFocusTargetRef?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
	onClosed?: () => void;
	onUpdated?: () => void;
	onItemRefreshed?: (item: LocalMediaItem) => void;
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
	restoreFocusTargetRef,
	onClose,
	onClosed,
	onUpdated,
	onItemRefreshed,
	onDeleted,
}: MediaDetailPanelProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const restoreFocusAfterDeleteRef = React.useRef(false);
	const savePendingRef = React.useRef(false);
	const closeFallbackTimerRef = React.useRef<number | null>(null);
	const closeFinishedRef = React.useRef(false);

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
	const [activeTab, setActiveTab] = React.useState<MediaDetailTab>("details");
	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
	const [showDiscardConfirm, setShowDiscardConfirm] = React.useState(false);
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
		setFilename(item.filename);
		setAlt(item.alt ?? "");
		setCaption(item.caption ?? "");
		setFolderId(localItem?.folderId ?? null);
		setSelectedFolder(null);
		setLocationOpen(false);
		setLocationSearch("");
		setFocalPoint(normalizeMediaFocalPoint(item));
		setActiveTab("details");
		setShowDeleteConfirm(false);
		setShowDiscardConfirm(false);
		setPendingUsageEntry(null);
	}, [item.id, localItem?.folderId, open]);

	React.useEffect(() => {
		return () => {
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
	const isConfirmOpen = showDeleteConfirm || showDiscardConfirm;
	const publicFileUrl =
		!isProviderAsset && item.url ? new URL(item.url, window.location.origin).href : "";
	const publicFilePath = publicFileUrl ? new URL(publicFileUrl).pathname : "";
	const filenameHelp = t`Filename cannot be changed after upload`;
	const filenameHelpLabel = t`Why can't this be changed?`;
	const altTextHelp = t`Used by screen readers and when image fails to load`;
	const altTextHelpLabel = t`Why is this important?`;
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
		onSuccess: () => {
			if (locationChanged) restoreFocusAfterDeleteRef.current = true;
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			onUpdated?.();
			closeDialog();
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
	const isSaving = updateMutation.isPending;
	const isDeleting = deleteMutation.isPending;
	const isRecovering = recoverMediaMutation.isPending;
	const mediaUnavailable =
		recoverMediaMutation.error instanceof ApiResponseError &&
		recoverMediaMutation.error.code === "NOT_FOUND";
	const isBusy = isSaving || isDeleting || isRecovering;
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
					style={{ width: "min(94vw, 72rem)", height: "min(88dvh, 43.5rem)" }}
				>
					<div
						className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line"
						style={{ padding: "1.25rem 2rem" }}
						data-testid="media-detail-dialog-header"
					>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="truncate text-lg font-semibold leading-none tracking-tight">
								{t`Media Details`}
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
									if (
										value === "details" ||
										(value === "used-in" && hasUsage) ||
										(value === "edit-image" && canEditMetadata)
									) {
										setActiveTab(value);
									}
								}}
								tabs={[
									{ value: "details", label: t`Details`, className: "flex-1 justify-center" },
									...(hasUsage
										? [{ value: "used-in", label: t`Used in`, className: "flex-1 justify-center" }]
										: []),
									...(canEditMetadata
										? [
												{
													value: "edit-image",
													label: t`Focal point`,
													className: "flex-1 justify-center",
												},
											]
										: []),
								]}
							/>
						</div>
					)}

					<div
						className={
							activeTab === "used-in"
								? "min-h-0 flex-1 overflow-hidden"
								: "grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-2 md:overflow-hidden"
						}
						data-testid="media-detail-dialog-body"
						role={hasTabs ? "tabpanel" : undefined}
						aria-label={
							hasTabs
								? activeTab === "details"
									? t`Details`
									: activeTab === "used-in"
										? t`Used in`
										: t`Focal point`
								: undefined
						}
					>
						<div
							className={`border-b border-kumo-line p-6 md:min-h-0 md:overflow-y-auto md:border-e md:border-b-0 md:p-8 ${activeTab === "edit-image" ? "flex flex-col md:justify-center" : "space-y-5"}`}
							data-testid="media-detail-dialog-preview-column"
							hidden={activeTab === "used-in"}
						>
							{isImage ? (
								<FocalPointEditor
									key={`${item.id}:${item.url}`}
									src={item.url}
									alt={item.alt || item.filename}
									editing={activeTab === "edit-image"}
									disabled={isBusy}
									point={focalPoint}
									descriptionId={focalPointDescriptionId}
									onChange={setFocalPoint}
								/>
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
							className={`grid gap-5 p-6 md:min-h-0 md:overflow-y-auto md:p-8 ${activeTab === "edit-image" ? "md:content-center" : ""}`}
							data-testid="media-detail-dialog-details-column"
							hidden={activeTab === "used-in"}
							style={
								canEditMetadata
									? { gridTemplateAreas: updateErrorMessage ? '"panel" "error"' : '"panel"' }
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
											<Input
												aria-label={t`Alt Text`}
												value={alt}
												onChange={(event) => setAlt(event.target.value)}
												placeholder={t`Describe this image for accessibility`}
												disabled={isBusy || mediaUnavailable}
												className="w-full"
											/>
										</div>

										<InputArea
											label={t`Caption`}
											value={caption}
											onChange={(event) => setCaption(event.target.value)}
											placeholder={t`Optional caption for display`}
											rows={2}
											disabled={isBusy || mediaUnavailable}
										/>
									</>
								)}
							</div>
							{canEditMetadata && (
								<div
									className="grid content-start gap-6"
									hidden={activeTab !== "edit-image"}
									style={{
										gridArea: "panel",
									}}
								>
									<div className="flex items-center justify-between gap-4">
										<div className="grid min-w-0 max-w-xs gap-1.5">
											<h3 className="text-sm font-semibold">{t`Focal point`}</h3>
											<p id={focalPointDescriptionId} className="text-sm text-kumo-subtle">
												{t`Move the focal point to choose what stays visible in cropped images.`}
											</p>
										</div>
										<Button
											type="button"
											variant="outline"
											size="lg"
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
									{activeTab === "edit-image" && (
										<section className="grid gap-4 border-t border-kumo-line pt-5">
											<h3 className="text-sm font-semibold">{t`Preview`}</h3>
											<FocalPointPreviews src={item.url} point={focalPoint} />
										</section>
									)}
								</div>
							)}
							{updateErrorMessage && (
								<div style={{ gridArea: canEditMetadata ? "error" : undefined }}>
									<DialogError message={updateErrorMessage} />
								</div>
							)}
						</div>
						{activeTab === "used-in" && (
							<div className="h-full min-h-0 w-full overflow-hidden p-6 md:p-8">
								<MediaUsedIn
									mediaId={item.id}
									open={open}
									navigationBlocked={isBusy}
									onEntryClick={handleUsageEntryClick}
								/>
							</div>
						)}
					</div>

					<div
						className="flex shrink-0 items-center justify-between gap-3 border-t border-kumo-line"
						style={{ padding: "1.25rem 2rem" }}
						data-testid="media-detail-dialog-footer"
					>
						<div>
							{canDelete && (
								<Button
									variant="destructive"
									size="sm"
									icon={<Trash />}
									onClick={handleDelete}
									disabled={isBusy || mediaUnavailable}
								>
									{isDeleting ? t`Deleting...` : t`Delete`}
								</Button>
							)}
						</div>
						<div className="flex gap-2">
							<Button variant="outline" size="sm" onClick={requestClose} disabled={isBusy}>
								{canEdit ? t`Cancel` : t`Close`}
							</Button>
							{canEdit && (
								<Button
									variant="primary"
									size="sm"
									onClick={handleSave}
									disabled={!hasChanges || isBusy || mediaUnavailable}
								>
									{isSaving ? t`Saving...` : t`Save`}
								</Button>
							)}
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
				title={t`Delete Media?`}
				description={t`Delete "${item.filename}"? This cannot be undone.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => deleteMutation.mutate()}
			/>
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
