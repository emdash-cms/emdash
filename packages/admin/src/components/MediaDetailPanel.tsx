/**
 * Media Detail Panel
 *
 * A slide-out panel for viewing and editing media item metadata.
 * Opens when clicking an item in the MediaLibrary.
 */

import { Button, Input, InputArea } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { X, Trash, Calendar, HardDrive, Ruler } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { updateMedia, deleteMedia, type MediaItem } from "../lib/api";
import { useStableCallback } from "../lib/hooks";
import { getFileIcon, formatFileSize } from "../lib/media-utils";
import { cn } from "../lib/utils";
import { ConfirmDialog } from "./ConfirmDialog";

export interface MediaDetailPanelProps {
	item: MediaItem | null;
	onClose: () => void;
	onDeleted?: () => void;
}

/**
 * Slide-out panel for viewing and editing media metadata
 */
export function MediaDetailPanel({ item, onClose, onDeleted }: MediaDetailPanelProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();

	// Form state - controlled inputs
	const [filename, setFilename] = React.useState(item?.filename ?? "");
	const [alt, setAlt] = React.useState(item?.alt ?? "");
	const [caption, setCaption] = React.useState(item?.caption ?? "");

	// Reset form when item changes
	React.useEffect(() => {
		if (item) {
			setFilename(item.filename);
			setAlt(item.alt ?? "");
			setCaption(item.caption ?? "");
		}
	}, [item]);

	// Track if form has unsaved changes
	const hasChanges = React.useMemo(() => {
		if (!item) return false;
		return (
			filename !== item.filename || alt !== (item.alt ?? "") || caption !== (item.caption ?? "")
		);
	}, [item, filename, alt, caption]);

	// Update mutation
	const updateMutation = useMutation({
		mutationFn: (data: { alt?: string; caption?: string }) => {
			if (!item) throw new Error("No item selected");
			return updateMedia(item.id, data);
		},
		onSuccess: () => {
			// Invalidate to refresh the list
			void queryClient.invalidateQueries({ queryKey: ["media"] });
		},
	});

	// Delete mutation
	const deleteMutation = useMutation({
		mutationFn: () => {
			if (!item) throw new Error("No item selected");
			return deleteMedia(item.id);
		},
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			onDeleted?.();
			onClose();
		},
	});

	const handleSave = () => {
		if (!item || !hasChanges) return;
		updateMutation.mutate({
			alt: alt || undefined,
			caption: caption || undefined,
		});
	};

	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

	const handleDelete = () => {
		if (!item) return;
		setShowDeleteConfirm(true);
	};

	const stableOnClose = useStableCallback(onClose);
	const stableHandleSave = useStableCallback(handleSave);

	// Handle keyboard shortcuts
	React.useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				stableOnClose();
			}
			if ((e.metaKey || e.ctrlKey) && e.key === "s") {
				e.preventDefault();
				stableHandleSave();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [stableOnClose, stableHandleSave]);

	if (!item) return null;

	const isImage = item.mimeType.startsWith("image/");
	const isVideo = item.mimeType.startsWith("video/");
	const isAudio = item.mimeType.startsWith("audio/");

	return (
		<>
			<div
				className={cn(
					"fixed inset-y-0 end-0 w-96 bg-kumo-base border-s shadow-xl z-50",
					"flex flex-col",
					"animate-in slide-in-from-right duration-200",
				)}
			>
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b">
					<h2 className="font-semibold truncate pe-2">{t`Media Details`}</h2>
					<Button variant="ghost" shape="square" aria-label={t`Close`} onClick={onClose}>
						<X className="h-4 w-4" />
						<span className="sr-only">{t`Close`}</span>
					</Button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto">
					{/* Preview */}
					<div className="p-4 border-b">
						<div className="aspect-video bg-kumo-tint rounded-lg overflow-hidden flex items-center justify-center">
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
								<div className="text-center p-4">
									<span className="text-4xl">{getFileIcon(item.mimeType)}</span>
									<p className="mt-2 text-sm text-kumo-subtle">{item.mimeType}</p>
								</div>
							)}
						</div>
					</div>

					{/* File Info */}
					<div className="p-4 border-b space-y-3">
						<div className="flex items-center gap-2 text-sm">
							<HardDrive className="h-4 w-4 text-kumo-subtle" />
							<span className="text-kumo-subtle">{t`Size:`}</span>
							<span>{formatFileSize(item.size)}</span>
						</div>
						{item.width && item.height && (
							<div className="flex items-center gap-2 text-sm">
								<Ruler className="h-4 w-4 text-kumo-subtle" />
								<span className="text-kumo-subtle">{t`Dimensions:`}</span>
								<span>
									{item.width} × {item.height}
								</span>
							</div>
						)}
						<div className="flex items-center gap-2 text-sm">
							<Calendar className="h-4 w-4 text-kumo-subtle" />
							<span className="text-kumo-subtle">{t`Uploaded:`}</span>
							<span>{formatDate(item.createdAt)}</span>
						</div>
					</div>

					{/* Editable Fields */}
					<div className="p-4 space-y-4">
						<Input
							label={t`Filename`}
							value={filename}
							onChange={(e) => setFilename(e.target.value)}
							disabled // Filename editing needs backend support
							description={t`Filename cannot be changed after upload`}
						/>

						{isImage && (
							<>
								<Input
									label={t`Alt Text`}
									value={alt}
									onChange={(e) => setAlt(e.target.value)}
									placeholder={t`Describe this image for accessibility`}
									description={t`Used by screen readers and when image fails to load`}
								/>

								<InputArea
									label={t`Caption`}
									value={caption}
									onChange={(e) => setCaption(e.target.value)}
									placeholder={t`Optional caption for display`}
									rows={2}
								/>
							</>
						)}
					</div>
				</div>

				{/* Footer */}
				<div className="p-4 border-t flex items-center justify-between gap-2">
					<Button
						variant="destructive"
						size="sm"
						icon={<Trash />}
						onClick={handleDelete}
						disabled={deleteMutation.isPending}
					>
						{deleteMutation.isPending ? t`Deleting...` : t`Delete`}
					</Button>
					<div className="flex gap-2">
						<Button variant="outline" size="sm" onClick={onClose}>
							{t`Cancel`}
						</Button>
						<Button
							size="sm"
							onClick={handleSave}
							disabled={!hasChanges || updateMutation.isPending}
						>
							{updateMutation.isPending ? t`Saving...` : t`Save`}
						</Button>
					</div>
				</div>
			</div>

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
