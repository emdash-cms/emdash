/**
 * Image Detail Panel for Editor
 *
 * A slide-out panel for editing image properties in the rich text editor.
 * Shows preview and allows editing alt text, caption, and link settings.
 */

import { Button, Input, InputArea, Label, LinkButton, Select, Text } from "@cloudflare/kumo";
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
import { cn } from "../../lib/utils.js";
import { ConfirmDialog } from "../ConfirmDialog";
import { FieldHelpLabel } from "../FieldHelpLabel.js";
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
	inlineClassName?: string;
	stickyFooter?: boolean;
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
	inlineClassName,
	stickyFooter = false,
	inline = false,
}: ImageDetailPanelProps) {
	const { t } = useLingui();
	const altInputId = React.useId();
	const sourceInputId = React.useId();
	const closeLabel = t`Close image settings`;
	// Form state
	const [alt, setAlt] = React.useState(attributes.alt ?? "");
	const [caption, setCaption] = React.useState(attributes.caption ?? "");
	const [title, setTitle] = React.useState(attributes.title ?? "");
	const [showMediaPicker, setShowMediaPicker] = React.useState(false);
	const [asset, setAsset] = React.useState(attributes);
	const handleAssetItemChanged = React.useCallback(
		(item: MediaItem) => {
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
		[onUpdate],
	);
	const assetEditor = useMediaAssetEditor(handleAssetItemChanged);

	const [hasCustomSize, setHasCustomSize] = React.useState(
		attributes.displayWidth != null || attributes.displayHeight != null,
	);
	const [displayWidth, setDisplayWidth] = React.useState<number | undefined>(
		attributes.displayWidth ?? undefined,
	);
	const [displayHeight, setDisplayHeight] = React.useState<number | undefined>(
		attributes.displayHeight ?? undefined,
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
		setHasCustomSize(attributes.displayWidth != null || attributes.displayHeight != null);
		setDisplayWidth(attributes.displayWidth ?? undefined);
		setDisplayHeight(attributes.displayHeight ?? undefined);
		setLockAspectRatio(true);
		setAlignment(attributes.alignment);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- the node token identifies a new attribute snapshot
	}, [nodeKey]);

	// Calculate aspect ratio from original dimensions
	const aspectRatio = asset.width && asset.height ? asset.width / asset.height : undefined;

	const handleWidthChange = (value: string) => {
		setHasCustomSize(true);
		const newWidth = value ? parseInt(value, 10) : undefined;
		setDisplayWidth(newWidth);
		if (lockAspectRatio && aspectRatio && newWidth) {
			setDisplayHeight(Math.round(newWidth / aspectRatio));
		} else if (!hasCustomSize) {
			setDisplayHeight(asset.height);
		}
	};

	const handleHeightChange = (value: string) => {
		setHasCustomSize(true);
		const newHeight = value ? parseInt(value, 10) : undefined;
		setDisplayHeight(newHeight);
		if (lockAspectRatio && aspectRatio && newHeight) {
			setDisplayWidth(Math.round(newHeight * aspectRatio));
		} else if (!hasCustomSize) {
			setDisplayWidth(asset.width);
		}
	};

	const handleResetDimensions = () => {
		setHasCustomSize(false);
		setDisplayWidth(undefined);
		setDisplayHeight(undefined);
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
		const originalDisplayWidth = attributes.displayWidth ?? undefined;
		const originalDisplayHeight = attributes.displayHeight ?? undefined;
		return (
			alt !== (attributes.alt ?? "") ||
			caption !== (attributes.caption ?? "") ||
			title !== (attributes.title ?? "") ||
			displayWidth !== originalDisplayWidth ||
			displayHeight !== originalDisplayHeight ||
			alignment !== attributes.alignment
		);
	}, [attributes, alt, caption, title, displayWidth, displayHeight, alignment]);

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
	const selectableAlignmentOptions = alignmentOptions.filter(
		(option) => option.value !== "wide" && option.value !== "full",
	);

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
				if (!inline || hasChanges) stableHandleSave();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [
		assetEditor.isActive,
		hasChanges,
		inline,
		showDeleteConfirm,
		showMediaPicker,
		stableOnClose,
		stableHandleSave,
	]);

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
			<div
				className={cn(
					"flex min-w-0 flex-col whitespace-normal rounded-lg border bg-kumo-base",
					inlineClassName,
				)}
			>
				{/* Header */}
				<div className="flex items-center justify-between border-b px-4 py-3">
					<div className="flex items-center gap-2">
						<Text bold as="h3">
							{t`Image settings`}
						</Text>
					</div>
					<Button variant="ghost" shape="square" aria-label={closeLabel} onClick={onClose}>
						<X className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>

				{/* Preview */}
				<div className="p-4 border-b">
					<div className="emdash-media-transparency-grid relative flex aspect-video items-center justify-center overflow-hidden rounded-lg ring-1 ring-kumo-line">
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
						<Text size="sm" variant="secondary" DANGEROUS_className="mt-3 flex items-center gap-2">
							<Ruler className="size-4" aria-hidden="true" />
							<span className="text-kumo-subtle">{t`Original:`}</span>
							<span className="tabular-nums text-kumo-default">
								{asset.width} × {asset.height}
							</span>
						</Text>
					)}
				</div>

				{/* Display Size — shown for any image; migrated images may lack original dims */}
				{asset.src && (
					<div className="p-4 border-b space-y-4">
						<div className="flex items-center justify-between gap-2">
							<FieldHelpLabel
								help={
									<span className="block max-w-64 text-pretty">
										{t`Set a custom width and height for this image in the document. Reset uses the original media dimensions. The original media file is unchanged.`}
									</span>
								}
								helpLabel={t`More information about Display size`}
							>
								{t`Display size`}
							</FieldHelpLabel>
							{asset.width && asset.height && (
								<Button variant="ghost" size="sm" onClick={handleResetDimensions}>
									{t`Reset`}
								</Button>
							)}
						</div>
						<div className="flex min-w-0 items-end gap-2" role="group" aria-label={t`Display size`}>
							<div className="min-w-0 flex-1">
								<Input
									label={t`Width`}
									type="number"
									value={(hasCustomSize ? displayWidth : asset.width) ?? ""}
									onChange={(e) => handleWidthChange(e.target.value)}
									className="w-full min-w-0"
								/>
							</div>
							{aspectRatio && (
								<Button
									variant="ghost"
									shape="square"
									onClick={() => setLockAspectRatio(!lockAspectRatio)}
									title={t`Keep aspect ratio`}
									aria-label={t`Keep aspect ratio`}
									aria-pressed={lockAspectRatio}
								>
									{lockAspectRatio ? (
										<LinkSimple className="h-4 w-4" aria-hidden="true" />
									) : (
										<LinkBreak className="h-4 w-4 text-kumo-subtle" aria-hidden="true" />
									)}
								</Button>
							)}
							<div className="min-w-0 flex-1">
								<Input
									label={t`Height`}
									type="number"
									value={(hasCustomSize ? displayHeight : asset.height) ?? ""}
									onChange={(e) => handleHeightChange(e.target.value)}
									className="w-full min-w-0"
								/>
							</div>
						</div>
						<Select
							label={t`Alignment`}
							value={alignment ?? "none"}
							onValueChange={(value) =>
								setAlignment(value === "none" ? undefined : (value as ImageAttributes["alignment"]))
							}
							renderValue={(value) =>
								alignmentOptions.find((option) => (option.value ?? "none") === value)?.label
							}
							className="w-full"
						>
							{selectableAlignmentOptions.map((option) => (
								<Select.Option key={option.value ?? "none"} value={option.value ?? "none"}>
									{option.label}
								</Select.Option>
							))}
						</Select>
					</div>
				)}

				{/* Editable Fields */}
				<div className="p-4 space-y-4 border-b">
					<div className="space-y-1.5">
						<FieldHelpLabel
							htmlFor={altInputId}
							help={
								<span className="block max-w-64 text-pretty">
									{t`Describe the image's purpose and relevant details for people who cannot see it.`}
								</span>
							}
							helpLabel={t`More information about Alt text`}
						>
							{t`Alt text`}
						</FieldHelpLabel>
						<Input
							id={altInputId}
							aria-label={t`Alt text`}
							value={alt}
							onChange={(e) => setAlt(e.target.value)}
							placeholder={t`Describe the image`}
							className="w-full"
						/>
					</div>

					<InputArea
						label={t`Caption`}
						value={caption}
						onChange={(e) => setCaption(e.target.value)}
						placeholder={t`Optional caption`}
						rows={2}
					/>

					<Input
						label={t`Tooltip text`}
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder={t`Optional hover text`}
					/>

					{/* Source URL - only show for external images (no mediaId) */}
					{!asset.mediaId && asset.src && (
						<div>
							<Label htmlFor={sourceInputId}>{t`Source`}</Label>
							<div className="mt-1.5 flex min-w-0 gap-2">
								<Input
									id={sourceInputId}
									aria-label={t`Source`}
									value={asset.src}
									readOnly
									className="min-w-0 flex-1 font-mono text-xs"
								/>
								<LinkButton
									variant="outline"
									shape="square"
									href={asset.src}
									external
									title={t`Open in new tab`}
									aria-label={t`Open in new tab`}
								>
									<ArrowSquareOut className="h-4 w-4" aria-hidden="true" />
								</LinkButton>
							</div>
						</div>
					)}
				</div>

				{/* Actions */}
				<div className="p-4">
					<Button
						variant="secondary-destructive"
						className="w-full hover:bg-kumo-danger/10"
						onClick={handleDelete}
						disabled={assetEditor.isActive}
					>
						{t`Remove image`}
					</Button>
				</div>

				<div
					className={cn(
						"flex items-center justify-end gap-2 border-t bg-kumo-base px-4 py-3",
						stickyFooter && "sticky bottom-0 z-10",
					)}
				>
					<Button variant="outline" onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button variant="primary" onClick={handleSave} disabled={!hasChanges}>
						{t`Apply`}
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
						<div className="flex items-end gap-2">
							<div className="min-w-0 flex-1">
								<Input
									label={t`Width`}
									type="number"
									value={(hasCustomSize ? displayWidth : asset.width) ?? ""}
									onChange={(e) => handleWidthChange(e.target.value)}
									className="w-full min-w-0"
								/>
							</div>
							{aspectRatio && (
								<Button
									variant="ghost"
									shape="square"
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
							<div className="min-w-0 flex-1">
								<Input
									label={t`Height`}
									type="number"
									value={(hasCustomSize ? displayHeight : asset.height) ?? ""}
									onChange={(e) => handleHeightChange(e.target.value)}
									className="w-full min-w-0"
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
							{selectableAlignmentOptions.map((opt) => (
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
							<div className="mt-1.5 flex min-w-0 gap-2">
								<Input value={asset.src} readOnly className="min-w-0 flex-1 font-mono text-xs" />
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
