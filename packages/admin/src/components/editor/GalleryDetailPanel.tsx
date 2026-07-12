/**
 * Gallery Detail Panel for Editor
 *
 * Sidebar panel for editing a gallery block: add images (multi-select media
 * picker), remove, drag-and-drop reorder, per-image alt/caption, and column
 * count. Changes apply immediately via onUpdate (reordering is inherently
 * live, so the whole panel follows suit instead of a save-button form).
 */

import { Button, Input, Label, Select } from "@cloudflare/kumo";
import { DndContext, closestCenter } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	verticalListSortingStrategy,
	useSortable,
	arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import { X, Plus, Trash, DotsSixVertical, ImageSquare, CaretDown } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../../lib/api";
import { cn } from "../../lib/utils";
import { CaretNext } from "../ArrowIcons.js";
import { MediaPickerModal } from "../MediaPickerModal";
import { galleryImageUrl, type GalleryAttributes, type GalleryImage } from "./GalleryNode";

export interface GalleryDetailPanelProps {
	attributes: GalleryAttributes;
	onUpdate: (attrs: Partial<GalleryAttributes>) => void;
	onDelete: () => void;
	onClose: () => void;
	/** When true, renders inline within the sidebar column instead of as a fixed overlay */
	inline?: boolean;
}

function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}

/** Map a picked MediaItem to the gallery's Portable Text image shape. */
export function mediaItemToGalleryImage(item: MediaItem): GalleryImage {
	return {
		_type: "image",
		_key: generateKey(),
		asset: { _ref: item.id, url: item.url },
		alt: item.alt || "",
		width: item.width,
		height: item.height,
	};
}

export function GalleryDetailPanel({
	attributes,
	onUpdate,
	onDelete,
	onClose,
	inline = false,
}: GalleryDetailPanelProps) {
	const { t } = useLingui();
	const [showMediaPicker, setShowMediaPicker] = React.useState(false);

	// `attributes` is a snapshot taken when the sidebar opened; it does not
	// refresh after onUpdate. Local state is the live source of truth while
	// the panel is open so sequential edits (caption, then reorder) compose
	// instead of the later edit clobbering the earlier one.
	const [gallery, setGallery] = React.useState<GalleryAttributes>({
		images: attributes.images ?? [],
		columns: attributes.columns,
	});
	const images = gallery.images;
	const columns = gallery.columns ?? 3;

	const apply = (patch: Partial<GalleryAttributes>) => {
		setGallery((prev) => ({ ...prev, ...patch }));
		onUpdate(patch);
	};

	const handleAdd = (items: MediaItem[]) => {
		apply({ images: [...images, ...items.map(mediaItemToGalleryImage)] });
	};

	const handleRemove = (key: string) => {
		apply({ images: images.filter((image) => image._key !== key) });
	};

	const handleImageChange = (key: string, patch: Partial<GalleryImage>) => {
		apply({
			images: images.map((image) => (image._key === key ? { ...image, ...patch } : image)),
		});
	};

	const handleReplace = (key: string, item: MediaItem) => {
		// Keep the slot (key, caption) — swap the asset and its intrinsic data
		apply({
			images: images.map((image) =>
				image._key === key
					? {
							...image,
							asset: { _ref: item.id, url: item.url },
							alt: item.alt || "",
							width: item.width,
							height: item.height,
						}
					: image,
			),
		});
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const oldIndex = images.findIndex((image) => image._key === active.id);
		const newIndex = images.findIndex((image) => image._key === over.id);
		if (oldIndex === -1 || newIndex === -1) return;
		apply({ images: arrayMove(images, oldIndex, newIndex) });
	};

	const body = (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-semibold">{t`Gallery`}</h3>
				<Button
					type="button"
					variant="ghost"
					shape="square"
					className="h-8 w-8"
					onClick={onClose}
					aria-label={t`Close gallery settings`}
				>
					<X className="h-4 w-4" />
				</Button>
			</div>

			<Select
				label={t`Columns`}
				value={String(columns)}
				onValueChange={(v) => apply({ columns: v ? parseInt(v, 10) : undefined })}
				items={{ "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6" }}
			/>

			<div className="flex items-center justify-between">
				<Label>{t`Images`}</Label>
				<Button
					type="button"
					variant="outline"
					size="sm"
					icon={<Plus />}
					onClick={() => setShowMediaPicker(true)}
				>
					{t`Add Images`}
				</Button>
			</div>

			{images.length === 0 ? (
				<p className="text-sm text-kumo-subtle text-center py-4">{t`No images in this gallery yet.`}</p>
			) : (
				<DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext
						items={images.map((image) => image._key)}
						strategy={verticalListSortingStrategy}
					>
						<div className="space-y-2">
							{images.map((image, index) => (
								<SortableGalleryRow
									key={image._key}
									image={image}
									index={index}
									onChange={(patch) => handleImageChange(image._key, patch)}
									onReplace={(item) => handleReplace(image._key, item)}
									onRemove={() => handleRemove(image._key)}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
			)}

			<Button type="button" variant="destructive" className="w-full" onClick={onDelete}>
				{t`Delete gallery`}
			</Button>

			<MediaPickerModal
				open={showMediaPicker}
				onOpenChange={setShowMediaPicker}
				multiple
				onSelect={() => {}}
				onSelectMany={handleAdd}
				mimeTypeFilters={["image/"]}
				title={t`Add images to gallery`}
			/>
		</div>
	);

	if (inline) {
		return body;
	}

	return (
		<div className="fixed inset-y-0 end-0 w-96 max-w-full bg-kumo-base border-s shadow-lg z-50 overflow-y-auto p-4">
			{body}
		</div>
	);
}

interface SortableGalleryRowProps {
	image: GalleryImage;
	index: number;
	onChange: (patch: Partial<GalleryImage>) => void;
	onReplace: (item: MediaItem) => void;
	onRemove: () => void;
}

function SortableGalleryRow({
	image,
	index,
	onChange,
	onReplace,
	onRemove,
}: SortableGalleryRowProps) {
	const { t } = useLingui();
	const [showReplacePicker, setShowReplacePicker] = React.useState(false);
	const [expanded, setExpanded] = React.useState(false);
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: image._key,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	const hasOriginalSize = typeof image.width === "number" && typeof image.height === "number";

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"border rounded-lg bg-kumo-base",
				isDragging && "opacity-50 ring-2 ring-kumo-brand",
			)}
		>
			{/* Header — click to expand per-image settings */}
			<div
				className="flex items-center gap-2 px-2 py-2 cursor-pointer"
				onClick={() => setExpanded((prev) => !prev)}
			>
				<DotsSixVertical
					className="h-4 w-4 text-kumo-subtle cursor-grab shrink-0"
					{...attributes}
					{...listeners}
					onClick={(e: React.MouseEvent) => e.stopPropagation()}
				/>
				{expanded ? (
					<CaretDown className="h-3.5 w-3.5 text-kumo-subtle shrink-0" />
				) : (
					<CaretNext className="h-3.5 w-3.5 text-kumo-subtle shrink-0" />
				)}
				<img
					src={galleryImageUrl(image)}
					alt={image.alt || ""}
					className="h-10 w-10 shrink-0 rounded-md border object-cover"
					draggable={false}
				/>
				<span className="text-xs text-kumo-subtle flex-1 truncate">
					{image.alt || image.caption || image.asset._ref || t`Untitled image`}
				</span>
				<Button
					type="button"
					variant="ghost"
					shape="square"
					className="h-8 w-8"
					onClick={(e) => {
						e.stopPropagation();
						onRemove();
					}}
					aria-label={t`Remove image ${index + 1}`}
				>
					<Trash className="h-3.5 w-3.5 text-kumo-danger" />
				</Button>
			</div>

			{/* Expanded per-image settings — mirrors the single-image panel */}
			{expanded && (
				<div className="px-2 pb-2 space-y-3 border-t pt-2">
					<div className="aspect-video bg-kumo-tint rounded-lg overflow-hidden flex items-center justify-center relative group">
						<img
							src={galleryImageUrl(image)}
							alt={image.alt || ""}
							className="max-h-full max-w-full object-contain"
							draggable={false}
						/>
						<div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
							<Button
								type="button"
								variant="outline"
								size="sm"
								icon={<ImageSquare />}
								onClick={() => setShowReplacePicker(true)}
							>
								{t`Replace image`}
							</Button>
						</div>
					</div>
					{hasOriginalSize && (
						<div className="flex items-center gap-2 text-sm">
							<span className="text-kumo-subtle">{t`Original:`}</span>
							<span>
								{image.width} × {image.height}
							</span>
						</div>
					)}
					<Input
						label={t`Alt text`}
						value={image.alt ?? ""}
						onChange={(e) => onChange({ alt: e.target.value })}
						placeholder={t`Describe the image...`}
					/>
					<Input
						label={t`Caption`}
						value={image.caption ?? ""}
						onChange={(e) => onChange({ caption: e.target.value || undefined })}
						placeholder={t`Optional caption`}
					/>
				</div>
			)}

			<MediaPickerModal
				open={showReplacePicker}
				onOpenChange={setShowReplacePicker}
				onSelect={(item) => {
					onReplace(item);
					setShowReplacePicker(false);
				}}
				mimeTypeFilters={["image/"]}
				title={t`Replace image`}
			/>
		</div>
	);
}
