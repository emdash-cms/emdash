/**
 * Media Detail Dialog
 *
 * A centered dialog for viewing and editing media item metadata.
 * Opens when clicking an item in the MediaLibrary.
 */

import { Button, ClipboardText, Dialog, Input, InputArea, Tooltip } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { X, Trash, Calendar, HardDrive, LinkSimple, Ruler, Info } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { updateMedia, deleteMedia, deleteFromProvider, type MediaItem } from "../lib/api";
import { useStableCallback } from "../lib/hooks";
import { getFileIcon, formatFileSize } from "../lib/media-utils";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogError, getMutationError } from "./DialogError.js";

const CLOSE_FALLBACK_MS = 500;

export interface MediaDetailPanelProps {
	open: boolean;
	item: MediaItem;
	providerName?: string;
	canDelete?: boolean;
	restoreFocusTargetRef?: React.RefObject<HTMLElement | null>;
	onClose: () => void;
	onClosed?: () => void;
	onUpdated?: () => void;
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
	restoreFocusTargetRef,
	onClose,
	onClosed,
	onUpdated,
	onDeleted,
}: MediaDetailPanelProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const restoreFocusAfterDeleteRef = React.useRef(false);
	const closeFallbackTimerRef = React.useRef<number | null>(null);
	const closeFinishedRef = React.useRef(false);

	const isProviderAsset = Boolean(item.provider);
	const isImage = item.mimeType.startsWith("image/");
	const isVideo = item.mimeType.startsWith("video/");
	const isAudio = item.mimeType.startsWith("audio/");
	const canEditMetadata = !isProviderAsset && isImage;
	const canDelete = !isProviderAsset || Boolean(canDeleteProp);

	const [filename, setFilename] = React.useState(item.filename);
	const [alt, setAlt] = React.useState(item.alt ?? "");
	const [caption, setCaption] = React.useState(item.caption ?? "");
	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
	const [showDiscardConfirm, setShowDiscardConfirm] = React.useState(false);

	React.useEffect(() => {
		if (!open) return;
		if (closeFallbackTimerRef.current !== null) {
			window.clearTimeout(closeFallbackTimerRef.current);
			closeFallbackTimerRef.current = null;
		}
		closeFinishedRef.current = false;
		restoreFocusAfterDeleteRef.current = false;
		setFilename(item.filename);
		setAlt(item.alt ?? "");
		setCaption(item.caption ?? "");
		setShowDeleteConfirm(false);
		setShowDiscardConfirm(false);
	}, [item.id, open]);

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
				restoreFocusTargetRef?.current?.focus();
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

	const hasChanges =
		canEditMetadata && (alt !== (item.alt ?? "") || caption !== (item.caption ?? ""));
	const isConfirmOpen = showDeleteConfirm || showDiscardConfirm;
	const publicFileUrl =
		!isProviderAsset && item.url ? new URL(item.url, window.location.origin).href : "";
	const filenameHelp = t`Filename cannot be changed after upload`;
	const filenameHelpLabel = t`Why can't this be changed?`;
	const altTextHelp = t`Used by screen readers and when image fails to load`;
	const altTextHelpLabel = t`Why is this important?`;

	const updateMutation = useMutation({
		mutationFn: (data: { alt?: string; caption?: string }) => updateMedia(item.id, data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			onUpdated?.();
			closeDialog();
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
	const isBusy = isSaving || isDeleting;

	const requestClose = React.useCallback(() => {
		if (isBusy) return;
		if (isConfirmOpen) return;
		if (hasChanges) {
			setShowDiscardConfirm(true);
			return;
		}
		closeDialog();
	}, [closeDialog, hasChanges, isBusy, isConfirmOpen]);

	const handleSave = () => {
		if (!canEditMetadata || !hasChanges || isSaving) return;
		updateMutation.mutate({
			alt,
			caption,
		});
	};

	const handleDelete = () => {
		if (!canDelete || isBusy) return;
		setShowDeleteConfirm(true);
	};

	const handleDiscardConfirm = () => {
		setShowDiscardConfirm(false);
		closeDialog();
	};

	const stableHandleSave = useStableCallback(handleSave);
	React.useEffect(() => {
		if (!open) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (isConfirmOpen) return;
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				if (!canEditMetadata || !hasChanges || isSaving) return;
				event.preventDefault();
				stableHandleSave();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [canEditMetadata, hasChanges, isConfirmOpen, isSaving, open, stableHandleSave]);

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
					className="flex flex-col overflow-hidden p-0"
					style={{ width: "min(94vw, 72rem)", maxHeight: "min(88dvh, 48rem)" }}
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

					<div
						className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-2 md:overflow-hidden"
						data-testid="media-detail-dialog-body"
					>
						<div
							className="space-y-5 border-b border-kumo-line p-6 md:min-h-0 md:overflow-y-auto md:border-e md:border-b-0 md:p-8"
							data-testid="media-detail-dialog-preview-column"
						>
							<div className="flex h-64 items-center justify-center overflow-hidden rounded-xl border border-kumo-line bg-kumo-tint md:h-80">
								{isImage ? (
									<img
										src={item.url}
										alt={item.alt || item.filename}
										className="max-h-full max-w-full object-contain"
									/>
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

							<div className="space-y-3" data-testid="media-detail-dialog-file-facts">
								<div className="flex items-center gap-2 text-sm">
									<HardDrive className="h-4 w-4 shrink-0 text-kumo-subtle" aria-hidden="true" />
									<span className="text-kumo-subtle">{t`Size:`}</span>
									<span>{formatFileSize(item.size)}</span>
								</div>
								{item.width && item.height && (
									<div className="flex items-center gap-2 text-sm">
										<Ruler className="h-4 w-4 shrink-0 text-kumo-subtle" aria-hidden="true" />
										<span className="text-kumo-subtle">{t`Dimensions:`}</span>
										<span>
											{item.width} × {item.height}
										</span>
									</div>
								)}
								{!isProviderAsset && (
									<div className="flex items-center gap-2 text-sm">
										<Calendar className="h-4 w-4 shrink-0 text-kumo-subtle" aria-hidden="true" />
										<span className="text-kumo-subtle">{t`Uploaded:`}</span>
										<span>{formatDate(item.createdAt)}</span>
									</div>
								)}
								<div className="flex items-center gap-2 text-sm">
									<LinkSimple className="h-4 w-4 shrink-0 text-kumo-subtle" aria-hidden="true" />
									<span className="shrink-0 text-kumo-subtle">{t`URL:`}</span>
									{publicFileUrl ? (
										<ClipboardText
											text={publicFileUrl}
											size="sm"
											className="min-w-0 flex-1"
											labels={{ copyAction: t`Copy URL` }}
										/>
									) : (
										<span className="min-w-0 text-kumo-subtle">{t`No public URL available`}</span>
									)}
								</div>
							</div>
						</div>

						<div
							className="space-y-5 p-6 md:min-h-0 md:overflow-y-auto md:p-8"
							data-testid="media-detail-dialog-details-column"
						>
							{isProviderAsset && (
								<p className="rounded-lg bg-kumo-tint p-3 text-sm text-kumo-subtle">
									{providerName
										? t`Managed by ${providerName}`
										: t`Managed by an external media provider`}
								</p>
							)}

							<div className="space-y-4">
								<div className="w-full space-y-2">
									<div className="flex items-center gap-1.5">
										<span className="text-sm font-medium text-kumo-default">{t`Filename`}</span>
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

								{canEditMetadata && (
									<>
										<div className="w-full space-y-2">
											<div className="flex items-center gap-1.5">
												<span className="text-sm font-medium text-kumo-default">{t`Alt Text`}</span>
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
												disabled={isSaving}
												className="w-full"
											/>
										</div>

										<InputArea
											label={t`Caption`}
											value={caption}
											onChange={(event) => setCaption(event.target.value)}
											placeholder={t`Optional caption for display`}
											rows={2}
											disabled={isSaving}
										/>
									</>
								)}
							</div>

							<DialogError message={getMutationError(updateMutation.error)} />
						</div>
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
									disabled={isBusy}
								>
									{isDeleting ? t`Deleting...` : t`Delete`}
								</Button>
							)}
						</div>
						<div className="flex gap-2">
							<Button variant="outline" size="sm" onClick={requestClose} disabled={isBusy}>
								{canEditMetadata ? t`Cancel` : t`Close`}
							</Button>
							{canEditMetadata && (
								<Button
									variant="primary"
									size="sm"
									onClick={handleSave}
									disabled={!hasChanges || isBusy}
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
				onClose={() => setShowDiscardConfirm(false)}
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

export default MediaDetailPanel;
