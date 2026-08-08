/**
 * Gallery Node for TipTap
 *
 * Node view for the Portable Text `gallery` block (grid of images with
 * optional per-image captions and a column count). Provides a WYSIWYG grid
 * preview, selection state, and a settings button that opens the gallery
 * detail panel in the content sidebar (same wiring as ImageNode).
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Images, Trash, SlidersHorizontal } from "@phosphor-icons/react";
import type { NodeViewProps } from "@tiptap/react";
import { Node } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

/** One image inside a gallery block — mirrors the Portable Text shape. */
export interface GalleryImage {
	_type: "image";
	_key: string;
	asset: {
		_type?: "reference";
		_ref: string;
		url?: string;
		/** Provider ID for external media (e.g., "cloudflare-images") */
		provider?: string;
	};
	alt?: string;
	caption?: string;
	width?: number;
	height?: number;
	/** LQIP blurhash placeholder (images only) */
	blurhash?: string;
	/** LQIP dominant-color placeholder, as a CSS color (images only) */
	dominantColor?: string;
}

export interface GalleryAttributes {
	images: GalleryImage[];
	columns?: number;
}

/** Panel descriptor passed to the block sidebar (see BlockSidebarPanel). */
export interface GallerySidebarPanel {
	type: "gallery";
	/**
	 * `selectedImageKey` is transient UI state (which image's settings card
	 * is open) and `nodeKey` identifies which gallery node this panel
	 * instance belongs to (from `getPos()`) — both must never be written
	 * into node attrs via `updateAttributes`.
	 */
	attrs: GalleryAttributes & { selectedImageKey?: string; nodeKey?: string };
	onUpdate: (attrs: Partial<GalleryAttributes>) => void;
	onReplace: (attrs: GalleryAttributes) => void;
	onDelete: () => void;
	onClose: () => void;
}

declare module "@tiptap/react" {
	interface Commands<ReturnType> {
		gallery: {
			setGallery: (options: GalleryAttributes) => ReturnType;
		};
	}
}

/** Resolve the admin preview URL for a gallery image. */
export function galleryImageUrl(image: GalleryImage): string {
	if (image.asset.url) return image.asset.url;
	if (image.asset._ref) return `/_emdash/api/media/file/${encodeURIComponent(image.asset._ref)}`;
	return "";
}

function GalleryNodeView({
	node,
	updateAttributes,
	selected,
	deleteNode,
	editor,
	getPos,
}: NodeViewProps) {
	const { t } = useLingui();
	const sidebarOpenRef = React.useRef(false);

	const images = (node.attrs.images ?? []) as GalleryImage[];
	const columns = typeof node.attrs.columns === "number" ? node.attrs.columns : 3;

	const getAttrs = (): GalleryAttributes => ({
		images: (node.attrs.images ?? []) as GalleryImage[],
		columns: typeof node.attrs.columns === "number" ? node.attrs.columns : undefined,
	});

	const openSidebar = (selectedImageKey?: string) => {
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).gallery;
		const onOpen = storage?.onOpenBlockSidebar as ((panel: GallerySidebarPanel) => void) | null;
		if (onOpen) {
			sidebarOpenRef.current = true;
			onOpen({
				type: "gallery",
				// `nodeKey` is transient UI state identifying which gallery node this
				// panel instance is for — used by GalleryDetailPanel to key its resync
				// effect on node identity rather than attrs object identity. Never
				// written to node attrs via `updateAttributes`.
				attrs: { ...getAttrs(), selectedImageKey, nodeKey: String(getPos?.() ?? "") },
				onUpdate: (attrs) => updateAttributes(attrs),
				onReplace: (attrs) => updateAttributes(attrs),
				onDelete: () => deleteNode(),
				onClose: () => {
					sidebarOpenRef.current = false;
				},
			});
		}
	};

	const closeSidebar = () => {
		if (!sidebarOpenRef.current) return;
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).gallery;
		const onClose = storage?.onCloseBlockSidebar as (() => void) | null;
		if (onClose) {
			onClose();
			sidebarOpenRef.current = false;
		}
	};

	const toggleSidebar = () => {
		if (sidebarOpenRef.current) {
			closeSidebar();
		} else {
			openSidebar();
		}
	};

	// Close sidebar when this node is deselected
	React.useEffect(() => {
		if (!selected) {
			closeSidebar();
		}
	}, [selected]);

	return (
		<NodeViewWrapper
			className={cn(
				"relative my-4 group",
				selected && "ring-2 ring-kumo-brand ring-offset-2 rounded-lg",
			)}
		>
			{images.length === 0 ? (
				<Button
					type="button"
					variant="outline"
					className="mt-2 w-full h-32 justify-center border-dashed"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => openSidebar()}
				>
					<div className="flex flex-col items-center gap-2 text-kumo-subtle">
						<Images className="h-8 w-8" />
						<span className="text-sm">{t`Empty gallery — open settings to add images`}</span>
					</div>
				</Button>
			) : (
				<div
					className="grid gap-2 rounded-lg"
					style={{ gridTemplateColumns: `repeat(${Math.max(1, columns)}, 1fr)` }}
				>
					{images.map((image, index) => (
						<figure key={image._key} className="m-0">
							<button
								type="button"
								className="block w-full cursor-pointer"
								onMouseDown={(e) => e.preventDefault()}
								onClick={(e) => {
									e.stopPropagation();
									openSidebar(image._key);
								}}
								aria-label={t`Edit image ${index + 1}`}
							>
								<img
									src={galleryImageUrl(image)}
									alt={image.alt || ""}
									className="w-full aspect-square object-cover rounded-md border"
									draggable={false}
								/>
							</button>
							{image.caption && (
								<figcaption className="text-xs text-kumo-subtle mt-1 text-center truncate">
									{image.caption}
								</figcaption>
							)}
						</figure>
					))}
				</div>
			)}

			{/* Selection overlay with actions */}
			{selected && (
				<div className="absolute top-2 end-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
					<Button
						type="button"
						variant="secondary"
						shape="square"
						className="h-8 w-8"
						onMouseDown={(e) => e.preventDefault()}
						onClick={toggleSidebar}
						title={t`Gallery settings`}
						aria-label={t`Gallery settings`}
					>
						<SlidersHorizontal className="h-4 w-4" />
					</Button>
					<Button
						type="button"
						variant="destructive"
						shape="square"
						className="h-8 w-8"
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => deleteNode()}
						title={t`Delete gallery`}
						aria-label={t`Delete gallery`}
					>
						<Trash className="h-4 w-4" />
					</Button>
				</div>
			)}
		</NodeViewWrapper>
	);
}

export const GalleryExtension = Node.create({
	name: "gallery",

	group: "block",

	atom: true,

	draggable: true,

	addStorage() {
		return {
			/** Callback set by PortableTextEditor to open gallery settings in the content sidebar */
			onOpenBlockSidebar: null as ((panel: GallerySidebarPanel) => void) | null,
			/** Callback set by PortableTextEditor to close the sidebar */
			onCloseBlockSidebar: null as (() => void) | null,
		};
	},

	addAttributes() {
		return {
			images: {
				default: [],
			},
			columns: {
				default: null,
			},
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-type="gallery"]' }];
	},

	renderHTML() {
		return ["div", { "data-type": "gallery" }];
	},

	addNodeView() {
		return ReactNodeViewRenderer(GalleryNodeView);
	},

	addCommands() {
		return {
			setGallery:
				(options: GalleryAttributes) =>
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				({ commands }: any) => {
					return commands.insertContent({
						type: this.name,
						attrs: options,
					});
				},
		};
	},
});
