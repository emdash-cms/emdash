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
 * How far to place the handle from the row it belongs to.
 *
 * A top level row sits inside the editor's own 64px gutter, so its handle goes just
 * outside the row. A row inside a nesting column carries the gutter as its own
 * leading padding instead (see NESTING_GUTTER_PX), which is what lets a pointer in
 * the gutter still resolve to that row -- so the handle has to come *back* across
 * the row's edge to land in that padding rather than out over the column beside it.
 */
export function _dragHandleOffset(insideColumn: boolean): number {
	return insideColumn ? -(NESTING_GUTTER_PX - 4) : 4;
}

/**
 * Is the row at `pos` a child of a nesting column?
 *
 * Read from the document, because the handle positions against a virtual element
 * that carries only a rect with no way back to the node it came from. `pos` is the
 * position before the row, so its parent is the column that would hold it -- only
 * the immediate parent is checked, because only a direct child of a column is ever
 * a drag target.
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
 * The draggable unit is a row: a child of the document, or a child of a nesting
 * column, which is the same thing one level down.
 *
 * This is what the editor already did. With nested targeting off, TipTap targets
 * top level blocks, so a list drags as one block and its items do not drag at all.
 * The rule restates that and extends it into columns, which is why behaviour
 * outside a container is unchanged by enabling nesting.
 *
 * It deliberately replaces TipTap's default rules rather than joining them, and
 * that is a choice about units, not a claim that they are wrong. Their defaults
 * resolve the unit *inside* a structure: for a list, `listItemFirstChild` and
 * `listWrapperDeprioritize` between them exclude the paragraph and the wrapper so
 * the list item wins. That is right for a plain document and wrong for a page
 * built from containers, where a list is one row a page is composed of and its
 * items are the row's internals. The two cannot both hold, and picking theirs
 * means a list can no longer be moved as a block anywhere in the document.
 *
 * Nothing the defaults guard is lost. Table internals and inline content are
 * never children of the document or of a column, so they are excluded here by
 * construction; the tests assert that rather than assuming it.
 *
 * Columns themselves are never a target either: `selectable: false`, and they are
 * added and removed from the container's toolbar.
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

/**
 * Nested targeting, so a block inside a nesting column can be reordered.
 *
 * Edge detection is off, and follows from the same choice. It resolves ambiguity by
 * pointer position, deducting by depth near a node's edge so the parent wins there.
 * With rows as the unit there is no ambiguity left to resolve: a column is never a
 * target, so the only candidates are the row and its container, and the container
 * has an explicit grab point of its own in its header. Leaving it on only breaks
 * things, because the deduction excludes a candidate outright at the depth a row
 * sits inside a column, and rows are often short enough that the 12px band covers
 * half of one.
 *
 * The handle's placement depends on this too. The gutter it sits in belongs to the
 * row, so a target deeper than a row is measured from the wrong box and the handle
 * lands over the content instead of beside it.
 *
 * Module level so the reference is stable: DragHandle's effect depends on it, and a
 * fresh object each render re-registers the plugin.
 */
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

	// Written synchronously here and read by the offset middleware, which the drag
	// handle invokes immediately afterwards to reposition.
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
