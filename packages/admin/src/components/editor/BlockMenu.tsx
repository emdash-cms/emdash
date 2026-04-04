/**
 * Block Menu Component
 *
 * Floating menu that appears when a block is selected via drag handle click.
 * Provides block actions:
 * - Turn into (transform to different block type)
 * - Duplicate
 * - Delete
 *
 * Uses Floating UI for positioning relative to the selected block.
 */

import { Button } from "@cloudflare/kumo";
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react";
import { useLingui } from "@lingui/react/macro";
import {
	DotsSixVertical,
	Paragraph,
	TextHOne,
	TextHTwo,
	TextHThree,
	Quotes,
	Code,
	List,
	ListNumbers,
	Copy,
	Trash,
	CaretRight,
	type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { createPortal } from "react-dom";

import { useStableCallback } from "../../lib/hooks";
import { cn } from "../../lib/utils";

/**
 * Block transform options
 */
interface BlockTransform {
	id: string;
	label: string;
	icon: PhosphorIcon;
	transform: (editor: Editor) => void;
}

const blockTransforms: BlockTransform[] = [
	{
		id: "paragraph",
		label: "Paragraph",
		icon: Paragraph,
		transform: (editor) => {
			editor.chain().focus().setNode("paragraph").run();
		},
	},
	{
		id: "heading1",
		label: "Heading 1",
		icon: TextHOne,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 1 }).run();
		},
	},
	{
		id: "heading2",
		label: "Heading 2",
		icon: TextHTwo,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 2 }).run();
		},
	},
	{
		id: "heading3",
		label: "Heading 3",
		icon: TextHThree,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 3 }).run();
		},
	},
	{
		id: "blockquote",
		label: "Quote",
		icon: Quotes,
		transform: (editor) => {
			editor.chain().focus().toggleBlockquote().run();
		},
	},
	{
		id: "codeBlock",
		label: "Code Block",
		icon: Code,
		transform: (editor) => {
			editor.chain().focus().toggleCodeBlock().run();
		},
	},
	{
		id: "bulletList",
		label: "Bullet List",
		icon: List,
		transform: (editor) => {
			editor.chain().focus().toggleBulletList().run();
		},
	},
	{
		id: "orderedList",
		label: "Numbered List",
		icon: ListNumbers,
		transform: (editor) => {
			editor.chain().focus().toggleOrderedList().run();
		},
	},
];

interface BlockMenuProps {
	editor: Editor;
	/** The DOM element of the selected block (for positioning) */
	anchorElement: HTMLElement | null;
	/** Whether the menu is open */
	isOpen: boolean;
	/** Callback to close the menu */
	onClose: () => void;
}

/**
 * Block Menu - floating menu for block-level actions
 */
export function BlockMenu({ editor, anchorElement, isOpen, onClose }: BlockMenuProps) {
	const { t } = useLingui();
	const transformLabels: Record<string, string> = {
		paragraph: t`Paragraph`,
		heading1: t`Heading 1`,
		heading2: t`Heading 2`,
		heading3: t`Heading 3`,
		blockquote: t`Quote`,
		codeBlock: t`Code Block`,
		bulletList: t`Bullet List`,
		orderedList: t`Numbered List`,
	};
	const [showTransforms, setShowTransforms] = React.useState(false);
	const menuRef = React.useRef<HTMLDivElement>(null);
	const stableOnClose = useStableCallback(onClose);

	const { refs, floatingStyles } = useFloating({
		open: isOpen,
		placement: "left-start",
		middleware: [offset({ mainAxis: 8, crossAxis: 0 }), flip(), shift({ padding: 8 })],
		whileElementsMounted: autoUpdate,
	});

	// Sync the anchor element
	React.useEffect(() => {
		if (anchorElement) {
			refs.setReference(anchorElement);
		}
	}, [anchorElement, refs]);

	// Close on escape
	React.useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				if (showTransforms) {
					setShowTransforms(false);
				} else {
					stableOnClose();
				}
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, stableOnClose, showTransforms]);

	// Close on click outside
	React.useEffect(() => {
		if (!isOpen) return;

		const handleClickOutside = (e: MouseEvent) => {
			const target = e.target;
			// Don't close if clicking on the drag handle or menu itself
			if (target instanceof Node && menuRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-block-handle]")) return;

			stableOnClose();
		};

		// Delay to avoid immediate close from the click that opened it
		const timer = setTimeout(() => {
			document.addEventListener("mousedown", handleClickOutside);
		}, 0);

		return () => {
			clearTimeout(timer);
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [isOpen, stableOnClose]);

	// Reset submenu state when menu closes
	React.useEffect(() => {
		if (!isOpen) {
			setShowTransforms(false);
		}
	}, [isOpen]);

	const handleDuplicate = () => {
		const { selection } = editor.state;
		const { $from, $to } = selection;

		// Get the block node at current position
		const blockStart = $from.start($from.depth);
		const blockEnd = $to.end($to.depth);

		// Get the content to duplicate
		const slice = editor.state.doc.slice(blockStart, blockEnd);

		// Insert after current block
		editor
			.chain()
			.focus()
			.command(({ tr }) => {
				tr.insert(blockEnd + 1, slice.content);
				return true;
			})
			.run();

		onClose();
	};

	const handleDelete = () => {
		editor.chain().focus().deleteNode(editor.state.selection.$from.parent.type.name).run();
		onClose();
	};

	const handleTransform = (transform: BlockTransform) => {
		transform.transform(editor);
		onClose();
	};

	if (!isOpen) return null;

	return createPortal(
		<div
			ref={(node) => {
				menuRef.current = node;
				refs.setFloating(node);
			}}
			style={floatingStyles}
			className="z-[100] rounded-lg border bg-kumo-overlay shadow-lg min-w-[180px] overflow-hidden"
		>
			{showTransforms ? (
				// Transform submenu
				<div className="py-1">
					<button
						type="button"
						className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-kumo-tint text-left"
						onClick={() => setShowTransforms(false)}
					>
						<CaretRight className="h-4 w-4 rotate-180" />
						<span>{t`Back`}</span>
					</button>
					<div className="h-px bg-kumo-line my-1" />
					{blockTransforms.map((transform) => (
						<button
							key={transform.id}
							type="button"
							className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-kumo-tint text-left"
							onClick={() => handleTransform(transform)}
						>
							<transform.icon className="h-4 w-4 text-kumo-subtle" />
							<span>{transformLabels[transform.id] ?? transform.label}</span>
						</button>
					))}
				</div>
			) : (
				// Main menu
				<div className="py-1">
					<button
						type="button"
						className="flex items-center justify-between w-full px-3 py-2 text-sm hover:bg-kumo-tint text-left"
						onClick={() => setShowTransforms(true)}
					>
						<span className="flex items-center gap-2">
							<Paragraph className="h-4 w-4 text-kumo-subtle" />
							<span>{t`Turn into`}</span>
						</span>
						<CaretRight className="h-4 w-4 text-kumo-subtle" />
					</button>
					<button
						type="button"
						className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-kumo-tint text-left"
						onClick={handleDuplicate}
					>
						<Copy className="h-4 w-4 text-kumo-subtle" />
						<span>{t`Duplicate`}</span>
					</button>
					<div className="h-px bg-kumo-line my-1" />
					<button
						type="button"
						className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-kumo-tint text-left text-kumo-danger"
						onClick={handleDelete}
					>
						<Trash className="h-4 w-4" />
						<span>{t`Delete`}</span>
					</button>
				</div>
			)}
		</div>,
		document.body,
	);
}

/**
 * Block Drag Handle Component
 *
 * Shown in the left gutter of each block. Clicking opens the block menu,
 * dragging reorders blocks.
 */
interface BlockHandleProps {
	onClick: (e: React.MouseEvent) => void;
	onDragStart?: (e: React.DragEvent) => void;
	selected?: boolean;
}

export function BlockHandle({ onClick, onDragStart, selected }: BlockHandleProps) {
	const { t } = useLingui();
	return (
		<Button
			type="button"
			variant="ghost"
			shape="square"
			className={cn(
				"h-6 w-6 cursor-grab active:cursor-grabbing",
				"text-kumo-subtle/50 hover:text-kumo-subtle",
				selected && "text-kumo-subtle",
			)}
			onClick={onClick}
			onDragStart={onDragStart}
			draggable
			data-block-handle
			aria-label={t`Drag to reorder block`}
		>
			<DotsSixVertical className="h-4 w-4" />
		</Button>
	);
}

export { blockTransforms };
export type { BlockTransform };
