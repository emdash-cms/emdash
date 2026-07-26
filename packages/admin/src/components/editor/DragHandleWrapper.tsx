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
import type { DragHandleRule } from "@tiptap/extension-drag-handle";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { BlockMenu } from "./BlockMenu";
import { NESTING_GUTTER_PX } from "./NestingBlockNode";

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
 * A top level row's handle sits outside it, in the editor's own gutter. A row in a
 * column carries that gutter as its own leading padding, so the handle moves back
 * across the row's edge to land inside it. Must agree with NESTING_GUTTER_PX.
 */
export function _dragHandleOffset(insideColumn: boolean): number {
	return insideColumn ? -(NESTING_GUTTER_PX - 4) : 4;
}

/**
 * Resolved from the document rather than the hovered element, which is virtual and
 * carries only a rect. `pos` is the position before the row, so its parent is the
 * column that would hold it.
 */
export function _isInsideNestingColumn(editor: Editor, pos: number): boolean {
	if (pos < 0) return false;
	try {
		return editor.state.doc.resolve(pos).parent.type.name === "nestingColumn";
	} catch {
		// A stale position between transactions -- treat as top level.
		return false;
	}
}

/**
 * Drag unit: direct children of the document or of a nesting column.
 * Table internals and inline content are excluded by the schema.
 */
export const _rowsOnlyRule: DragHandleRule = {
	id: "emdashRowsOnly",
	evaluate: ({ node, depth, $pos }) => {
		const EXCLUDE = 1000;
		if (node.type.name === "nestingColumn") return EXCLUDE;
		if (depth <= 1) return 0;
		return $pos.node(depth - 1).type.name === "nestingColumn" ? 0 : EXCLUDE;
	},
};

/** Module level: DragHandle re-registers its plugin if this identity changes. */
export const _nestedDragOptions = {
	rules: [_rowsOnlyRule],
	defaultRules: false,
	edgeDetection: "none" as const,
};

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

	// Set in onNodeChange, read by the offset middleware that runs straight after it.
	const insideColumnRef = React.useRef(false);

	// Handle node change from drag handle
	const handleNodeChange = React.useCallback(
		(data: { node: PMNode | null; editor: Editor; pos: number }) => {
			insideColumnRef.current = data.node ? _isInsideNestingColumn(data.editor, data.pos) : false;
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
			middleware: [offset(() => _dragHandleOffset(insideColumnRef.current))],
		}),
		[direction],
	);

	return (
		<>
			<DragHandle
				editor={editor}
				onNodeChange={handleNodeChange}
				computePositionConfig={computePositionConfig}
				nested={_nestedDragOptions}
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
