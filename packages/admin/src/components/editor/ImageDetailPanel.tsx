/**
 * Image Detail Panel for Editor
 *
 * A slide-out panel for editing image properties in the rich text editor.
 * Shows preview and allows editing alt text, caption, and link settings.
 */

import { Button, Input, InputArea, Label, LinkButton } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	X,
	ArrowSquareOut,
	Ruler,
	SlidersHorizontal,
	ImageSquare,
	PencilSimple,
	LinkSimple,
	LinkBreak,
} from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../../lib/api";
import { useStableCallback } from "../../lib/hooks";
import { canonicalMediaProviderId, metaString } from "../../lib/media-utils.js";
import { ConfirmDialog } from "../ConfirmDialog";
import { useMediaAssetEditor } from "../media/useMediaAssetEditor.js";
import { MediaPickerModal } from "../MediaPickerModal";

export interface ImageAttributes {
	src: string;
	alt?: string;
	title?: string;
	caption?: string;
	mediaId?: string;
	provider?: string;
	/** Original image width */
	width?: number;
	/** Original image height */
	height?: number;
	/** LQIP blurhash placeholder */
	blurhash?: string;
	/** LQIP dominant-color placeholder */
	dominantColor?: string;
	/** Display width for this instance (defaults to original) */
	displayWidth?: number;
	/** Display height for this instance (defaults to original) */
	displayHeight?: number;
	/** Alignment for this image instance (e.g. from a WordPress import) */
	alignment?: "left" | "center" | "right" | "wide" | "full";
}

export interface ImagePanelAttributes extends ImageAttributes {
	/** Transient identity for the image node that opened the sidebar. */
	nodeKey?: object;
}

export interface ImageDetailPanelProps {
	attributes: ImagePanelAttributes;
	onUpdate: (attrs: Partial<ImageAttributes>) => void;
	onReplace: (attrs: ImageAttributes) => void;
	onDelete: () => void;
	onClose: () => void;
	/** When true, renders inline within the sidebar column instead of as a fixed overlay */
	inline?: boolean;
}

/**
 * Panel for editing image properties in the editor.
 * Renders as a fixed slide-out overlay by default, or inline within
 * the content sidebar when `inline` is true.
 */
export function ImageDetailPanel({
	attributes,
	onUpdate,
	onReplace,
	onDelete,
	onClose,
	inline = false,
}: ImageDetailPanelProps) {
	const { t } = useLingui();
	// Form state
	const [alt, setAlt] = React.useState(attributes.alt ?? "");
	const [caption, setCaption] = React.useState(attributes.caption ?? "");
	const [title, setTitle] = React.useState(attributes.title ?? "");
	const [showMediaPicker, setShowMediaPicker] = React.useState(false);
	const [asset, setAsset] = React.useState(attributes);
	const handleAssetItemChanged = React.useCallback(
		(item: MediaItem) => {
			setDisplayWidth((current) =>
				attributes.displayWidth === undefined && current === asset.width ? item.width : current,
			);
			setDisplayHeight((current) =>
				attributes.displayHeight === undefined && current === asset.height ? item.height : current,
			);
			setAsset((current) => ({
				...current,
				src: item.url,
				mediaId: item.id,
				provider: "local",
				width: item.width,
				height: item.height,
				blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
				dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
			}));
			onUpdate({
				src: item.url,
				mediaId: item.id,
				provider: "local",
				width: item.width,
				height: item.height,
				blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
				dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
			});
		},
		[asset.height, asset.width, attributes.displayHeight, attributes.displayWidth, onUpdate],
	);
	const assetEditor = useMediaAssetEditor(handleAssetItemChanged);

	// Dimension state - default to display dimensions, fall back to original
	const [displayWidth, setDisplayWidth] = React.useState<number | undefined>(
		attributes.displayWidth ?? attributes.width,
	);
	const [displayHeight, setDisplayHeight] = React.useState<number | undefined>(
		attributes.displayHeight ?? attributes.height,
	);
	const [lockAspectRatio, setLockAspectRatio] = React.useState(true);
	const [alignment, setAlignment] = React.useState<ImageAttributes["alignment"]>(
		attributes.alignment,
	);
	const nodeKey = attributes.nodeKey;

	React.useEffect(() => {
		setAlt(attributes.alt ?? "");
		setCaption(attributes.caption ?? "");
		setTitle(attributes.title ?? "");
		setAsset(attributes);
		setDisplayWidth(attributes.displayWidth ?? attributes.width);
		setDisplayHeight(attributes.displayHeight ?? attributes.height);
		setLockAspectRatio(true);
		setAlignment(attributes.alignment);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the node token identifies a new attribute snapshot
	}, [nodeKey]);

	// Calculate aspect ratio from original dimensions
	const aspectRatio = asset.width && asset.height ? asset.width / asset.height : undefined;

	const handleWidthChange = (value: string) => {
		const newWidth = value ? parseInt(value, 10) : undefined;
		setDisplayWidth(newWidth);
		if (lockAspectRatio && aspectRatio && newWidth) {
			setDisplayHeight(Math.round(newWidth / aspectRatio));
		}
	};

	const handleHeightChange = (value: string) => {
		const newHeight = value ? parseInt(value, 10) : undefined;
		setDisplayHeight(newHeight);
		if (lockAspectRatio && aspectRatio && newHeight) {
			setDisplayWidth(Math.round(newHeight * aspectRatio));
		}
	};

	const handleResetDimensions = () => {
		setDisplayWidth(asset.width);
		setDisplayHeight(asset.height);
	};

	const handleMediaSelect = (item: MediaItem) => {
		onReplace({
			src: item.url,
			alt: item.alt || item.filename,
			mediaId: item.id,
			provider: canonicalMediaProviderId(item.provider),
			width: item.width,
			height: item.height,
			blurhash: item.blurhash,
			dominantColor: item.dominantColor,
			// Clear caption/title since it's a new image
			caption: undefined,
			title: undefined,
		});
		setShowMediaPicker(false);
		onClose();
	};

	// Track if form has unsaved changes
	const hasChanges = React.useMemo(() => {
		const originalDisplayWidth = attributes.displayWidth ?? asset.width;
		const originalDisplayHeight = attributes.displayHeight ?? asset.height;
		return (
			alt !== (attributes.alt ?? "") ||
			caption !== (attributes.caption ?? "") ||
			title !== (attributes.title ?? "") ||
			displayWidth !== originalDisplayWidth ||
			displayHeight !== originalDisplayHeight ||
			alignment !== attributes.alignment
		);
	}, [
		asset.height,
		asset.width,
		attributes,
		alt,
		caption,
		title,
		displayWidth,
		displayHeight,
		alignment,
	]);

	const handleSave = () => {
		onUpdate({
			alt: alt || undefined,
			caption: caption || undefined,
			title: title || undefined,
			displayWidth,
			displayHeight,
			alignment,
		});
		onClose();
	};

	const alignmentOptions: { value: ImageAttributes["alignment"]; label: string }[] = [
		{ value: undefined, label: t`None` },
		{ value: "left", label: t`Left` },
		{ value: "center", label: t`Center` },
		{ value: "right", label: t`Right` },
		{ value: "wide", label: t`Wide` },
		{ value: "full", label: t`Full` },
	];

	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
	const canEditAsset = Boolean(
		asset.mediaId && canonicalMediaProviderId(asset.provider) === "local",
	);
	const imageActions = (
		<div className="mt-3 flex flex-wrap items-center gap-2">
			<Button
				variant="secondary"
				size="sm"
				icon={<ImageSquare aria-hidden="true" />}
				onClick={() => setShowMediaPicker(true)}
				disabled={assetEditor.isActive}
			>
				{t`Replace`}
			</Button>
			{canEditAsset && (
				<Button
					variant="secondary"
					size="sm"
					icon={<PencilSimple aria-hidden="true" />}
					loading={assetEditor.isOpening}
					onClick={(event) => void assetEditor.openAssetEditor(asset.mediaId!, event.currentTarget)}
				>
					{t`Edit asset`}
				</Button>
			)}
		</div>
	);

	const handleDelete = () => {
		setShowDeleteConfirm(true);
	};

	const stableOnClose = useStableCallback(onClose);
	const stableHandleSave = useStableCallback(handleSave);

	// Handle keyboard shortcuts
	React.useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const saveShortcut = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s";
			if (showDeleteConfirm || showMediaPicker || assetEditor.isActive) {
				if (saveShortcut) e.preventDefault();
				return;
			}
			if (e.key === "Escape") {
				stableOnClose();
			}
			if (saveShortcut) {
				e.preventDefault();
				stableHandleSave();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [assetEditor.isActive, showDeleteConfirm, showMediaPicker, stableOnClose, stableHandleSave]);

	const dialogs = (
		<>
			<ConfirmDialog
				open={showDeleteConfirm}
				onClose={() => setShowDeleteConfirm(false)}
				title={t`Remove image?`}
				description={t`Remove this image from the document?`}
				confirmLabel={t`Remove`}
				pendingLabel={t`Removing...`}
				isPending={false}
				error={null}
				onConfirm={() => {
					onDelete();
					onClose();
				}}
			/>
			<MediaPickerModal
				open={showMediaPicker}
				onOpenChange={setShowMediaPicker}
				onSelect={handleMediaSelect}
				mimeTypeFilter="image/"
				title={t`Replace image`}
				confirmLabel={t`Replace`}
			/>
			{assetEditor.dialog}
		</>
	);

	if (inline) {
		return (
			<div className="rounded-lg border bg-kumo-base flex flex-col">
				{/* Header */}
				<div className="flex items-center justify-between p-4 border-b">
					<div className="flex items-center gap-2">
						<SlidersHorizontal className="h-4 w-4 text-kumo-subtle" />
						<h3 className="text-sm font-semibold">{t`Image Settings`}</h3>
					</div>
					<Button variant="ghost" shape="square" aria-label={t`Close`} onClick={onClose}>
						<X className="h-4 w-4" />
						<span className="sr-only">{t`Close`}</span>
					</Button>
				</div>

				{/* Preview */}
				<div className="p-4 border-b">
					<div className="emdash-media-transparency-grid relative flex aspect-video items-center justify-center overflow-hidden rounded-lg">
						<img
							src={asset.src}
							alt={attributes.alt || ""}
							className="max-h-full max-w-full object-contain"
						/>
					</div>
					{imageActions}
					{assetEditor.error && (
						<p role="alert" className="mt-2 text-sm text-kumo-danger">
							{assetEditor.error}
						</p>
					)}

					{/* Original dimensions */}
					{(asset.width || asset.height) && (
						<div className="flex items-center gap-2 text-sm mt-3">
							<Ruler className="h-4 w-4 text-kumo-subtle" />
							<span className="text-kumo-subtle">{t`Original:`}</span>
							<span>
								{asset.width} × {asset.height}
							</span>
						</div>
					)}
				</div>

				{/* Display Size — shown for any image; migrated images may lack original dims */}
				{asset.src && (
					<div className="p-4 border-b space-y-3">
						<div className="flex items-center justify-between">
							<Label>{t`Display Size`}</Label>
							{asset.width && asset.height && (
								<Button
									variant="ghost"
									size="sm"
									onClick={handleResetDimensions}
									className="h-auto py-1 px-2 text-xs"
								>
									{t`Reset to original`}
								</Button>
							)}
						</div>
						<div className="flex items-center gap-2">
							<div className="flex-1">
								<Input
									label={t`Width`}
									type="number"
									value={displayWidth ?? ""}
									onChange={(e) => handleWidthChange(e.target.value)}
								/>
							</div>
							{aspectRatio && (
								<Button
									variant="ghost"
									shape="square"
									className="mt-5"
									onClick={() => setLockAspectRatio(!lockAspectRatio)}
									title={lockAspectRatio ? t`Unlock aspect ratio` : t`Lock aspect ratio`}
									aria-label={lockAspectRatio ? t`Unlock aspect ratio` : t`Lock aspect ratio`}
								>
									{lockAspectRatio ? (
										<LinkSimple className="h-4 w-4" />
									) : (
										<LinkBreak className="h-4 w-4 text-kumo-subtle" />
									)}
								</Button>
							)}
							<div className="flex-1">
								<Input
									label={t`Height`}
									type="number"
									value={displayHeight ?? ""}
									onChange={(e) => handleHeightChange(e.target.value)}
								/>
							</div>
						</div>
						<p className="text-xs text-kumo-subtle">
							{t`Set a custom display size for this image instance.`}
						</p>
					</div>
				)}

				{/* Alignment */}
				{asset.src && (
					<div className="p-4 border-b space-y-3">
						<Label>{t`Alignment`}</Label>
						<div className="flex flex-wrap gap-1">
							{alignmentOptions.map((opt) => (
								<Button
									key={opt.value ?? "none"}
									type="button"
									size="sm"
									variant={alignment === opt.value ? "primary" : "secondary"}
									onClick={() => setAlignment(opt.value)}
								>
									{opt.label}
								</Button>
							))}
						</div>
					</div>
				)}

				{/* Editable Fields */}
				<div className="p-4 space-y-4">
					<Input
						label={t`Alt Text`}
						value={alt}
						onChange={(e) => setAlt(e.target.value)}
						placeholder={t`Describe this image for accessibility`}
						description={t`Required for accessibility. Describes the image for screen readers.`}
					/>

					<InputArea
						label={t`Caption`}
						value={caption}
						onChange={(e) => setCaption(e.target.value)}
						placeholder={t`Optional caption displayed below the image`}
						description={t`Displayed below the image as a visible caption.`}
						rows={2}
					/>

					<Input
						label={t`Title (Tooltip)`}
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder={t`Optional tooltip on hover`}
						description={t`Shown when hovering over the image.`}
					/>

					{/* Source URL - only show for external images (no mediaId) */}
					{!asset.mediaId && asset.src && (
						<div>
							<Label>{t`Source`}</Label>
							<div className="mt-1.5 flex gap-2">
								<Input value={asset.src} readOnly className="text-xs font-mono flex-1" />
								<LinkButton
									variant="outline"
									shape="square"
									href={asset.src}
									external
									title={t`Open in new tab`}
									aria-label={t`Open in new tab`}
								>
									<ArrowSquareOut className="h-4 w-4" />
								</LinkButton>
							</div>
						</div>
					)}
				</div>

				{/* Actions */}
				<div className="p-4 border-t flex items-center justify-between gap-2">
					<Button
						variant="destructive"
						size="sm"
						onClick={handleDelete}
						disabled={assetEditor.isActive}
					>
						{t`Remove`}
					</Button>
					<Button size="sm" onClick={handleSave} disabled={!hasChanges}>
						{t`Save`}
					</Button>
				</div>

				{dialogs}
			</div>
		);
	}

	return (
		<div className="fixed inset-y-0 end-0 w-96 bg-kumo-base border-s shadow-xl z-50 flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between border-b p-4">
				<div className="flex items-center gap-2">
					<SlidersHorizontal className="h-4 w-4 text-kumo-subtle" />
					<h2 className="font-semibold">{t`Image Settings`}</h2>
				</div>
				<Button variant="ghost" shape="square" aria-label={t`Close`} onClick={onClose}>
					<X className="h-4 w-4" />
					<span className="sr-only">{t`Close`}</span>
				</Button>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto">
				{/* Preview */}
				<div className="p-4 border-b">
					<div className="emdash-media-transparency-grid relative flex aspect-video items-center justify-center overflow-hidden rounded-lg">
						<img
							src={asset.src}
							alt={attributes.alt || ""}
							className="max-h-full max-w-full object-contain"
						/>
					</div>
					{imageActions}
					{assetEditor.error && (
						<p role="alert" className="mt-2 text-sm text-kumo-danger">
							{assetEditor.error}
						</p>
					)}
				</div>

				{/* Image Info - original dimensions */}
				{(asset.width || asset.height) && (
					<div className="p-4 border-b">
						<div className="flex items-center gap-2 text-sm">
							<Ruler className="h-4 w-4 text-kumo-subtle" />
							<span className="text-kumo-subtle">{t`Original:`}</span>
							<span>
								{asset.width} × {asset.height}
							</span>
						</div>
					</div>
				)}

				{/* Display Size — shown for any image; migrated images may lack original dims */}
				{asset.src && (
					<div className="p-4 border-b space-y-3">
						<div className="flex items-center justify-between">
							<Label>{t`Display Size`}</Label>
							{asset.width && asset.height && (
								<Button
									variant="ghost"
									size="sm"
									onClick={handleResetDimensions}
									className="h-auto py-1 px-2 text-xs"
								>
									{t`Reset to original`}
								</Button>
							)}
						</div>
						<div className="flex items-center gap-2">
							<div className="flex-1">
								<Input
									label={t`Width`}
									type="number"
									value={displayWidth ?? ""}
									onChange={(e) => handleWidthChange(e.target.value)}
								/>
							</div>
							{aspectRatio && (
								<Button
									variant="ghost"
									shape="square"
									className="mt-5"
									onClick={() => setLockAspectRatio(!lockAspectRatio)}
									title={lockAspectRatio ? t`Unlock aspect ratio` : t`Lock aspect ratio`}
									aria-label={lockAspectRatio ? t`Unlock aspect ratio` : t`Lock aspect ratio`}
								>
									{lockAspectRatio ? (
										<LinkSimple className="h-4 w-4" />
									) : (
										<LinkBreak className="h-4 w-4 text-kumo-subtle" />
									)}
								</Button>
							)}
							<div className="flex-1">
								<Input
									label={t`Height`}
									type="number"
									value={displayHeight ?? ""}
									onChange={(e) => handleHeightChange(e.target.value)}
								/>
							</div>
						</div>
						<p className="text-xs text-kumo-subtle">
							{t`Set a custom display size for this image instance.`}
						</p>
					</div>
				)}

				{/* Alignment */}
				{asset.src && (
					<div className="p-4 border-b space-y-3">
						<Label>{t`Alignment`}</Label>
						<div className="flex flex-wrap gap-1">
							{alignmentOptions.map((opt) => (
								<Button
									key={opt.value ?? "none"}
									type="button"
									size="sm"
									variant={alignment === opt.value ? "primary" : "secondary"}
									onClick={() => setAlignment(opt.value)}
								>
									{opt.label}
								</Button>
							))}
						</div>
					</div>
				)}

				{/* Editable Fields */}
				<div className="p-4 space-y-4">
					<Input
						label={t`Alt Text`}
						value={alt}
						onChange={(e) => setAlt(e.target.value)}
						placeholder={t`Describe this image for accessibility`}
						description={t`Required for accessibility. Describes the image for screen readers.`}
					/>

					<InputArea
						label={t`Caption`}
						value={caption}
						onChange={(e) => setCaption(e.target.value)}
						placeholder={t`Optional caption displayed below the image`}
						description={t`Displayed below the image as a visible caption.`}
						rows={2}
					/>

					<Input
						label={t`Title (Tooltip)`}
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder={t`Optional tooltip on hover`}
						description={t`Shown when hovering over the image.`}
					/>

					{/* Source URL - only show for external images (no mediaId) */}
					{!asset.mediaId && asset.src && (
						<div>
							<Label>{t`Source`}</Label>
							<div className="mt-1.5 flex gap-2">
								<Input value={asset.src} readOnly className="text-xs font-mono flex-1" />
								<LinkButton
									variant="outline"
									shape="square"
									href={asset.src}
									external
									title={t`Open in new tab`}
									aria-label={t`Open in new tab`}
								>
									<ArrowSquareOut className="h-4 w-4" />
								</LinkButton>
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Footer */}
			<div className="p-4 border-t flex items-center justify-between gap-2">
				<Button
					variant="destructive"
					size="sm"
					onClick={handleDelete}
					disabled={assetEditor.isActive}
				>
					{t`Remove`}
				</Button>
				<div className="flex gap-2">
					<Button variant="outline" size="sm" onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button size="sm" onClick={handleSave} disabled={!hasChanges}>
						{t`Save`}
					</Button>
				</div>
			</div>

			{dialogs}
		</div>
	);
}

export default ImageDetailPanel;
