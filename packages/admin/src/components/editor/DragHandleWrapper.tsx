/**
 * Drag Handle Wrapper Component
 *
 * Wraps TipTap's official DragHandle React component with our BlockMenu.
 * This component provides:
 * - Drag handles that appear on block hover
 * - Actual drag-and-drop block reordering (handled by TipTap)
 * - Block menu integration for transforms, duplicate, delete
 */

import { useLingui } from "@lingui/react/macro";
import { DotsSixVertical } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as React from "react";

import { cn } from "../../lib/utils";
import { BlockMenu } from "./BlockMenu";

interface DragHandleWrapperProps {
	editor: Editor;
}

interface HoveredNode {
	node: PMNode;
	pos: number;
}

// Extend Editor commands type to include DragHandle commands
declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		dragHandle: {
			lockDragHandle: () => ReturnType;
			unlockDragHandle: () => ReturnType;
			toggleDragHandle: () => ReturnType;
		};
	}
}

/**
 * DragHandleWrapper - Official TipTap drag handle with BlockMenu integration
 */
export function DragHandleWrapper({ editor }: DragHandleWrapperProps) {
	const { t } = useLingui();
	const [hoveredNode, setHoveredNode] = React.useState<HoveredNode | null>(null);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
	const handleRef = React.useRef<HTMLButtonElement>(null);

	// Handle click on drag handle to open menu
	const handleClick = React.useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (!hoveredNode) return;

			// Select the block in the editor
			editor.chain().setNodeSelection(hoveredNode.pos).run();

			// Open the menu
			setMenuAnchor(handleRef.current);
			setMenuOpen(true);

			// Lock the drag handle so it stays visible while menu is open
			editor.commands.lockDragHandle();
		},
		[editor, hoveredNode],
	);

	// Close the menu
	const handleCloseMenu = React.useCallback(() => {
		setMenuOpen(false);
		setMenuAnchor(null);
		editor.commands.unlockDragHandle();
	}, [editor]);

	// Handle node change from drag handle
	const handleNodeChange = React.useCallback(
		(data: { node: PMNode | null; editor: Editor; pos: number }) => {
			if (data.node) {
				setHoveredNode({ node: data.node, pos: data.pos });
			} else {
				// Only clear if menu is not open
				if (!menuOpen) {
					setHoveredNode(null);
				}
			}
		},
		[menuOpen],
	);

	// Stable reference — DragHandle's useEffect depends on this by reference.
	// An inline object causes plugin unregister/register every render, which
	// tears down the Suggestion plugin view (calling onExit → setState → loop).
	const computePositionConfig = React.useMemo(
		() => ({
			placement: "left-start" as const,
			strategy: "absolute" as const,
		}),
		[],
	);

	return (
		<>
			<DragHandle
				editor={editor}
				onNodeChange={handleNodeChange}
				computePositionConfig={computePositionConfig}
			>
				<button
					ref={handleRef}
					type="button"
					className={cn(
						"flex items-center justify-center",
						"w-6 h-6 rounded select-none",
						"text-kumo-subtle/50 hover:text-kumo-subtle",
						"hover:bg-kumo-tint/80 cursor-grab active:cursor-grabbing",
						"transition-colors duration-100",
						menuOpen && "text-kumo-subtle bg-kumo-tint",
					)}
					onClick={handleClick}
					data-block-handle
					aria-label={t`Block actions - drag to reorder, click for menu`}
				>
					<DotsSixVertical className="h-4 w-4" />
				</button>
			</DragHandle>

			{/* Block menu */}
			<BlockMenu
				editor={editor}
				anchorElement={menuAnchor}
				isOpen={menuOpen}
				onClose={handleCloseMenu}
			/>
		</>
	);
}
