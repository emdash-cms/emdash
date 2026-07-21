/**
 * Gallery Detail Panel for Editor
 *
 * Sidebar panel for editing a gallery block: add images (multi-select media
 * picker), remove, drag-and-drop reorder, per-image alt/caption, and column
 * count. Changes apply immediately via onUpdate (reordering is inherently
 * live, so the whole panel follows suit instead of a save-button form).
 */

import { Button, Input, Label, Select } from "@cloudflare/kumo";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import { X, Plus, Trash, ImageSquare } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../../lib/api";
import { metaString } from "../../lib/media-utils";
import { cn } from "../../lib/utils";
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
		asset: {
			_type: "reference",
			_ref: item.id,
			url: item.url,
			provider: item.provider && item.provider !== "local" ? item.provider : undefined,
		},
		alt: item.alt || "",
		width: item.width,
		height: item.height,
		// Cache LQIP alongside dimensions so the gallery renders a placeholder
		// without a runtime lookup. Fall back to `meta` for providers that
		// stash it there — mirrors ImageFieldRenderer's handleSelect.
		blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
		dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
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
	// A distance-based activation constraint lets a plain pointerdown+pointerup
	// (a click) pass through to the thumbnail button's onClick instead of the
	// sensor immediately claiming the pointer and starting drag tracking.
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
	const [showMediaPicker, setShowMediaPicker] = React.useState(false);
	// `selectedImageKey` and `nodeKey` are transient UI state passed in via
	// `attributes` when the gallery node view opens the sidebar (e.g. clicking
	// an image in the canvas grid) — neither is ever persisted to node attrs.
	const selectedImageKey = (attributes as GalleryAttributes & { selectedImageKey?: string })
		.selectedImageKey;
	const nodeKey = (attributes as GalleryAttributes & { nodeKey?: string }).nodeKey;
	const [selectedKey, setSelectedKey] = React.useState<string | null>(selectedImageKey ?? null);

	// The panel component instance is reused (not remounted) while the
	// sidebar stays open, so clicking a different image in the canvas grid
	// must update the selection even though `selectedKey` state already exists.
	React.useEffect(() => {
		if (selectedImageKey != null) {
			setSelectedKey(selectedImageKey);
		}
	}, [selectedImageKey]);

	// `attributes` is a snapshot taken when the sidebar opened; it does not
	// refresh after onUpdate. Local state is the live source of truth while
	// the panel is open so sequential edits (caption, then reorder) compose
	// instead of the later edit clobbering the earlier one.
	const [gallery, setGallery] = React.useState<GalleryAttributes>({
		images: attributes.images ?? [],
		columns: attributes.columns,
	});

	// Resync local state only when `nodeKey` changes — i.e. the sidebar switched
	// to a DIFFERENT gallery node (or opened for the first time). `attributes`
	// is a snapshot taken when the sidebar opened; a parent re-render can give
	// it a new object identity without the underlying node changing (e.g. a
	// parent re-wrapping attrs), and resyncing on identity alone would clobber
	// in-progress local edits with that stale snapshot.
	React.useEffect(() => {
		setGallery({ images: attributes.images ?? [], columns: attributes.columns });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on nodeKey by design; see comment above
	}, [nodeKey]);
	const images = gallery.images;
	const columns = gallery.columns ?? 3;
	const selectedImage = selectedKey
		? (images.find((image) => image._key === selectedKey) ?? null)
		: null;

	const apply = (patch: Partial<GalleryAttributes>) => {
		setGallery((prev) => ({ ...prev, ...patch }));
		onUpdate(patch);
	};

	const handleAdd = (items: MediaItem[]) => {
		apply({ images: [...images, ...items.map(mediaItemToGalleryImage)] });
	};

	const handleRemove = (key: string) => {
		apply({ images: images.filter((image) => image._key !== key) });
		setSelectedKey((prev) => (prev === key ? null : prev));
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
							asset: {
								_type: "reference",
								_ref: item.id,
								url: item.url,
								provider: item.provider && item.provider !== "local" ? item.provider : undefined,
							},
							alt: item.alt || "",
							width: item.width,
							height: item.height,
							blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
							dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
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
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext items={images.map((image) => image._key)} strategy={rectSortingStrategy}>
						<div className="grid grid-cols-3 gap-2">
							{images.map((image, index) => (
								<SortableGalleryThumb
									key={image._key}
									image={image}
									index={index}
									selected={selectedKey === image._key}
									onSelect={() =>
										setSelectedKey((prev) => (prev === image._key ? null : image._key))
									}
									onRemove={() => handleRemove(image._key)}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
			)}

			{selectedImage && (
				<GalleryImageSettings
					key={selectedImage._key}
					image={selectedImage}
					onChange={(patch) => handleImageChange(selectedImage._key, patch)}
					onReplace={(item) => handleReplace(selectedImage._key, item)}
				/>
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

interface SortableGalleryThumbProps {
	image: GalleryImage;
	index: number;
	selected: boolean;
	onSelect: () => void;
	onRemove: () => void;
}

function SortableGalleryThumb({
	image,
	index,
	selected,
	onSelect,
	onRemove,
}: SortableGalleryThumbProps) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
		id: image._key,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<div ref={setNodeRef} style={style} className="relative group">
			<Button
				type="button"
				variant="ghost"
				shape="square"
				aria-label={image.alt || t`Image ${index + 1}`}
				className={cn(
					"aspect-square h-full w-full rounded-md border overflow-hidden",
					selected && "ring-2 ring-kumo-brand",
				)}
				onClick={onSelect}
				{...attributes}
				{...listeners}
			>
				<img
					src={galleryImageUrl(image)}
					alt={image.alt || ""}
					className="object-cover w-full h-full"
					draggable={false}
				/>
			</Button>
			<Button
				type="button"
				variant="destructive"
				shape="square"
				className="absolute top-1 end-1 h-6 w-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
				onPointerDown={(e) => e.stopPropagation()}
				aria-label={t`Remove image ${index + 1}`}
			>
				<Trash className="h-3 w-3" />
			</Button>
			<span
				className="absolute bottom-1 start-1 text-[10px] bg-black/60 text-white rounded px-1"
				aria-hidden
			>
				{index + 1}
			</span>
		</div>
	);
}

interface GalleryImageSettingsProps {
	image: GalleryImage;
	onChange: (patch: Partial<GalleryImage>) => void;
	onReplace: (item: MediaItem) => void;
}

function GalleryImageSettings({ image, onChange, onReplace }: GalleryImageSettingsProps) {
	const { t } = useLingui();
	const [showReplacePicker, setShowReplacePicker] = React.useState(false);

	const hasOriginalSize = typeof image.width === "number" && typeof image.height === "number";

	return (
		<div className="border rounded-lg p-3 space-y-3">
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
