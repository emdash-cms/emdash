/**
 * Drag Handle Wrapper Component
 *
 * Wraps TipTap's official DragHandle React component with our BlockMenu.
 * This component provides:
 * - Drag handles that appear on block hover
 * - Actual drag-and-drop block reordering (handled by TipTap)
 * - Block menu integration for transforms, duplicate, delete
 */

import { Button } from "@cloudflare/kumo";
import { offset } from "@floating-ui/react";
import { useLingui } from "@lingui/react/macro";
import { DotsSixVertical, Plus } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { BlockMenu } from "./BlockMenu";

interface DragHandleWrapperProps {
	editor: Editor;
	onInsertBlock: (insertPos: number) => void;
}

interface HoveredNode {
	node: PMNode;
	pos: number;
}

export function _getDragHandlePlacement(direction: "ltr" | "rtl") {
	return direction === "rtl" ? ("right-start" as const) : ("left-start" as const);
}

/**
 * DragHandleWrapper - Official TipTap drag handle with BlockMenu integration
 */
export function DragHandleWrapper({ editor, onInsertBlock }: DragHandleWrapperProps) {
	const { i18n, t } = useLingui();
	const direction = getLocaleDir(i18n.locale);
	const [hoveredNode, setHoveredNode] = React.useState<HoveredNode | null>(null);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
	const handleRef = React.useRef<HTMLButtonElement>(null);
	const insertPressLockedRef = React.useRef(false);

	const disableDrag = React.useCallback(
		(e: React.PointerEvent<HTMLButtonElement>) => {
			e.stopPropagation();
			if (!insertPressLockedRef.current) {
				insertPressLockedRef.current = true;
				editor.commands.setMeta("lockDragHandle", true);
			}
		},
		[editor],
	);

	const restoreDrag = React.useCallback(() => {
		if (insertPressLockedRef.current) {
			insertPressLockedRef.current = false;
			editor.commands.setMeta("lockDragHandle", menuOpen);
		}
	}, [editor, menuOpen]);

	React.useEffect(() => {
		window.addEventListener("pointerup", restoreDrag, true);
		window.addEventListener("pointercancel", restoreDrag, true);
		return () => {
			window.removeEventListener("pointerup", restoreDrag, true);
			window.removeEventListener("pointercancel", restoreDrag, true);
		};
	}, [restoreDrag]);

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
			editor.commands.setMeta("lockDragHandle", true);
		},
		[editor, hoveredNode],
	);

	const handleInsertClick = React.useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (!hoveredNode) return;

			onInsertBlock(hoveredNode.pos + hoveredNode.node.nodeSize);
		},
		[hoveredNode, onInsertBlock],
	);

	// Close the menu
	const handleCloseMenu = React.useCallback(() => {
		setMenuOpen(false);
		setMenuAnchor(null);
		editor.commands.setMeta("lockDragHandle", false);
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
			placement: _getDragHandlePlacement(direction),
			strategy: "absolute" as const,
			middleware: [offset(4)],
		}),
		[direction],
	);

	return (
		<>
			<DragHandle
				editor={editor}
				onNodeChange={handleNodeChange}
				computePositionConfig={computePositionConfig}
			>
				<div className="flex translate-y-0.5 items-center gap-0 rtl:flex-row-reverse">
					<Button
						type="button"
						variant="ghost"
						shape="square"
						className="h-6 w-6 text-kumo-subtle/50 hover:text-kumo-subtle"
						onPointerDown={disableDrag}
						onPointerUp={restoreDrag}
						onPointerCancel={restoreDrag}
						onBlur={restoreDrag}
						onMouseDown={(e) => {
							e.preventDefault();
							e.stopPropagation();
						}}
						onDragStart={(e) => {
							e.preventDefault();
							e.stopPropagation();
						}}
						draggable={false}
						onClick={handleInsertClick}
						aria-label={t`Insert block below`}
					>
						<Plus className="h-4 w-4" aria-hidden="true" />
					</Button>
					<Button
						ref={handleRef}
						type="button"
						variant="ghost"
						shape="square"
						className={cn(
							"h-6 w-6 flex-none rounded select-none",
							"text-kumo-subtle/50 hover:text-kumo-subtle",
							"hover:bg-kumo-tint/80 cursor-grab active:cursor-grabbing",
							"transition-colors duration-100",
							menuOpen && "text-kumo-subtle bg-kumo-tint",
						)}
						onClick={handleClick}
						data-block-handle
						aria-label={t`Block actions - drag to reorder, click for menu`}
					>
						<DotsSixVertical className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
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
