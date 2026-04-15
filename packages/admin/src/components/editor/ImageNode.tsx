/**
 * Custom Image Node for TipTap
 *
 * Provides a selectable, editable image with:
 * - Click to select
 * - Visual selection indicator
 * - Quick inline alt text editing
 * - Full detail panel for advanced settings
 * - Delete/replace options
 */

import { Button, Input } from "@cloudflare/kumo";
import { Trash, Pencil, X, Check, SlidersHorizontal } from "@phosphor-icons/react";
import type { NodeViewProps } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import type { ImageAttributes } from "./ImageDetailPanel";

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
				displayWidth?: number;
				displayHeight?: number;
			}) => ReturnType;
		};
	}
}

// React component for the image node view
function ImageNodeView({ node, updateAttributes, selected, deleteNode, editor }: NodeViewProps) {
	const [isEditingAlt, setIsEditingAlt] = React.useState(false);
	const [altText, setAltText] = React.useState(node.attrs.alt || "");

	/** Whether this node currently has its sidebar panel open */
	const sidebarOpenRef = React.useRef(false);

	const handleSaveAlt = () => {
		updateAttributes({ alt: altText });
		setIsEditingAlt(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSaveAlt();
		} else if (e.key === "Escape") {
			setAltText(node.attrs.alt || "");
			setIsEditingAlt(false);
		}
	};

	// Sync local alt text state when node attributes change
	React.useEffect(() => {
		setAltText(node.attrs.alt || "");
	}, [node.attrs.alt]);

	const getImageAttrs = (): ImageAttributes => ({
		src: node.attrs.src,
		alt: node.attrs.alt,
		title: node.attrs.title,
		caption: node.attrs.caption,
		mediaId: node.attrs.mediaId,
		width: node.attrs.width,
		height: node.attrs.height,
		displayWidth: node.attrs.displayWidth,
		displayHeight: node.attrs.displayHeight,
	});

	const openSidebar = () => {
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
		const onOpen = storage?.onOpenBlockSidebar as
			| ((panel: {
					type: "image";
					attrs: ImageAttributes;
					onUpdate: (attrs: Partial<ImageAttributes>) => void;
					onReplace: (attrs: ImageAttributes) => void;
					onDelete: () => void;
					onClose: () => void;
			  }) => void)
			| null;
		if (onOpen) {
			sidebarOpenRef.current = true;
			onOpen({
				type: "image",
				attrs: getImageAttrs(),
				onUpdate: (attrs: Partial<ImageAttributes>) => updateAttributes(attrs),
				onReplace: (attrs: ImageAttributes) => updateAttributes(attrs),
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

	return (
		<NodeViewWrapper
			className={cn(
				"relative my-4 group",
				selected && "ring-2 ring-kumo-brand ring-offset-2 rounded-lg",
			)}
		>
			<figure className="relative">
				<img
					src={node.attrs.src}
					alt={node.attrs.alt || ""}
					title={node.attrs.title || ""}
					className="rounded-lg max-w-full mx-auto"
					style={{
						width: node.attrs.displayWidth ? `${node.attrs.displayWidth}px` : undefined,
						height: node.attrs.displayHeight ? `${node.attrs.displayHeight}px` : undefined,
					}}
					draggable={false}
				/>

				{/* Selection overlay with actions */}
				{selected && (
					<div className="absolute top-2 end-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
						<Button
							type="button"
							variant="secondary"
							shape="square"
							className="h-8 w-8"
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => setIsEditingAlt(true)}
							title="Quick edit alt text"
							aria-label="Quick edit alt text"
						>
							<Pencil className="h-4 w-4" />
						</Button>
						<Button
							type="button"
							variant="secondary"
							shape="square"
							className="h-8 w-8"
							onMouseDown={(e) => e.preventDefault()}
							onClick={toggleSidebar}
							title="Image settings"
							aria-label="Image settings"
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
							title="Delete image"
							aria-label="Delete image"
						>
							<Trash className="h-4 w-4" />
						</Button>
					</div>
				)}

				{/* Quick alt text editor (inline) */}
				{isEditingAlt && (
					<div className="absolute bottom-0 start-0 end-0 bg-kumo-base/95 backdrop-blur p-3 rounded-b-lg border-t">
						<label className="text-xs font-medium text-kumo-subtle mb-1 block">Alt text</label>
						<div className="flex gap-2">
							<Input
								type="text"
								value={altText}
								onChange={(e) => setAltText(e.target.value)}
								onKeyDown={handleKeyDown}
								placeholder="Describe the image..."
								className="flex-1 h-8 text-sm"
								autoFocus
							/>
							<Button
								type="button"
								variant="ghost"
								shape="square"
								className="h-8 w-8"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									setAltText(node.attrs.alt || "");
									setIsEditingAlt(false);
								}}
								title="Cancel"
								aria-label="Cancel"
							>
								<X className="h-4 w-4" />
							</Button>
							<Button
								type="button"
								variant="primary"
								shape="square"
								className="h-8 w-8"
								onMouseDown={(e) => e.preventDefault()}
								onClick={handleSaveAlt}
								title="Save"
								aria-label="Save alt text"
							>
								<Check className="h-4 w-4" />
							</Button>
						</div>
					</div>
				)}

				{/* Caption display (shows caption if set, falls back to alt) */}
				{!isEditingAlt && (node.attrs.caption || node.attrs.alt) && (
					<figcaption className="text-center text-sm text-kumo-subtle mt-2">
						{node.attrs.caption || node.attrs.alt}
					</figcaption>
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
						attrs: import("./ImageDetailPanel").ImageAttributes;
						onUpdate: (attrs: Partial<import("./ImageDetailPanel").ImageAttributes>) => void;
						onReplace: (attrs: import("./ImageDetailPanel").ImageAttributes) => void;
						onDelete: () => void;
						onClose: () => void;
				  }) => void)
				| null,
			/** Callback set by PortableTextEditor to close the sidebar */
			onCloseBlockSidebar: null as (() => void) | null,
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
			displayWidth: {
				default: null,
			},
			displayHeight: {
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
					displayWidth?: number;
					displayHeight?: number;
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
