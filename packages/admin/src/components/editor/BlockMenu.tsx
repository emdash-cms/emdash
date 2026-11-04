/**
 * Block Menu Component
 *
 * Opens from the drag handle's ⋮⋮ button with the block already node-selected.
 * Offers Turn into, alignment, numbering, duplicate, move, and delete.
 */

import { Menu } from "@cloudflare/kumo/primitives/menu";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowDown,
	ArrowsClockwise,
	ArrowUUpLeft,
	ArrowUUpRight,
	ArrowUp,
	Copy,
	TextAlignCenter,
	TextAlignLeft,
	TextAlignRight,
	Trash,
} from "@phosphor-icons/react";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { duplicateBlocks, moveBlocks } from "./BlockCommands.js";
import { activeTextBlockType, textBlockTypes, turnIntoMenuTypes } from "./blockTypes.js";
import {
	EditorMenuItem,
	EditorMenuLabel,
	EditorMenuRadioItem,
	EditorMenuSeparator,
	EditorSubmenu,
	editorMenuPopupClassName,
	tabToEditor,
} from "./EditorMenu.js";

const NODE_LABELS: Record<string, MessageDescriptor> = {
	image: msg`Image`,
	videoBlock: msg`Video`,
	gallery: msg`Gallery`,
	table: msg`Table`,
	horizontalRule: msg`Divider`,
	htmlBlock: msg`HTML`,
	iframeBlock: msg`Iframe`,
	pluginBlock: msg`Embed`,
};

const ALIGNMENTS = [
	{ value: "left", label: msg`Left`, icon: TextAlignLeft },
	{ value: "center", label: msg`Center`, icon: TextAlignCenter },
	{ value: "right", label: msg`Right`, icon: TextAlignRight },
] as const;

interface BlockMenuProps {
	editor: Editor;
	/** The DOM element of the selected block (for positioning) */
	anchorElement: HTMLElement | null;
	/** Whether the menu is open */
	isOpen: boolean;
	/** Callback to close the menu */
	onClose: () => void;
	/** Callback after the menu's exit transition completes */
	onCloseComplete?: () => void;
}

/**
 * Block Menu - floating menu for block-level actions
 */
export function BlockMenu({
	editor,
	anchorElement,
	isOpen,
	onClose,
	onCloseComplete,
}: BlockMenuProps) {
	const { t } = useLingui();
	const anchorRef = React.useRef<HTMLElement | null>(anchorElement);

	React.useLayoutEffect(() => {
		if (anchorElement) anchorRef.current = anchorElement;
	}, [anchorElement]);

	const selection = editor.state.selection;
	const selectedNode = selection instanceof NodeSelection ? selection.node : null;
	const blockIndex = selection instanceof NodeSelection ? selection.$from.index(0) : -1;
	const activeType = selectedNode ? activeTextBlockType(editor) : undefined;
	const nodeLabel = selectedNode ? NODE_LABELS[selectedNode.type.name] : undefined;
	const blockLabel = activeType ? t(activeType.label) : nodeLabel ? t(nodeLabel) : t`Block`;
	const canAlign = selectedNode?.type.name === "paragraph" || selectedNode?.type.name === "heading";
	// No alignment means the start edge, which is the right in right-to-left text.
	const startAlignment =
		isOpen && getComputedStyle(editor.view.dom).direction === "rtl" ? "right" : "left";
	const currentAlignment =
		typeof selectedNode?.attrs.textAlign === "string"
			? selectedNode.attrs.textAlign
			: startAlignment;
	const isOrderedList = selectedNode?.type.name === "orderedList";

	const handleDelete = () => {
		if (!(editor.state.selection instanceof NodeSelection)) return;
		editor.chain().focus().deleteSelection().run();
	};

	return (
		<Menu.Root
			open={isOpen}
			modal={false}
			onOpenChangeComplete={(open) => {
				if (!open) onCloseComplete?.();
			}}
			onOpenChange={(open, eventDetails) => {
				if (open) return;
				if (eventDetails.reason === "trigger-hover") {
					eventDetails.cancel();
					return;
				}
				onClose();
			}}
		>
			{/* Base UI registers a menu in its floating tree through a trigger. Without
			    one, opening the Turn into submenu reads as a sibling opening and closes
			    this menu, so a hidden trigger stands in for the drag handle. */}
			<Menu.Trigger tabIndex={-1} aria-hidden="true" className="sr-only" />
			<Menu.Portal>
				<Menu.Positioner
					anchor={anchorRef}
					side="inline-start"
					align="start"
					sideOffset={6}
					collisionPadding={8}
					className="z-[100]"
				>
					<Menu.Popup
						aria-label={t`Block actions`}
						finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
						onKeyDown={tabToEditor(editor, onClose)}
						className={cn(editorMenuPopupClassName, "w-60")}
					>
						<Menu.Group>
							<EditorMenuLabel>{blockLabel}</EditorMenuLabel>
							{activeType && (
								<EditorSubmenu icon={ArrowsClockwise} label={t`Turn into`}>
									<Menu.RadioGroup
										value={activeType.id}
										onValueChange={(id) =>
											textBlockTypes.find((type) => type.id === id)?.transform(editor)
										}
									>
										{turnIntoMenuTypes(activeType.id).map((type) => (
											<EditorMenuRadioItem
												key={type.id}
												value={type.id}
												icon={type.icon}
												label={t(type.label)}
											/>
										))}
									</Menu.RadioGroup>
								</EditorSubmenu>
							)}
							{canAlign && (
								<EditorSubmenu icon={TextAlignLeft} label={t`Align`}>
									<Menu.RadioGroup
										value={currentAlignment}
										onValueChange={(value: string) =>
											editor.chain().focus().setTextAlign(value).run()
										}
									>
										{ALIGNMENTS.map((alignment) => (
											<EditorMenuRadioItem
												key={alignment.value}
												value={alignment.value}
												icon={alignment.icon}
												label={t(alignment.label)}
											/>
										))}
									</Menu.RadioGroup>
								</EditorSubmenu>
							)}
							{isOrderedList && (
								<>
									<EditorMenuItem
										icon={ArrowUUpRight}
										label={t`Continue numbering`}
										disabled={!editor.can().continueOrderedList()}
										onClick={() => editor.chain().focus().continueOrderedList().run()}
									/>
									<EditorMenuItem
										icon={ArrowUUpLeft}
										label={t`Restart numbering`}
										disabled={!editor.can().restartOrderedList()}
										onClick={() => editor.chain().focus().restartOrderedList().run()}
									/>
								</>
							)}
							<EditorMenuItem
								icon={Copy}
								label={t`Duplicate`}
								onClick={() => duplicateBlocks(editor)}
							/>
							<EditorMenuItem
								icon={ArrowUp}
								label={t`Move up`}
								disabled={blockIndex <= 0}
								onClick={() => moveBlocks(editor, "up")}
							/>
							<EditorMenuItem
								icon={ArrowDown}
								label={t`Move down`}
								disabled={blockIndex < 0 || blockIndex >= editor.state.doc.childCount - 1}
								onClick={() => moveBlocks(editor, "down")}
							/>
						</Menu.Group>
						<EditorMenuSeparator />
						<EditorMenuItem icon={Trash} label={t`Delete`} danger onClick={handleDelete} />
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
