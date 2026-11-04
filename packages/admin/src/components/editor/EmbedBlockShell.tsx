/**
 * Shared parts of the editor's embed blocks (HTML and iframe): the card with
 * its tabs and menu, the lazily loaded code editor, focus and selection
 * handling, and the top-level document node they need.
 */

import { Button, DropdownMenu, Tabs } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { DotsThreeVertical, Trash } from "@phosphor-icons/react";
import { Node, type Editor } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import { enterBlockSelection } from "./BlockCommands.js";
import type { CodeEditorProps } from "./CodeEditor";
import { useAttachedKey } from "./useAttachedKey.js";

const CodeEditor = React.lazy(() => import("./CodeEditor"));

/**
 * Written into the clipboard HTML of embed blocks. Other pages and tabs can't
 * know it, so blocks pasted from them can be told apart.
 */
export const CLIPBOARD_TOKEN = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
	n.toString(36),
).join("");

/**
 * Document node that also accepts `topBlock` nodes. Quotes, list items and
 * table cells accept only `block`, so ProseMirror can't nest a top-level
 * block there, where the Portable Text converters would drop it.
 */
export const TopBlockDocument = Node.create({
	name: "doc",
	topNode: true,
	content: "(block | topBlock)+",
});

/**
 * The code editor owns every event inside it, including dropped text, except
 * blocks dragged from the handle. ProseMirror handles drags and presses
 * elsewhere on the card, so the block can be moved and selected, and the
 * card's own controls handle their events.
 */
function stopEvent(event: Event, draggingBlock: boolean): boolean {
	const target = event.target instanceof Element ? event.target : null;
	const drag = event.type.startsWith("drag") || event.type === "drop";
	if (target?.closest(".cm-editor")) return !(drag && draggingBlock);
	if (drag) return false;
	if (target?.closest("input, button, select, textarea")) return true;
	return event.type !== "mousedown";
}

export function embedBlockNodeView(
	editor: Editor,
	component: Parameters<typeof ReactNodeViewRenderer>[0],
): ReturnType<typeof ReactNodeViewRenderer> {
	return ReactNodeViewRenderer(component, {
		stopEvent: ({ event }) => stopEvent(event, editor.view.dragging !== null),
	});
}

/** Focus an element inside the node-selected embed block. */
function focusInSelectedBlock(editor: Editor, type: NodeType, selector: string): boolean {
	const { selection } = editor.state;
	if (!(selection instanceof NodeSelection) || selection.node.type !== type) return false;
	const dom = editor.view.nodeDOM(selection.from);
	const target = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(selector) : null;
	target?.focus();
	return target !== null && document.activeElement === target;
}

const SELECTED_TAB = "[role='tab'][aria-selected='true']";

/**
 * Enter goes back into the selected block's code editor, and Tab to its tabs,
 * so keyboard users can reach any block's controls.
 */
export function embedBlockKeyboardShortcuts(type: NodeType) {
	return {
		Enter: ({ editor }: { editor: Editor }) =>
			focusInSelectedBlock(editor, type, ".cm-content") ||
			focusInSelectedBlock(editor, type, SELECTED_TAB),
		Tab: ({ editor }: { editor: Editor }) => focusInSelectedBlock(editor, type, SELECTED_TAB),
	};
}

class CodeEditorBoundary extends React.Component<
	{ fallback: React.ReactNode; children: React.ReactNode },
	{ failed: boolean }
> {
	override state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	override render() {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

function CodeEditorLoadError() {
	const { t } = useLingui();
	return (
		<div className="flex flex-wrap items-center gap-3 p-3 text-sm text-kumo-subtle">
			{t`The code editor couldn't load. Save your work, then reload the page.`}
			<Button type="button" size="sm" onClick={() => window.location.reload()}>
				{t`Reload page`}
			</Button>
		</div>
	);
}

/** The code editor, loaded on first use, with a message if its chunk fails to load. */
export function EmbedCodeEditor(props: CodeEditorProps) {
	return (
		<CodeEditorBoundary fallback={<CodeEditorLoadError />}>
			<React.Suspense fallback={<div className="h-40" />}>
				<CodeEditor {...props} />
			</React.Suspense>
		</CodeEditorBoundary>
	);
}

/**
 * Focus and selection for an embed block's code editor:
 * - a new, empty block takes focus once TipTap has finished focusing the
 *   editor, so the first keystroke can't replace the node-selected block;
 * - while the code editor has focus, the editor's selection sits beside the
 *   block, so toolbar actions don't replace it, and pending edits are
 *   written before any press outside the code editor runs its action;
 * - Escape selects the block, as it does in text, and returns focus to the
 *   editor.
 */
export function useEmbedBlockFocus({
	editor,
	getPos,
	flush,
	isEmpty,
}: {
	editor: Editor;
	getPos: NodeViewProps["getPos"];
	/** Writes pending edits. Must be stable. */
	flush: () => void;
	isEmpty: (attrs: Record<string, unknown>) => boolean;
}) {
	const [autoFocus, setAutoFocus] = React.useState(false);
	const cardRef = React.useRef<HTMLDivElement>(null);
	const panelRef = React.useRef<HTMLDivElement>(null);
	const isEmptyRef = React.useRef(isEmpty);
	isEmptyRef.current = isEmpty;

	const flushOnOutsidePress = React.useCallback(
		(event: PointerEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest(".cm-editor") && cardRef.current?.contains(target)) return;
			flush();
		},
		[flush],
	);

	React.useEffect(
		() => () => {
			document.removeEventListener("pointerdown", flushOnOutsidePress, true);
			queueMicrotask(flush);
		},
		[flush, flushOnOutsidePress],
	);

	React.useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const pos = getPos();
			const { selection } = editor.state;
			if (!editor.isEditable || typeof pos !== "number") return;
			if (!(selection instanceof NodeSelection) || selection.from !== pos) return;
			if (!isEmptyRef.current(selection.node.attrs)) return;
			panelRef.current?.focus();
			setAutoFocus(true);
		});
		return () => cancelAnimationFrame(frame);
	}, [editor, getPos]);

	// A gap cursor before a following atom or table, since the toolbar
	// disables inserts inside tables, or else the start of the next text.
	const moveSelectionAfterBlock = () => {
		const pos = getPos();
		if (typeof pos !== "number" || editor.isDestroyed) return;
		const { state } = editor;
		const block = state.doc.nodeAt(pos);
		if (!block) return;
		const $after = state.doc.resolve(pos + block.nodeSize);
		const next = $after.nodeAfter;
		const selection =
			next && (next.isAtom || next.type.spec.isolating)
				? new GapCursor($after)
				: (Selection.findFrom($after, 1, true) ??
					Selection.findFrom(state.doc.resolve(pos), -1, true));
		if (selection && !selection.eq(state.selection)) {
			editor.view.dispatch(state.tr.setSelection(selection));
		}
	};

	const onFocusChange = (focused: boolean) => {
		if (focused) {
			setAutoFocus(false);
			if (editor.isEditable) moveSelectionAfterBlock();
			document.addEventListener("pointerdown", flushOnOutsidePress, true);
			return;
		}
		document.removeEventListener("pointerdown", flushOnOutsidePress, true);
		// A blur can happen inside a ProseMirror command that moves focus; writing
		// then would dispatch in the middle of that command.
		queueMicrotask(flush);
	};

	const onEscape = () => {
		flush();
		const pos = getPos();
		if (typeof pos !== "number") return;
		editor.commands.setNodeSelection(pos);
		editor.view.focus();
		enterBlockSelection(editor);
	};

	const deleteBlock = () => {
		flush();
		const pos = getPos();
		if (typeof pos !== "number") return;
		editor.view.focus();
		editor.chain().setNodeSelection(pos).deleteSelection().run();
	};

	const onPanelBlur = (event: React.FocusEvent<HTMLElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget)) setAutoFocus(false);
	};

	return { autoFocus, cardRef, panelRef, onFocusChange, onEscape, deleteBlock, onPanelBlur };
}

/**
 * Whether something is being dragged. Frames swallow drag events, so previews
 * stop taking pointer events while a block is dragged over them.
 */
export function useDocumentDragging(): boolean {
	const [dragging, setDragging] = React.useState(false);
	React.useEffect(() => {
		const start = () => setDragging(true);
		const end = () => setDragging(false);
		document.addEventListener("dragstart", start);
		document.addEventListener("dragend", end);
		document.addEventListener("drop", end);
		return () => {
			document.removeEventListener("dragstart", start);
			document.removeEventListener("dragend", end);
			document.removeEventListener("drop", end);
		};
	}, []);
	return dragging;
}

export interface EmbedBlockTab {
	value: string;
	label: MessageDescriptor;
	Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
}

/** The block's card: its tabs, its menu and the panel for the active tab. */
export function EmbedBlockCard({
	className,
	editable,
	tabs,
	activeTab,
	onTabChange,
	menuLabel,
	menu,
	onDelete,
	focus,
	children,
}: {
	className: string;
	editable: boolean;
	tabs: readonly EmbedBlockTab[];
	activeTab: string;
	onTabChange: (value: string) => void;
	menuLabel: string;
	/** Items shown above Delete block. */
	menu?: React.ReactNode;
	onDelete: () => void;
	focus: Pick<ReturnType<typeof useEmbedBlockFocus>, "cardRef" | "panelRef" | "onPanelBlur">;
	children: React.ReactNode;
}) {
	const { t, i18n } = useLingui();
	const active = tabs.find((tab) => tab.value === activeTab);
	const tabsKey = useAttachedKey(focus.cardRef);
	return (
		<NodeViewWrapper className={cn(className, "not-prose my-4")} contentEditable={false}>
			{/* The editor's content takes its direction from the text; the card's
			    controls follow the interface, as their arrow keys already do. */}
			<div
				dir={getLocaleDir(i18n.locale)}
				ref={focus.cardRef}
				className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-base focus-within:border-kumo-brand"
			>
				<div className="flex items-center gap-2 p-1.5">
					<Tabs
						key={tabsKey}
						variant="segmented"
						size="sm"
						activateOnFocus
						value={activeTab}
						onValueChange={onTabChange}
						tabs={tabs.map(({ value, label, Icon }) => ({
							value,
							label: (
								<span className="flex items-center gap-1">
									<Icon className="size-3.5" aria-hidden="true" />
									<span className="max-sm:sr-only">{t(label)}</span>
								</span>
							),
						}))}
					/>
					{editable && (
						<DropdownMenu>
							<DropdownMenu.Trigger
								render={
									<Button
										type="button"
										variant="ghost"
										shape="square"
										size="sm"
										className="ms-auto"
										aria-label={menuLabel}
									>
										<DotsThreeVertical className="size-4" aria-hidden="true" />
									</Button>
								}
							/>
							<DropdownMenu.Content>
								{menu && (
									<>
										{menu}
										<DropdownMenu.Separator />
									</>
								)}
								<DropdownMenu.Item
									variant="danger"
									icon={<Trash className="size-4" aria-hidden="true" />}
									onClick={onDelete}
								>
									{t`Delete block`}
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu>
					)}
				</div>
				<div
					ref={focus.panelRef}
					role="tabpanel"
					aria-label={active ? t(active.label) : undefined}
					tabIndex={-1}
					className="border-t border-kumo-line outline-none"
					onBlur={focus.onPanelBlur}
				>
					{children}
				</div>
			</div>
		</NodeViewWrapper>
	);
}
