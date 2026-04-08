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
	LinkSimple,
	LinkBreak,
} from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../../lib/api";
import { useStableCallback } from "../../lib/hooks";
import { ConfirmDialog } from "../ConfirmDialog";
import { MediaPickerModal } from "../MediaPickerModal";

export interface ImageAttributes {
	src: string;
	alt?: string;
	title?: string;
	caption?: string;
	mediaId?: string;
	/** Original image width */
	width?: number;
	/** Original image height */
	height?: number;
	/** Display width for this instance (defaults to original) */
	displayWidth?: number;
	/** Display height for this instance (defaults to original) */
	displayHeight?: number;
	/**
	 * CSS classes applied to the rendered figure. Set via the Style section
	 * below from plugin-declared image styles. `null` clears any existing
	 * classes; `undefined` means "no change".
	 */
	cssClasses?: string | null;
}

/** A flattened image-applicable style entry passed to the panel. */
export interface ImageStyleOption {
	label: string;
	classes: string;
}

export interface ImageDetailPanelProps {
	attributes: ImageAttributes;
	onUpdate: (attrs: Partial<ImageAttributes>) => void;
	onReplace: (attrs: ImageAttributes) => void;
	onDelete: () => void;
	onClose: () => void;
	/**
	 * Plugin-declared block-style entries that target images
	 * (`scope: "block"` and `nodes` includes `"image"`). Flattened from the
	 * raw `editorStyles` manifest by the host (typically ContentEditor).
	 * When empty or undefined, the Style section is hidden.
	 */
	imageStyles?: ImageStyleOption[];
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
	imageStyles,
	inline = false,
}: ImageDetailPanelProps) {
	const { t } = useLingui();
	// Form state
	const [alt, setAlt] = React.useState(attributes.alt ?? "");
	const [caption, setCaption] = React.useState(attributes.caption ?? "");
	const [title, setTitle] = React.useState(attributes.title ?? "");
	const [showMediaPicker, setShowMediaPicker] = React.useState(false);

	// Style state — applied immediately on click, kept here so the active state
	// stays accurate without depending on the parent re-passing fresh attrs
	// (the panel's `attributes` prop is a snapshot taken when the sidebar opens).
	const [cssClasses, setCssClasses] = React.useState<string | null>(
		typeof attributes.cssClasses === "string" && attributes.cssClasses.length > 0
			? attributes.cssClasses
			: null,
	);

	const handleStyleClick = (entryClasses: string) => {
		const next = cssClasses === entryClasses ? null : entryClasses;
		setCssClasses(next);
		// Apply immediately so the user sees the visual change in the editor
		// without going through the form's Save button.
		onUpdate({ cssClasses: next });
	};

	// Dimension state - default to display dimensions, fall back to original
	const [displayWidth, setDisplayWidth] = React.useState<number | undefined>(
		attributes.displayWidth ?? attributes.width,
	);
	const [displayHeight, setDisplayHeight] = React.useState<number | undefined>(
		attributes.displayHeight ?? attributes.height,
	);
	const [lockAspectRatio, setLockAspectRatio] = React.useState(true);

	// Calculate aspect ratio from original dimensions
	const aspectRatio =
		attributes.width && attributes.height ? attributes.width / attributes.height : undefined;

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
		setDisplayWidth(attributes.width);
		setDisplayHeight(attributes.height);
	};

	const handleMediaSelect = (item: MediaItem) => {
		onReplace({
			src: item.url,
			alt: item.alt || item.filename,
			mediaId: item.id,
			width: item.width,
			height: item.height,
			// Clear caption/title since it's a new image
			caption: undefined,
			title: undefined,
		});
		setShowMediaPicker(false);
		onClose();
	};

	// Track if form has unsaved changes
	const hasChanges = React.useMemo(() => {
		const originalDisplayWidth = attributes.displayWidth ?? attributes.width;
		const originalDisplayHeight = attributes.displayHeight ?? attributes.height;
		return (
			alt !== (attributes.alt ?? "") ||
			caption !== (attributes.caption ?? "") ||
			title !== (attributes.title ?? "") ||
			displayWidth !== originalDisplayWidth ||
			displayHeight !== originalDisplayHeight
		);
	}, [attributes, alt, caption, title, displayWidth, displayHeight]);

	const handleSave = () => {
		onUpdate({
			alt: alt || undefined,
			caption: caption || undefined,
			title: title || undefined,
			displayWidth,
			displayHeight,
		});
		onClose();
	};

	const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);

	const handleDelete = () => {
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

	const styleSection =
		imageStyles && imageStyles.length > 0 ? (
			<div className="p-4 border-b space-y-3">
				<Label>Style</Label>
				<div className="flex flex-wrap gap-2">
					{imageStyles.map((entry) => {
						const active = cssClasses === entry.classes;
						return (
							<Button
								key={`${entry.label}-${entry.classes}`}
								type="button"
								variant={active ? "default" : "outline"}
								size="sm"
								onClick={() => handleStyleClick(entry.classes)}
								aria-pressed={active}
							>
								{entry.label}
							</Button>
						);
					})}
				</div>
				<p className="text-xs text-kumo-subtle">
					Pick a style to apply CSS classes from your plugins. Click again to clear.
				</p>
			</div>
		) : null;

	const dialogs = (
		<>
			<ConfirmDialog
				open={showDeleteConfirm}
				onClose={() => setShowDeleteConfirm(false)}
				title={t`Remove Image?`}
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
				title={t`Replace Image`}
			/>
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
					<div className="aspect-video bg-kumo-tint rounded-lg overflow-hidden flex items-center justify-center relative group">
						<img
							src={attributes.src}
							alt={attributes.alt || ""}
							className="max-h-full max-w-full object-contain"
						/>
						<div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
							<Button
								variant="secondary"
								size="sm"
								icon={<ImageSquare />}
								onClick={() => setShowMediaPicker(true)}
							>
								{t`Replace Image`}
							</Button>
						</div>
					</div>

					{/* Original dimensions */}
					{(attributes.width || attributes.height) && (
						<div className="flex items-center gap-2 text-sm mt-3">
							<Ruler className="h-4 w-4 text-kumo-subtle" />
							<span className="text-kumo-subtle">{t`Original:`}</span>
							<span>
								{attributes.width} × {attributes.height}
							</span>
						</div>
					)}
				</div>

				{/* Display Size */}
				{attributes.width && attributes.height && (
					<div className="p-4 border-b space-y-3">
						<div className="flex items-center justify-between">
							<Label>{t`Display Size`}</Label>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleResetDimensions}
								className="h-auto py-1 px-2 text-xs"
							>
								{t`Reset to original`}
							</Button>
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

				{styleSection}

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
					{!attributes.mediaId && attributes.src && (
						<div>
							<Label>{t`Source`}</Label>
							<div className="mt-1.5 flex gap-2">
								<Input value={attributes.src} readOnly className="text-xs font-mono flex-1" />
								<LinkButton
									variant="outline"
									shape="square"
									href={attributes.src}
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
					<Button variant="destructive" size="sm" onClick={handleDelete}>
						{t`Remove Image`}
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
					<div className="aspect-video bg-kumo-tint rounded-lg overflow-hidden flex items-center justify-center relative group">
						<img
							src={attributes.src}
							alt={attributes.alt || ""}
							className="max-h-full max-w-full object-contain"
						/>
						<div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
							<Button
								variant="secondary"
								size="sm"
								icon={<ImageSquare />}
								onClick={() => setShowMediaPicker(true)}
							>
								{t`Replace Image`}
							</Button>
						</div>
					</div>
				</div>

				{/* Image Info - original dimensions */}
				{(attributes.width || attributes.height) && (
					<div className="p-4 border-b">
						<div className="flex items-center gap-2 text-sm">
							<Ruler className="h-4 w-4 text-kumo-subtle" />
							<span className="text-kumo-subtle">{t`Original:`}</span>
							<span>
								{attributes.width} × {attributes.height}
							</span>
						</div>
					</div>
				)}

				{/* Display Size */}
				{attributes.width && attributes.height && (
					<div className="p-4 border-b space-y-3">
						<div className="flex items-center justify-between">
							<Label>{t`Display Size`}</Label>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleResetDimensions}
								className="h-auto py-1 px-2 text-xs"
							>
								{t`Reset to original`}
							</Button>
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

				{styleSection}

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
					{!attributes.mediaId && attributes.src && (
						<div>
							<Label>{t`Source`}</Label>
							<div className="mt-1.5 flex gap-2">
								<Input value={attributes.src} readOnly className="text-xs font-mono flex-1" />
								<LinkButton
									variant="outline"
									shape="square"
									href={attributes.src}
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
				<Button variant="destructive" size="sm" onClick={handleDelete}>
					{t`Remove Image`}
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
