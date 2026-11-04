/**
 * Drag Handle Wrapper Component
 *
 * Wraps TipTap's official DragHandle React component with our BlockMenu.
 * This component provides:
 * - Drag handles that appear on block hover
 * - Actual drag-and-drop block reordering (handled by TipTap)
 * - Block menu integration for transforms, duplicate, delete
 */

import { Button, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import { offset } from "@floating-ui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import { DotsSixVertical, Plus } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import type { Node as PMNode } from "@tiptap/pm/model";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { enterBlockSelection } from "./BlockCommands.js";
import { BlockMenu } from "./BlockMenu";

interface DragHandleWrapperProps {
	editor: Editor;
	onInsertBlock: (insertPos: number) => void;
}

interface HoveredNode {
	node: PMNode;
	pos: number;
}

const HANDLE_SIZE_PX = 24;
const TEXT_BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6";

export function _getDragHandlePlacement(direction: "ltr" | "rtl") {
	return direction === "rtl" ? ("right-start" as const) : ("left-start" as const);
}

/**
 * How far to push the handle down so it centers on the block's first line
 * of text, a code block's header row, or a table's first row. Media and
 * embeds keep it near the top.
 */
function firstLineOffset(block: HTMLElement): number {
	if (block.matches("hr")) return (block.offsetHeight - HANDLE_SIZE_PX) / 2;
	const codeControls = block.matches(".node-codeBlock")
		? block.querySelector<HTMLElement>(".emdash-code-block-controls")
		: null;
	if (codeControls) {
		const row = codeControls.getBoundingClientRect();
		return Math.max(
			0,
			row.top - block.getBoundingClientRect().top + (row.height - HANDLE_SIZE_PX) / 2,
		);
	}
	const line = block.matches(TEXT_BLOCK_SELECTOR)
		? block
		: block.matches("ul, ol, blockquote, .tableWrapper")
			? block.querySelector<HTMLElement>(TEXT_BLOCK_SELECTOR)
			: null;
	if (!line) return 4;
	const style = getComputedStyle(line);
	const lineHeight = Number.parseFloat(style.lineHeight);
	if (!Number.isFinite(lineHeight)) return 0;
	const top =
		line.getBoundingClientRect().top -
		block.getBoundingClientRect().top +
		Number.parseFloat(style.paddingTop);
	return Math.max(0, top + (lineHeight - HANDLE_SIZE_PX) / 2);
}

/**
 * DragHandleWrapper - Official TipTap drag handle with BlockMenu integration
 */
export function DragHandleWrapper({ editor, onInsertBlock }: DragHandleWrapperProps) {
	const { i18n, t } = useLingui();
	const direction = getLocaleDir(i18n.locale);
	const [hoveredNode, setHoveredNode] = React.useState<HoveredNode | null>(null);
	const [lineOffset, setLineOffset] = React.useState(0);
	const [menuOpen, setMenuOpen] = React.useState(false);
	const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);
	const handleRef = React.useRef<HTMLButtonElement>(null);
	const insertPressLockedRef = React.useRef(false);
	const insertHoverLockedRef = React.useRef(false);

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
			editor.commands.setMeta("lockDragHandle", menuOpen || insertHoverLockedRef.current);
		}
	}, [editor, menuOpen]);

	// TipTap hides the handle on any key press while the editor has focus,
	// including the Alt that Alt-click on + needs, so it stays while hovered.
	const lockWhileHovered = React.useCallback(() => {
		insertHoverLockedRef.current = true;
		editor.commands.setMeta("lockDragHandle", true);
	}, [editor]);
	const unlockAfterHover = React.useCallback(() => {
		insertHoverLockedRef.current = false;
		if (!insertPressLockedRef.current) editor.commands.setMeta("lockDragHandle", menuOpen);
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

			// Select the block, and let the arrow keys move between blocks from there
			editor.chain().setNodeSelection(hoveredNode.pos).run();
			enterBlockSelection(editor);

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

			onInsertBlock(e.altKey ? hoveredNode.pos : hoveredNode.pos + hoveredNode.node.nodeSize);
		},
		[hoveredNode, onInsertBlock],
	);

	// Close the menu
	const handleCloseMenu = React.useCallback(() => {
		setMenuOpen(false);
	}, []);

	const handleMenuCloseComplete = React.useCallback(() => {
		setMenuAnchor(null);
		editor.commands.setMeta("lockDragHandle", false);
	}, [editor]);

	// The block menu renders outside the editor, so the selected block's
	// highlight needs another signal to stay visible while the menu has focus.
	React.useEffect(() => {
		if (!menuOpen) return;
		const root = editor.view.dom.closest("[data-emdash-editor-floating-root]");
		root?.setAttribute("data-emdash-block-menu-open", "");
		return () => root?.removeAttribute("data-emdash-block-menu-open");
	}, [editor, menuOpen]);

	// Handle node change from drag handle
	const handleNodeChange = React.useCallback(
		(data: { node: PMNode | null; editor: Editor; pos: number }) => {
			if (!data.node) {
				setHoveredNode(null);
				return;
			}
			setHoveredNode({ node: data.node, pos: data.pos });
			const dom = data.editor.view.nodeDOM(data.pos);
			setLineOffset(dom instanceof HTMLElement ? firstLineOffset(dom) : 0);
		},
		[],
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

	const handleButtonClass = cn(
		"flex-none rounded-md text-kumo-subtle select-none",
		"hover:bg-kumo-tint hover:text-kumo-default",
	);

	return (
		<>
			<DragHandle
				editor={editor}
				onNodeChange={handleNodeChange}
				computePositionConfig={computePositionConfig}
				className="drag-handle"
			>
				<TooltipProvider>
					<div
						className="flex items-center gap-0.5"
						style={{ transform: `translateY(${lineOffset}px)` }}
					>
						<Tooltip
							side="bottom"
							content={
								<span className="block text-center">
									<Trans>
										<strong className="font-medium">Click</strong> to add below
									</Trans>
									<br />
									<Trans>
										<strong className="font-medium">Alt-click</strong> to add above
									</Trans>
								</span>
							}
							render={
								<Button
									type="button"
									variant="ghost"
									shape="square"
									className={cn(handleButtonClass, "h-6 w-6")}
									onPointerEnter={lockWhileHovered}
									onPointerLeave={unlockAfterHover}
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
									data-block-insert
									aria-label={t`Insert block below`}
								>
									<Plus className="h-4 w-4" weight="bold" aria-hidden="true" />
								</Button>
							}
						/>
						<Tooltip
							side="bottom"
							content={
								<span className="block text-center">
									<Trans>
										<strong className="font-medium">Drag</strong> to move
									</Trans>
									<br />
									<Trans>
										<strong className="font-medium">Click</strong> to open menu
									</Trans>
								</span>
							}
							render={
								<Button
									ref={handleRef}
									type="button"
									variant="ghost"
									shape="square"
									className={cn(
										handleButtonClass,
										"h-6 w-[1.125rem] cursor-grab active:cursor-grabbing",
										menuOpen && "bg-kumo-tint text-kumo-default",
									)}
									onClick={handleClick}
									data-block-handle
									aria-label={t`Block actions - drag to reorder, click for menu`}
									aria-haspopup="menu"
									aria-expanded={menuOpen}
								>
									<DotsSixVertical className="h-4 w-4" weight="bold" aria-hidden="true" />
								</Button>
							}
						/>
					</div>
				</TooltipProvider>
			</DragHandle>

			{/* Block menu */}
			<BlockMenu
				editor={editor}
				anchorElement={menuAnchor}
				isOpen={menuOpen}
				onClose={handleCloseMenu}
				onCloseComplete={handleMenuCloseComplete}
			/>
		</>
	);
}
