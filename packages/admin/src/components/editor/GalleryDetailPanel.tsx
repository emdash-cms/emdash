/**
 * Gallery Detail Panel for Editor
 *
 * Sidebar panel for editing a gallery block: add images (multi-select media
 * picker), remove, drag-and-drop reorder, per-image alt/caption, and column
 * count. Changes apply immediately via onUpdate (reordering is inherently
 * live, so the whole panel follows suit instead of a save-button form).
 */

import { Button, Input, Label, Select } from "@cloudflare/kumo";
import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	arrayMove,
	rectSortingStrategy,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLingui } from "@lingui/react/macro";
import { X, Plus, Trash, ImageSquare, PencilSimple } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../../lib/api";
import { canonicalMediaProviderId, metaString } from "../../lib/media-utils";
import { cn } from "../../lib/utils";
import { useMediaAssetEditor } from "../media/useMediaAssetEditor.js";
import { MediaPickerModal } from "../MediaPickerModal";
import { GalleryPreviewImage, type GalleryAttributes, type GalleryImage } from "./GalleryNode";

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

function mediaItemAssetFields(item: MediaItem) {
	return {
		asset: {
			_type: "reference" as const,
			_ref: item.id,
			url: item.url,
			provider: item.provider && item.provider !== "local" ? item.provider : undefined,
		},
		width: item.width,
		height: item.height,
		focalX: item.focalX ?? undefined,
		focalY: item.focalY ?? undefined,
		blurhash: item.blurhash ?? metaString(item.meta, "blurhash"),
		dominantColor: item.dominantColor ?? metaString(item.meta, "dominantColor"),
	};
}

/** Map a picked MediaItem to the gallery's Portable Text image shape. */
export function mediaItemToGalleryImage(item: MediaItem): GalleryImage {
	return {
		_type: "image",
		_key: generateKey(),
		alt: item.alt || "",
		...mediaItemAssetFields(item),
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
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	const [showMediaPicker, setShowMediaPicker] = React.useState(false);
	const [assetEditorActive, setAssetEditorActive] = React.useState(false);
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
	const dragAccessibility = React.useMemo(
		() => ({
			announcements: {
				onDragStart: ({ active }: { active: { id: string | number } }) => {
					const index = images.findIndex((image) => image._key === active.id);
					const label = images[index]?.alt || t`Image ${index + 1}`;
					return t`Picked up ${label}.`;
				},
				onDragOver: ({
					active,
					over,
				}: {
					active: { id: string | number };
					over: { id: string | number } | null;
				}) => {
					const oldIndex = images.findIndex((image) => image._key === active.id);
					const newIndex = images.findIndex((image) => image._key === over?.id);
					if (newIndex < 0) return "";
					const label = images[oldIndex]?.alt || t`Image ${oldIndex + 1}`;
					return t`Moving ${label} to position ${newIndex + 1} of ${images.length}.`;
				},
				onDragEnd: ({
					active,
					over,
				}: {
					active: { id: string | number };
					over: { id: string | number } | null;
				}) => {
					const oldIndex = images.findIndex((image) => image._key === active.id);
					const newIndex = images.findIndex((image) => image._key === over?.id);
					const label = images[oldIndex]?.alt || t`Image ${oldIndex + 1}`;
					return newIndex < 0
						? t`Moving ${label} was cancelled.`
						: t`${label} moved to position ${newIndex + 1} of ${images.length}.`;
				},
				onDragCancel: ({ active }: { active: { id: string | number } }) => {
					const index = images.findIndex((image) => image._key === active.id);
					const label = images[index]?.alt || t`Image ${index + 1}`;
					return t`Moving ${label} was cancelled.`;
				},
			},
			screenReaderInstructions: {
				draggable: t`Press Space to pick up an image. Use the Arrow keys to move it, then press Space to drop it.`,
			},
		}),
		[images, t],
	);

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
					? { ...image, ...mediaItemAssetFields(item), alt: item.alt || "" }
					: image,
			),
		});
	};
	const handleAssetChange = (key: string, item: MediaItem) => {
		apply({
			images: images.map((image) =>
				image._key === key ? { ...image, ...mediaItemAssetFields(item) } : image,
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
					disabled={assetEditorActive}
				>
					{t`Add Images`}
				</Button>
			</div>

			{images.length === 0 ? (
				<p className="text-sm text-kumo-subtle text-center py-4">{t`No images in this gallery yet.`}</p>
			) : (
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					accessibility={dragAccessibility}
					onDragEnd={handleDragEnd}
				>
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
					onAssetChange={(item) => handleAssetChange(selectedImage._key, item)}
					onAssetEditorActiveChange={setAssetEditorActive}
					onRemove={() => handleRemove(selectedImage._key)}
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
				<GalleryPreviewImage
					image={image}
					className="emdash-media-transparency-grid h-full w-full object-cover"
				/>
			</Button>
			<Button
				type="button"
				variant="destructive"
				shape="square"
				className="absolute end-1 top-1 h-6 w-6 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
				onPointerDown={(e) => e.stopPropagation()}
				aria-label={t`Remove image ${index + 1}`}
			>
				<Trash className="h-3 w-3" aria-hidden="true" />
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
	onAssetChange: (item: MediaItem) => void;
	onAssetEditorActiveChange: (active: boolean) => void;
	onRemove: () => void;
}

function GalleryImageSettings({
	image,
	onChange,
	onReplace,
	onAssetChange,
	onAssetEditorActiveChange,
	onRemove,
}: GalleryImageSettingsProps) {
	const { t } = useLingui();
	const [showReplacePicker, setShowReplacePicker] = React.useState(false);
	const assetEditor = useMediaAssetEditor(onAssetChange);
	React.useEffect(() => {
		onAssetEditorActiveChange(assetEditor.isActive);
		return () => onAssetEditorActiveChange(false);
	}, [assetEditor.isActive, onAssetEditorActiveChange]);
	const canEditAsset =
		Boolean(image.asset._ref) && canonicalMediaProviderId(image.asset.provider) === "local";

	const hasOriginalSize = typeof image.width === "number" && typeof image.height === "number";

	return (
		<div className="border rounded-lg p-3 space-y-3">
			<div className="emdash-media-transparency-grid relative flex aspect-video items-center justify-center overflow-hidden rounded-lg">
				<GalleryPreviewImage image={image} className="max-h-full max-w-full object-contain" />
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					icon={<ImageSquare aria-hidden="true" />}
					onClick={() => setShowReplacePicker(true)}
					disabled={assetEditor.isActive}
				>
					{t`Replace`}
				</Button>
				{canEditAsset && (
					<Button
						type="button"
						variant="outline"
						size="sm"
						icon={<PencilSimple aria-hidden="true" />}
						loading={assetEditor.isOpening}
						onClick={(event) =>
							void assetEditor.openAssetEditor(image.asset._ref, event.currentTarget)
						}
					>
						{t`Edit asset`}
					</Button>
				)}
				<Button
					type="button"
					variant="secondary-destructive"
					size="sm"
					icon={<Trash aria-hidden="true" />}
					onClick={onRemove}
					disabled={assetEditor.isActive}
				>
					{t`Remove`}
				</Button>
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
				confirmLabel={t`Replace`}
			/>
			{assetEditor.dialog}
			{assetEditor.error && (
				<p role="alert" className="text-sm text-kumo-danger">
					{assetEditor.error}
				</p>
			)}
		</div>
	);
}
