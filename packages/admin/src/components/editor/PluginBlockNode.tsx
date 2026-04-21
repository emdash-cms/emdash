/**
 * Plugin Block Node for TipTap
 *
 * Renders embed blocks (YouTube, Vimeo, tweets, etc.) with:
 * - Selection indicator with ring
 * - Inline URL editing via popover
 * - Drag handle in left gutter
 * - Action buttons on hover/selection
 * - Keyboard support
 */

import { Button, Input } from "@cloudflare/kumo";
import type { Element } from "@emdash-cms/blocks";
import {
	DotsSixVertical,
	Trash,
	Pencil,
	X,
	Check,
	ArrowSquareOut,
	YoutubeLogo,
	LinkSimple,
	Code,
	Copy,
	Cube,
	ListBullets,
} from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Plugin block definition for slash commands
 */
export interface PluginBlockDef {
	type: string;
	pluginId: string;
	label: string;
	icon?: string;
	description?: string;
	placeholder?: string;
	/** Block Kit form fields. If declared, replaces the simple URL input. */
	fields?: Element[];
}

// =============================================================================
// Plugin Block Registry (stored per-editor instance via TipTap extension storage)
// =============================================================================

/** Register plugin block definitions into editor storage so the node view can look up metadata */
export function registerPluginBlocks(
	editor: { storage: Record<string, Record<string, unknown>> },
	blocks: PluginBlockDef[],
): void {
	const registry = new Map<string, PluginBlockDef>();
	for (const block of blocks) {
		registry.set(block.type, block);
	}
	const storage = editor.storage.pluginBlock as Record<string, unknown> | undefined;
	if (storage) {
		storage.registry = registry;
	}
}

/** Read the registry from editor storage */
function getRegistry(editor: {
	storage: Record<string, Record<string, unknown>>;
}): Map<string, PluginBlockDef> {
	const storage = editor.storage.pluginBlock as Record<string, unknown> | undefined;
	return (storage?.registry as Map<string, PluginBlockDef>) ?? new Map();
}

/** Named icon map: icon key → React component */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
	video: YoutubeLogo,
	code: Code,
	link: LinkSimple,
	"link-external": ArrowSquareOut,
	form: ListBullets,
};

/** Resolve an icon key to a React component */
function resolveIcon(iconKey?: string): React.ComponentType<{ className?: string }> {
	if (iconKey && ICON_MAP[iconKey]) {
		return ICON_MAP[iconKey];
	}
	return Cube;
}

/**
 * Get icon component and metadata for embed block types.
 * Reads from the plugin block registry in editor storage.
 */
function getEmbedMeta(
	blockType: string,
	registry: Map<string, PluginBlockDef>,
): {
	Icon: React.ComponentType<{ className?: string }>;
	label: string;
	color: string;
	placeholder: string;
} {
	const def = registry.get(blockType);
	if (def) {
		return {
			Icon: resolveIcon(def.icon),
			label: def.label,
			color: "text-kumo-subtle",
			placeholder: def.placeholder || "Enter URL...",
		};
	}

	// Fallback for unregistered block types
	return {
		Icon: Cube,
		label: blockType.charAt(0).toUpperCase() + blockType.slice(1),
		color: "text-kumo-subtle",
		placeholder: "Enter URL...",
	};
}

/**
 * Extract display ID from URL for cleaner presentation
 */
function getDisplayId(id: string, blockType: string): string {
	try {
		const url = new URL(id);

		switch (blockType) {
			case "youtube": {
				// youtube.com/watch?v=VIDEO_ID or youtu.be/VIDEO_ID
				const videoId = url.searchParams.get("v") || url.pathname.split("/").pop();
				return videoId || id;
			}
			case "vimeo": {
				// vimeo.com/VIDEO_ID
				return url.pathname.split("/").find(Boolean) || id;
			}
			case "tweet": {
				// twitter.com/user/status/TWEET_ID
				const parts = url.pathname.split("/");
				const statusIndex = parts.indexOf("status");
				const tweetId = parts[statusIndex + 1];
				if (statusIndex !== -1 && tweetId) {
					return `@${parts[1]}/${tweetId.slice(0, 8)}...`;
				}
				return id;
			}
			case "gist": {
				// gist.github.com/user/GIST_ID
				const parts = url.pathname.split("/").filter(Boolean);
				if (parts.length >= 2 && parts[0] && parts[1]) {
					return `${parts[0]}/${parts[1].slice(0, 8)}...`;
				}
				return id;
			}
			default:
				// Show hostname + truncated path
				return url.hostname + (url.pathname.length > 20 ? "..." : url.pathname);
		}
	} catch {
		// Not a valid URL, show as-is but truncated
		return id.length > 30 ? id.slice(0, 27) + "..." : id;
	}
}

/**
 * React component for the plugin block node view
 */
function PluginBlockNodeView({
	node,
	updateAttributes,
	selected,
	deleteNode,
	editor,
	getPos,
}: NodeViewProps) {
	const blockType = typeof node.attrs.blockType === "string" ? node.attrs.blockType : "";
	const id = typeof node.attrs.id === "string" ? node.attrs.id : "";
	const data =
		typeof node.attrs.data === "object" && node.attrs.data !== null
			? (node.attrs.data as Record<string, unknown>)
			: {};
	const registry = getRegistry(
		editor as unknown as { storage: Record<string, Record<string, unknown>> },
	);
	const { Icon, label, color, placeholder } = getEmbedMeta(blockType, registry);

	// Check if this block type has fields defined in the registry
	const blockDef = registry.get(blockType);
	const hasFields = blockDef?.fields && blockDef.fields.length > 0;

	const [isEditing, setIsEditing] = React.useState(false);
	const [editValue, setEditValue] = React.useState(id || "");
	const inputRef = React.useRef<HTMLInputElement>(null);

	// Focus input when editing starts
	React.useEffect(() => {
		if (isEditing) {
			setEditValue(id || "");
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [isEditing, id]);

	const handleSave = () => {
		if (editValue.trim()) {
			updateAttributes({ id: editValue.trim() });
		}
		setIsEditing(false);
	};

	const handleCancel = () => {
		setEditValue(id || "");
		setIsEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSave();
		} else if (e.key === "Escape") {
			e.preventDefault();
			handleCancel();
		}
	};

	const handleCopyUrl = () => {
		void navigator.clipboard.writeText(id);
	};

	const handleOpenExternal = () => {
		window.open(id, "_blank", "noopener,noreferrer");
	};

	const displayId = id
		? getDisplayId(id, blockType)
		: Object.values(data)
				.filter((v) => typeof v === "string" && v.length > 0)
				.join(", ") || blockType;

	return (
		<NodeViewWrapper
			className={cn(
				"plugin-block relative my-3",
				selected && "ring-2 ring-kumo-brand ring-offset-2 rounded-lg",
			)}
			contentEditable={false}
			data-drag-handle
		>
			<div className="relative group">
				{/* Drag handle - appears in left gutter */}
				<div
					className={cn(
						"absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing",
						selected && "opacity-100",
					)}
					data-drag-handle
				>
					<DotsSixVertical className="h-5 w-5 text-kumo-subtle/50" />
				</div>

				{/* Main block content */}
				<div
					className={cn(
						"rounded-lg border bg-kumo-base transition-colors",
						selected ? "border-kumo-brand/50 bg-kumo-tint/30" : "hover:border-kumo-line",
					)}
				>
					{/* Header with icon, label, and actions */}
					<div className="flex items-center gap-3 px-4 py-3">
						{/* Icon */}
						<div
							className={cn(
								"flex-shrink-0 w-10 h-10 rounded-lg bg-kumo-tint flex items-center justify-center",
								color,
							)}
						>
							<Icon className="h-5 w-5" />
						</div>

						{/* Label and ID */}
						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium">{label}</div>
							{!isEditing && (
								<div className="text-xs text-kumo-subtle truncate font-mono">{displayId}</div>
							)}
						</div>

						{/* Action buttons - visible on hover or when selected */}
						<div
							className={cn(
								"flex items-center gap-1 transition-opacity",
								selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							{id && (
								<>
									<Button
										type="button"
										variant="ghost"
										shape="square"
										className="h-8 w-8"
										onClick={handleCopyUrl}
										title="Copy URL"
										aria-label="Copy URL"
									>
										<Copy className="h-4 w-4" />
									</Button>
									<Button
										type="button"
										variant="ghost"
										shape="square"
										className="h-8 w-8"
										onClick={handleOpenExternal}
										title="Open in new tab"
										aria-label="Open in new tab"
									>
										<ArrowSquareOut className="h-4 w-4" />
									</Button>
								</>
							)}
							<Button
								type="button"
								variant="ghost"
								shape="square"
								className="h-8 w-8"
								onClick={() => {
									if (hasFields) {
										// Open Block Kit modal via editor storage callback
										const storage = (
											editor.storage as unknown as Record<string, Record<string, unknown>>
										).pluginBlock;
										const onEdit = storage?.onEditBlock as
											| ((attrs: {
													blockType: string;
													id: string;
													data: Record<string, unknown>;
													pos: number;
											  }) => void)
											| null;
										if (onEdit) {
											const pos = (typeof getPos === "function" ? getPos() : 0) ?? 0;
											onEdit({ blockType, id, data, pos });
										}
									} else {
										setIsEditing(true);
									}
								}}
								title={hasFields ? "Edit" : "Edit URL"}
								aria-label={hasFields ? "Edit" : "Edit URL"}
							>
								<Pencil className="h-4 w-4" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								shape="square"
								className="h-8 w-8 text-kumo-danger hover:text-kumo-danger hover:bg-kumo-danger/10"
								onClick={() => deleteNode()}
								title="Delete"
								aria-label="Delete embed"
							>
								<Trash className="h-4 w-4" />
							</Button>
						</div>
					</div>

					{/* Inline URL editor - slides down when editing */}
					{isEditing && (
						<div className="px-4 pb-3 pt-0">
							<div className="flex gap-2">
								<Input
									ref={inputRef}
									type="url"
									value={editValue}
									onChange={(e) => setEditValue(e.target.value)}
									onKeyDown={handleKeyDown}
									placeholder={placeholder}
									className="flex-1 h-9 text-sm font-mono"
								/>
								<Button
									type="button"
									variant="ghost"
									shape="square"
									className="h-9 w-9"
									onClick={handleCancel}
									title="Cancel (Esc)"
									aria-label="Cancel"
								>
									<X className="h-4 w-4" />
								</Button>
								<Button
									type="button"
									variant="primary"
									shape="square"
									className="h-9 w-9"
									onClick={handleSave}
									title="Save (Enter)"
									aria-label="Save"
								>
									<Check className="h-4 w-4" />
								</Button>
							</div>
						</div>
					)}
				</div>
			</div>
		</NodeViewWrapper>
	);
}

/**
 * TipTap Node extension for plugin blocks (embeds)
 */
export const PluginBlockExtension = Node.create({
	name: "pluginBlock",
	group: "block",
	atom: true,
	draggable: true,
	selectable: true,

	addAttributes() {
		return {
			blockType: {
				default: null,
			},
			id: {
				default: null,
			},
			data: {
				default: {},
				parseHTML: (el: HTMLElement) => JSON.parse(el.getAttribute("data-plugin-data") || "{}"),
				renderHTML: (attrs: Record<string, unknown>) => ({
					"data-plugin-data": JSON.stringify(attrs.data),
				}),
			},
		};
	},

	addStorage() {
		return {
			/** Per-editor registry of plugin block definitions */
			registry: new Map<string, PluginBlockDef>(),
			/** Callback set by PortableTextEditor to open the Block Kit modal for editing */
			onEditBlock: null as
				| ((attrs: {
						blockType: string;
						id: string;
						data: Record<string, unknown>;
						pos: number;
				  }) => void)
				| null,
		};
	},

	parseHTML() {
		return [
			{
				tag: "div[data-plugin-block]",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-plugin-block": "" })];
	},

	addNodeView() {
		return ReactNodeViewRenderer(PluginBlockNodeView);
	},

	addKeyboardShortcuts() {
		return {
			// Delete block on backspace when selected (not editing)
			Backspace: () => {
				const { selection } = this.editor.state;
				const node = this.editor.state.doc.nodeAt(selection.from);
				if (node?.type.name === "pluginBlock") {
					this.editor.commands.deleteSelection();
					return true;
				}
				return false;
			},
			// Also handle Delete key
			Delete: () => {
				const { selection } = this.editor.state;
				const node = this.editor.state.doc.nodeAt(selection.from);
				if (node?.type.name === "pluginBlock") {
					this.editor.commands.deleteSelection();
					return true;
				}
				return false;
			},
		};
	},
});

// Re-export helpers for use elsewhere
export { getEmbedMeta, resolveIcon };
