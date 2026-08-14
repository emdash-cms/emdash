/**
 * Block Menu Component
 *
 * Floating menu that appears when a block is selected via drag handle click.
 * Provides block actions:
 * - Turn into (transform to different block type)
 * - Duplicate
 * - Delete
 *
 * Uses Kumo's menu primitive, anchored to the selected block's drag handle.
 */

import { Button, DropdownMenu } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	DotsSixVertical,
	Paragraph,
	TextHOne,
	TextHTwo,
	TextHThree,
	TextHFour,
	TextHFive,
	TextHSix,
	Quotes,
	Code,
	List,
	ListNumbers,
	Copy,
	Trash,
	type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { CaretNext, CaretPrev } from "../ArrowIcons.js";

/**
 * Block transform options
 */
interface BlockTransform {
	id: string;
	label: MessageDescriptor;
	icon: PhosphorIcon;
	transform: (editor: Editor) => void;
}

const blockTransforms: BlockTransform[] = [
	{
		id: "paragraph",
		label: msg`Paragraph`,
		icon: Paragraph,
		transform: (editor) => {
			editor.chain().focus().setNode("paragraph").run();
		},
	},
	{
		id: "heading1",
		label: msg`Heading 1`,
		icon: TextHOne,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 1 }).run();
		},
	},
	{
		id: "heading2",
		label: msg`Heading 2`,
		icon: TextHTwo,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 2 }).run();
		},
	},
	{
		id: "heading3",
		label: msg`Heading 3`,
		icon: TextHThree,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 3 }).run();
		},
	},
	{
		id: "heading4",
		label: msg`Heading 4`,
		icon: TextHFour,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 4 }).run();
		},
	},
	{
		id: "heading5",
		label: msg`Heading 5`,
		icon: TextHFive,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 5 }).run();
		},
	},
	{
		id: "heading6",
		label: msg`Heading 6`,
		icon: TextHSix,
		transform: (editor) => {
			editor.chain().focus().setNode("heading", { level: 6 }).run();
		},
	},
	{
		id: "blockquote",
		label: msg`Quote`,
		icon: Quotes,
		transform: (editor) => {
			editor.chain().focus().toggleBlockquote().run();
		},
	},
	{
		id: "codeBlock",
		label: msg`Code Block`,
		icon: Code,
		transform: (editor) => {
			editor.chain().focus().toggleCodeBlock().run();
		},
	},
	{
		id: "bulletList",
		label: msg`Bullet List`,
		icon: List,
		transform: (editor) => {
			editor.chain().focus().toggleBulletList().run();
		},
	},
	{
		id: "orderedList",
		label: msg`Numbered List`,
		icon: ListNumbers,
		transform: (editor) => {
			editor.chain().focus().toggleOrderedList().run();
		},
	},
];

const POPOVER_TRANSITION_MS = 150;

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
	const { i18n, t } = useLingui();
	const [showTransforms, setShowTransforms] = React.useState(false);
	const anchorRef = React.useRef<HTMLElement | null>(anchorElement);
	const menuActionsRef = React.useRef<{ unmount: () => void; close: () => void } | null>(null);
	const direction = getLocaleDir(i18n.locale);

	React.useLayoutEffect(() => {
		if (anchorElement) anchorRef.current = anchorElement;
	}, [anchorElement]);

	React.useEffect(() => {
		if (isOpen) return;

		setShowTransforms(false);
		const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches
			? 0
			: POPOVER_TRANSITION_MS;
		const timer = window.setTimeout(() => menuActionsRef.current?.unmount(), delay);
		return () => window.clearTimeout(timer);
	}, [isOpen]);

	const handleDuplicate = () => {
		if (!(editor.state.selection instanceof NodeSelection)) {
			return;
		}

		const { selection, doc } = editor.state;
		const { from, to } = selection;
		const slice = doc.slice(from, to);
		editor
			.chain()
			.focus()
			.command(({ tr }) => {
				tr.insert(to, slice.content);
				return true;
			})
			.run();
	};

	const handleDelete = () => {
		if (!(editor.state.selection instanceof NodeSelection)) {
			return;
		}

		editor.chain().focus().deleteSelection().run();
	};

	const handleTransform = (transform: BlockTransform) => {
		transform.transform(editor);
	};

	return (
		<DropdownMenu
			actionsRef={menuActionsRef}
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
				if (showTransforms && eventDetails.reason === "escape-key") {
					eventDetails.cancel();
					setShowTransforms(false);
					return;
				}
				eventDetails.preventUnmountOnClose();
				onClose();
			}}
		>
			<DropdownMenu.Content
				anchor={anchorRef}
				side={direction === "rtl" ? "right" : "left"}
				align="start"
				collisionPadding={8}
				className={cn(
					"z-[100] min-w-[180px] max-h-[min(300px,var(--available-height))] overflow-y-auto overscroll-contain scroll-py-1",
					"bg-kumo-base text-sm shadow-kumo-tip-shadow ring-kumo-fill",
					"origin-(--transform-origin) transition-[transform,scale,opacity] duration-150",
					"data-starting-style:scale-90 data-starting-style:opacity-0",
					"data-ending-style:scale-90 data-ending-style:opacity-0",
					"data-[state=open]:animate-none data-[state=closed]:animate-none motion-reduce:transition-none",
				)}
			>
				{showTransforms ? (
					<>
						<DropdownMenu.Item
							closeOnClick={false}
							data-emdash-block-menu-item
							icon={
								<CaretPrev className="me-2 h-4 w-4 flex-none text-kumo-subtle" aria-hidden="true" />
							}
							className="text-sm"
							onClick={() => setShowTransforms(false)}
						>
							{t`Back`}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						{blockTransforms.map((transform) => (
							<DropdownMenu.Item
								key={transform.id}
								data-emdash-block-menu-item
								icon={
									<transform.icon
										className="me-2 h-4 w-4 flex-none text-kumo-subtle"
										aria-hidden="true"
									/>
								}
								className="text-sm"
								onClick={() => handleTransform(transform)}
							>
								{t(transform.label)}
							</DropdownMenu.Item>
						))}
					</>
				) : (
					<>
						<DropdownMenu.Item
							closeOnClick={false}
							data-emdash-block-menu-item
							icon={
								<Paragraph className="me-2 h-4 w-4 flex-none text-kumo-subtle" aria-hidden="true" />
							}
							className="text-sm"
							onClick={() => setShowTransforms(true)}
						>
							{t`Turn into`}
							<CaretNext
								className="ms-auto h-4 w-4 flex-none text-kumo-subtle"
								aria-hidden="true"
							/>
						</DropdownMenu.Item>
						<DropdownMenu.Item
							data-emdash-block-menu-item
							icon={<Copy className="me-2 h-4 w-4 flex-none text-kumo-subtle" aria-hidden="true" />}
							className="text-sm"
							onClick={handleDuplicate}
						>
							{t`Duplicate`}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							variant="danger"
							icon={<Trash className="me-2 h-4 w-4 flex-none" aria-hidden="true" />}
							className="text-sm"
							onClick={handleDelete}
						>
							{t`Delete`}
						</DropdownMenu.Item>
					</>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
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
