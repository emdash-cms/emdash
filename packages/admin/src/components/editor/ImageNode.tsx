/**
 * Custom Image Node for TipTap
 *
 * Provides a selectable image with a visual selection indicator, a caption
 * field, and a detail panel for advanced settings. The toolbar for a selected
 * image lives in PortableTextEditor.
 */

import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import type { NodeViewProps } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import * as React from "react";

import { fetchMediaItem } from "../../lib/api/media.js";
import { useStableCallback } from "../../lib/hooks";
import { canonicalMediaProviderId, getMediaPreviewUrl } from "../../lib/media-utils.js";
import { cn } from "../../lib/utils";
import type { ImageAttributes, ImagePanelAttributes } from "./ImageDetailPanel";

// Extend the Commands interface to include setImage
declare module "@tiptap/react" {
	interface Commands<ReturnType> {
		image: {
			setImage: (options: {
				src: string;
				alt?: string;
				title?: string;
				caption?: string;
				mediaId?: string;
				/** Provider ID for external media (e.g., "cloudflare-images") */
				provider?: string;
				width?: number;
				height?: number;
				/** LQIP blurhash placeholder */
				blurhash?: string;
				/** LQIP dominant-color placeholder */
				dominantColor?: string;
				displayWidth?: number;
				displayHeight?: number;
				alignment?: "left" | "center" | "right" | "wide" | "full";
				link?: { href: string; blank?: boolean } | null;
			}) => ReturnType;
		};
	}
}

export interface ImageSettingsHandle {
	getPos: () => number | undefined;
	toggle: () => void;
}

function imageDimension(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// Firefox can't select text by mouse inside a draggable element, and the image node view is one.
function setNodeViewDraggable(event: React.PointerEvent<HTMLTextAreaElement>, draggable: boolean) {
	if (event.pointerType !== "mouse") return;
	const nodeView = event.currentTarget.closest<HTMLElement>("[draggable]");
	if (nodeView) nodeView.draggable = draggable;
}

// React component for the image node view
function ImageNodeView({
	node,
	updateAttributes,
	selected,
	deleteNode,
	editor,
	getPos,
}: NodeViewProps) {
	const { t } = useLingui();
	const mediaId =
		typeof node.attrs.mediaId === "string" &&
		node.attrs.mediaId &&
		canonicalMediaProviderId(node.attrs.provider) === "local"
			? node.attrs.mediaId
			: null;
	const { data: currentMedia } = useQuery({
		queryKey: ["media", mediaId],
		queryFn: ({ signal }) => fetchMediaItem(mediaId!, { signal }),
		enabled: mediaId !== null,
	});
	const storedSrc = typeof node.attrs.src === "string" ? node.attrs.src : "";
	const displaySrc = getMediaPreviewUrl(currentMedia?.url || storedSrc, currentMedia?.contentHash);

	/** Whether this node currently has its sidebar panel open */
	const sidebarOpenRef = React.useRef(false);
	const nodeKeyRef = React.useRef({});
	/** The attrs object the open panel last wrote or saw; any other value is an outside change. */
	const panelAttrsRef = React.useRef<unknown>(null);

	const selectImage = () => {
		const position = getPos();
		if (typeof position === "number") {
			editor.commands.setNodeSelection(position);
		}
	};

	const handlePointerDown = (event: React.PointerEvent) => {
		if (!editor.isEditable || !event.isPrimary || event.button !== 0) return;
		// The caption selects the image once it has focus, so the toolbar sees that focus.
		if ((event.target as HTMLElement).closest("figcaption")) return;
		selectImage();
	};

	const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "";
	const captionRef = React.useRef<HTMLTextAreaElement>(null);
	// ProseMirror would take text dragged over or dropped on the caption into the document.
	React.useEffect(() => {
		const textarea = captionRef.current;
		if (!textarea) return;
		const keepTextDrag = (event: DragEvent) => {
			if (!event.dataTransfer?.types.includes("Files")) event.stopPropagation();
		};
		textarea.addEventListener("dragover", keepTextDrag);
		textarea.addEventListener("drop", keepTextDrag);
		return () => {
			textarea.removeEventListener("dragover", keepTextDrag);
			textarea.removeEventListener("drop", keepTextDrag);
		};
	}, [editor.isEditable]);
	const handleCaptionKeyDown = (event: React.KeyboardEvent) => {
		if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
		event.preventDefault();
		const position = getPos();
		if (typeof position !== "number") return;
		const after = position + node.nodeSize;
		editor
			.chain()
			.insertContentAt(after, { type: "paragraph" })
			.focus(after + 1)
			.run();
	};

	const getImageAttrs = (): ImagePanelAttributes => ({
		nodeKey: nodeKeyRef.current,
		src: node.attrs.src,
		alt: node.attrs.alt,
		title: node.attrs.title,
		caption: node.attrs.caption,
		mediaId: node.attrs.mediaId,
		provider: node.attrs.provider,
		width: node.attrs.width,
		height: node.attrs.height,
		blurhash: node.attrs.blurhash,
		dominantColor: node.attrs.dominantColor,
		displayWidth: node.attrs.displayWidth,
		displayHeight: node.attrs.displayHeight,
		alignment: node.attrs.alignment,
		link: node.attrs.link,
	});

	const openSidebar = () => {
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
		const onOpen = storage?.onOpenBlockSidebar as
			| ((panel: {
					type: "image";
					attrs: ImagePanelAttributes;
					onUpdate: (attrs: Partial<ImageAttributes>) => void;
					onReplace: (attrs: ImageAttributes) => void;
					onDelete: () => void;
					onClose: () => void;
			  }) => void)
			| null;
		if (onOpen) {
			const updateFromPanel = (attrs: Partial<ImageAttributes>) => {
				updateAttributes(attrs);
				const position = getPos();
				if (typeof position === "number") {
					panelAttrsRef.current = editor.state.doc.nodeAt(position)?.attrs;
				}
			};
			sidebarOpenRef.current = true;
			panelAttrsRef.current = node.attrs;
			onOpen({
				type: "image",
				attrs: getImageAttrs(),
				onUpdate: updateFromPanel,
				onReplace: updateFromPanel,
				onDelete: () => deleteNode(),
				onClose: () => {
					sidebarOpenRef.current = false;
				},
			});
		}
	};

	const closeSidebar = () => {
		if (!sidebarOpenRef.current) return;
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
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

	// The panel stages its fields and writes them all back on Apply, so it must
	// not outlive a change made outside it, or the node itself.
	React.useEffect(() => {
		if (sidebarOpenRef.current && node.attrs !== panelAttrsRef.current) closeSidebar();
	}, [node.attrs]);
	React.useEffect(() => closeSidebar, []);

	const toggleSettings = useStableCallback(toggleSidebar);
	React.useEffect(() => {
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
		const handles = storage?.settingsHandles as Set<ImageSettingsHandle> | undefined;
		const handle = { getPos, toggle: toggleSettings };
		handles?.add(handle);
		return () => {
			handles?.delete(handle);
		};
	}, [editor, getPos, toggleSettings]);

	const alignment = node.attrs.alignment as
		| "left"
		| "center"
		| "right"
		| "wide"
		| "full"
		| undefined;
	// Mirror the published <Image> layout so the editor is WYSIWYG: left/right
	// float (text wraps), center/wide/full size the block.
	const alignmentStyle: React.CSSProperties =
		alignment === "center" ? { width: "fit-content", marginInline: "auto" } : {};
	const { width, height, displayWidth, displayHeight } = node.attrs as ImageAttributes;
	const originalWidth = imageDimension(width);
	const originalHeight = imageDimension(height);
	const customWidth = imageDimension(displayWidth);
	const customHeight = imageDimension(displayHeight);
	const aspectRatio = originalWidth && originalHeight ? originalWidth / originalHeight : undefined;
	let renderWidth = originalWidth;
	let renderHeight = originalHeight;
	if (customWidth && customHeight) {
		renderWidth = customWidth;
		renderHeight = customHeight;
	} else if (customWidth && aspectRatio) {
		renderWidth = customWidth;
		renderHeight = Math.round(customWidth / aspectRatio);
	} else if (customHeight && aspectRatio) {
		renderWidth = Math.round(customHeight * aspectRatio);
		renderHeight = customHeight;
	}

	return (
		<NodeViewWrapper
			style={alignmentStyle}
			onPointerDown={handlePointerDown}
			className={cn(
				"relative my-4 max-w-full",
				(alignment === "left" || alignment === "right") &&
					"w-full min-[641px]:w-fit min-[641px]:max-w-1/2",
				alignment === "left" && "min-[641px]:[float:left] min-[641px]:me-6",
				alignment === "right" && "min-[641px]:[float:right] min-[641px]:ms-6",
			)}
		>
			<figure className="relative my-0!">
				<img
					src={displaySrc}
					alt={node.attrs.alt || ""}
					title={node.attrs.title || ""}
					className="rounded-lg max-w-full h-auto object-cover"
					width={renderWidth}
					height={renderHeight}
					style={{
						aspectRatio:
							renderWidth && renderHeight ? `${renderWidth} / ${renderHeight}` : undefined,
					}}
					draggable={false}
				/>

				{/* Show the caption, never the alt text, as the published renderer (Image.astro) does */}
				{editor.isEditable ? (
					// Inline-size containment keeps the placeholder from widening a small image.
					<figcaption className="mt-2 [contain:inline-size]">
						<textarea
							ref={captionRef}
							aria-label={t`Caption`}
							placeholder={t`Type caption for image (optional)`}
							rows={1}
							tabIndex={-1}
							dir="auto"
							value={caption}
							onChange={(event) => {
								if (editor.isEditable) updateAttributes({ caption: event.target.value });
							}}
							onFocus={selectImage}
							onPointerEnter={(event) => setNodeViewDraggable(event, false)}
							onPointerLeave={(event) => setNodeViewDraggable(event, true)}
							onKeyDown={handleCaptionKeyDown}
							className="block w-full resize-none field-sizing-content rounded-sm bg-transparent text-center text-sm text-kumo-subtle placeholder:text-kumo-placeholder focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus/50"
						/>
					</figcaption>
				) : (
					caption && (
						<figcaption className="text-center text-sm text-kumo-subtle mt-2">{caption}</figcaption>
					)
				)}
			</figure>
		</NodeViewWrapper>
	);
}

// Custom Image extension with React NodeView
export const ImageExtension = Node.create({
	name: "image",

	addOptions() {
		return {
			inline: false,
			allowBase64: false,
			HTMLAttributes: {},
		};
	},

	addStorage() {
		return {
			/** Callback set by PortableTextEditor to open image settings in the content sidebar */
			onOpenBlockSidebar: null as
				| ((panel: {
						type: "image";
						attrs: import("./ImageDetailPanel").ImagePanelAttributes;
						onUpdate: (attrs: Partial<import("./ImageDetailPanel").ImageAttributes>) => void;
						onReplace: (attrs: import("./ImageDetailPanel").ImageAttributes) => void;
						onDelete: () => void;
						onClose: () => void;
				  }) => void)
				| null,
			/** Callback set by PortableTextEditor to close the sidebar */
			onCloseBlockSidebar: null as (() => void) | null,
			/** One per mounted image node view, so the toolbar can toggle a given image's settings */
			settingsHandles: new Set<ImageSettingsHandle>(),
		};
	},

	inline() {
		return this.options.inline;
	},

	group() {
		return this.options.inline ? "inline" : "block";
	},

	draggable: true,

	addAttributes() {
		return {
			src: {
				default: null,
			},
			alt: {
				default: null,
			},
			title: {
				default: null,
			},
			caption: {
				default: null,
			},
			mediaId: {
				default: null,
			},
			/** Provider ID for external media (e.g., "cloudflare-images") */
			provider: {
				default: null,
			},
			width: {
				default: null,
			},
			height: {
				default: null,
			},
			blurhash: {
				default: null,
			},
			dominantColor: {
				default: null,
			},
			displayWidth: {
				default: null,
			},
			displayHeight: {
				default: null,
			},
			alignment: {
				default: null,
			},
			link: {
				default: null,
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "img[src]",
			},
		];
	},

	renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
		return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
	},

	addNodeView() {
		return ReactNodeViewRenderer(ImageNodeView);
	},

	addCommands() {
		return {
			setImage:
				(options: {
					src: string;
					alt?: string;
					title?: string;
					caption?: string;
					mediaId?: string;
					provider?: string;
					width?: number;
					height?: number;
					blurhash?: string;
					dominantColor?: string;
					displayWidth?: number;
					displayHeight?: number;
					alignment?: "left" | "center" | "right" | "wide" | "full";
					link?: { href: string; blank?: boolean } | null;
				}) =>
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
