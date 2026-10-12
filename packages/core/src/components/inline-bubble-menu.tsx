/**
 * The inline editor's selection toolbar, laid out like the admin editor's:
 * Turn into, link, the common marks, and a menu for less common formatting.
 * With the caret in a link, a bar shows where it goes instead, and a
 * selected image gets a toolbar of its own.
 */

import {
	CaretDown,
	Check,
	Code,
	DotsThree,
	Eraser,
	Globe,
	Link as LinkIcon,
	LinkBreak,
	PencilSimple,
	TextAlignCenter,
	TextAlignLeft,
	TextAlignRight,
	TextB,
	TextItalic,
	TextStrikethrough,
	TextSubscript,
	TextSuperscript,
	TextUnderline,
} from "@phosphor-icons/react";
import { getMarkRange } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import { AllSelection, TextSelection, type EditorState } from "@tiptap/pm/state";
import { useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import * as React from "react";

import {
	activeBlockType,
	blockTypes,
	canTurnInto,
	turnInto,
	turnIntoMenuTypes,
} from "./inline-block-types.js";
import {
	InlineUiRootContext,
	TOOLBAR_POPUP_ATTR,
	ToolbarButton,
	ToolbarMenu,
	ToolbarSeparator,
	ToolbarShownContext,
	ToolbarTooltipGroup,
	attachBeforePositioning,
	handleToolbarKeyDown,
	playToolbarEntrance,
	useTabIntoToolbar,
	type ToolbarMenuGroup,
} from "./inline-editor-ui.js";
import { InlineImageToolbar } from "./inline-image.js";

type ShouldShow = NonNullable<BubbleMenuProps["shouldShow"]>;

const TEXT_TOOLBAR_KEY = "emdashInlineTextToolbar";
const LINK_TOOLBAR_KEY = "emdashInlineLinkToolbar";
const SCROLLING_OVERFLOW_REGEX = /auto|scroll|overlay/;

/**
 * The nearest element around the editor that scrolls, if any. The toolbars
 * sit outside it, so they follow its scrolling instead of the window's.
 */
function scrollParent(element: HTMLElement): HTMLElement | undefined {
	for (
		let node = element.parentElement;
		node && node !== document.body;
		node = node.parentElement
	) {
		const style = getComputedStyle(node);
		if (SCROLLING_OVERFLOW_REGEX.test(style.overflowY + style.overflowX)) return node;
	}
	return undefined;
}

/**
 * The editor's scroll parent, `undefined` for the window, or `null` until
 * the editor is on the page. A passive effect runs after EditorContent has
 * moved the editor into the page.
 */
function useScrollParent(editor: Editor): HTMLElement | undefined | null {
	const [element, setElement] = React.useState<HTMLElement | undefined | null>(null);
	React.useEffect(() => setElement(scrollParent(editor.view.dom)), [editor]);
	return element;
}

const INLINE_MARKS = [
	{ mark: "bold", label: "Bold", icon: TextB },
	{ mark: "italic", label: "Italic", icon: TextItalic },
	{ mark: "underline", label: "Underline", icon: TextUnderline },
	{ mark: "strike", label: "Strikethrough", icon: TextStrikethrough },
	{ mark: "code", label: "Inline Code", icon: Code },
] as const;

const FORMATTING_MARKS = [
	"bold",
	"italic",
	"underline",
	"strike",
	"code",
	"subscript",
	"superscript",
] as const;

const ALIGNMENTS = [
	{ value: "left", label: "Left", icon: TextAlignLeft },
	{ value: "center", label: "Center", icon: TextAlignCenter },
	{ value: "right", label: "Right", icon: TextAlignRight },
] as const;

const NON_WHITESPACE_REGEX = /\S/;
const SAFE_LINK_HREF_REGEX = /^(?:https?:|mailto:|tel:|\/|#)/i;
const LINK_DISPLAY_PREFIX_REGEX = /^https?:\/\/(?:www\.)?/i;
const SCHEME_OR_PATH_REGEX = /^([a-z][a-z0-9+.-]*:|[/#?])/i;
const DOMAIN_LIKE_REGEX = /^\S+\.\S{2,}$/;
const EMAIL_LIKE_REGEX = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]{2,}$/;
// A host needs a dot or to be localhost, so `tel:5551234` stays a phone link.
const HOST_WITH_PORT_REGEX = /^(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d+(?:[/?#]|$)/i;
// `./`, `../`, or a slash before the first dot, as in `docs/guide.pdf`.
const RELATIVE_PATH_REGEX = /^(?:\.{1,2}\/|[^./]+\/)/;

/**
 * Gives a bare domain or host `https://` and a bare email address `mailto:`,
 * so `example.com` doesn't become a link relative to the page it's on. The
 * admin editor's link field reads what's typed the same way.
 */
function normalizeLinkHref(value: string): string {
	const trimmed = value.trim();
	if (HOST_WITH_PORT_REGEX.test(trimmed)) return `https://${trimmed}`;
	if (SCHEME_OR_PATH_REGEX.test(trimmed) || RELATIVE_PATH_REGEX.test(trimmed)) return trimmed;
	if (EMAIL_LIKE_REGEX.test(trimmed)) return `mailto:${trimmed}`;
	return DOMAIN_LIKE_REGEX.test(trimmed) ? `https://${trimmed}` : trimmed;
}

/**
 * The link at the start of the selection, or holding the caret. A caret at a
 * link's edge counts too, and between two links the one after the caret wins.
 */
function linkAtCaret(state: EditorState): Mark | undefined {
	const linkType = state.schema.marks.link;
	if (!linkType) return undefined;
	const { $from, empty } = state.selection;
	const after = linkType.isInSet($from.nodeAfter?.marks ?? []);
	if (!empty) return after;
	return after ?? linkType.isInSet($from.nodeBefore?.marks ?? []);
}

/**
 * Links the selected text, or the whole link around the caret, to `value`.
 * At a caret outside a link, the text typed next gets the link. Returns
 * `false`, changing nothing, for a URL the editor won't link.
 */
function setSelectedTextLink(editor: Editor, value: string): boolean {
	const href = normalizeLinkHref(value);
	if (!editor.can().setLink({ href })) return false;
	const chain = editor
		.chain()
		.focus()
		.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
		.setLink({ href });
	if (editor.state.selection.empty && !editor.isActive("link")) return chain.run();
	return chain
		.command(({ tr, state }) => {
			const linkType = state.schema.marks.link;
			if (!linkType) return false;
			// The caret ends after the link, so the next words typed aren't part of it.
			tr.setSelection(TextSelection.near(tr.doc.resolve(tr.selection.to), -1));
			tr.removeStoredMark(linkType);
			return true;
		})
		.run();
}

function removeLinkAtCaret(editor: Editor) {
	editor
		.chain()
		.focus()
		.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
		.unsetLink()
		.run();
}

/**
 * The part of the link at the caret that's on the caret's line. The link
 * bar sits under it, so the bar stays put while the caret moves along the link.
 */
function linkLineRect(editor: Editor): DOMRect | null {
	// TipTap's scroll and resize updates can still run just after the editor is destroyed.
	if (editor.isDestroyed || !editor.view.dom.isConnected) return null;
	const { state, view } = editor;
	const link = linkAtCaret(state);
	const range = link && getMarkRange(state.selection.$from, link.type, link.attrs);
	if (!range) return null;
	const start = view.domAtPos(range.from);
	const end = view.domAtPos(range.to);
	const domRange = document.createRange();
	domRange.setStart(start.node, start.offset);
	domRange.setEnd(end.node, end.offset);
	const caret = view.coordsAtPos(state.selection.from);
	const middle = (caret.top + caret.bottom) / 2;
	const line = [...domRange.getClientRects()].filter(
		(rect) => rect.width > 0 && rect.top <= middle && rect.bottom >= middle,
	);
	if (line.length === 0) return null;
	const left = Math.min(...line.map((rect) => rect.left));
	const top = Math.min(...line.map((rect) => rect.top));
	const right = Math.max(...line.map((rect) => rect.right));
	const bottom = Math.max(...line.map((rect) => rect.bottom));
	return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * The selection's alignment when it has exactly one. Only top-level
 * paragraphs and headings keep an alignment, so anything in a quote or list
 * can't be aligned.
 */
function selectionAlignment(editor: Editor): { value?: string; unavailable: boolean } {
	const fallback = getComputedStyle(editor.view.dom).direction === "rtl" ? "right" : "left";
	const alignments = new Set<string>();
	let nested = false;
	const { from, to } = editor.state.selection;
	editor.state.doc.nodesBetween(from, to, (node, _pos, parent) => {
		if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
		if (parent?.type.name !== "doc") nested = true;
		const value: unknown = node.attrs.textAlign;
		alignments.add(
			value === "left" || value === "center" || value === "right" || value === "justify"
				? value
				: fallback,
		);
		return false;
	});
	const unavailable = nested || alignments.size === 0;
	return {
		value: !unavailable && alignments.size === 1 ? [...alignments][0] : undefined,
		unavailable,
	};
}

/** Shows where a link goes, with edit and remove, whenever the caret sits in it. */
function LinkToolbar({
	editor,
	appendTo,
	scrollTarget,
	onEdit,
}: {
	editor: Editor;
	appendTo: () => HTMLElement;
	scrollTarget: HTMLElement | undefined;
	onEdit: () => void;
}) {
	const href = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => {
			const value: unknown = linkAtCaret(activeEditor.state)?.attrs.href;
			return typeof value === "string" ? value : "";
		},
	});
	const [shown, setShown] = React.useState(false);
	const menuRef = React.useRef<HTMLDivElement>(null);
	const getReferencedVirtualElement = React.useCallback(() => {
		const rect = linkLineRect(editor);
		return rect && { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
	}, [editor]);
	// TipTap places the bar before its new address renders. Right to left, the
	// bar lines up by its far edge, so it's placed again at its rendered width.
	React.useLayoutEffect(() => {
		if (shown && !editor.isDestroyed) {
			editor.view.dispatch(editor.state.tr.setMeta(LINK_TOOLBAR_KEY, "updatePosition"));
		}
	}, [editor, href, shown]);
	const options = React.useMemo(
		() => ({
			strategy: "absolute" as const,
			placement: "bottom-start" as const,
			offset: 6,
			flip: { padding: 8 },
			shift: { padding: 8 },
			scrollTarget,
			onShow: () => {
				setShown(true);
				playToolbarEntrance(menuRef.current?.firstElementChild);
			},
			onHide: () => setShown(false),
		}),
		[scrollTarget],
	);
	const shouldShow = React.useCallback<ShouldShow>(
		({ editor: activeEditor, element, state, oldState, view }) => {
			const show =
				activeEditor.isEditable &&
				state.selection instanceof TextSelection &&
				state.selection.empty &&
				linkAtCaret(state) !== undefined &&
				// At a link's edge, typing goes beside the link, so the bar gets out of the way.
				(activeEditor.isActive("link") || !oldState || oldState.doc.eq(state.doc)) &&
				(view.hasFocus() || element.contains(element.ownerDocument.activeElement));
			if (show) attachBeforePositioning(element, appendTo());
			return show;
		},
		[appendTo],
	);
	return (
		<BubbleMenu
			ref={menuRef}
			editor={editor}
			pluginKey={LINK_TOOLBAR_KEY}
			appendTo={appendTo}
			getReferencedVirtualElement={getReferencedVirtualElement}
			updateDelay={0}
			options={options}
			shouldShow={shouldShow}
			role="toolbar"
			aria-label="Link options"
			className="emdash-inline-ui-bar emdash-inline-ui-link-preview emdash-link-bubble-menu"
			onKeyDown={(event) => handleToolbarKeyDown(event, editor)}
		>
			<ToolbarShownContext.Provider value={shown}>
				<ToolbarTooltipGroup>
					<Globe className="emdash-inline-ui-link-globe" aria-hidden="true" />
					{SAFE_LINK_HREF_REGEX.test(href) ? (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							dir="auto"
							className="emdash-inline-ui-link-url"
						>
							{href.replace(LINK_DISPLAY_PREFIX_REGEX, "")}
						</a>
					) : (
						<span dir="auto" className="emdash-inline-ui-link-url">
							{href}
						</span>
					)}
					<ToolbarSeparator />
					<ToolbarButton label="Edit link" onClick={onEdit}>
						<PencilSimple />
					</ToolbarButton>
					<ToolbarButton label="Remove link" onClick={() => removeLinkAtCaret(editor)}>
						<LinkBreak />
					</ToolbarButton>
				</ToolbarTooltipGroup>
			</ToolbarShownContext.Provider>
		</BubbleMenu>
	);
}

function LinkField({
	editor,
	linked,
	onDone,
}: {
	editor: Editor;
	linked: boolean;
	onDone: () => void;
}) {
	const [value, setValue] = React.useState(() => {
		const href: unknown = editor.getAttributes("link").href;
		return typeof href === "string" ? href : "";
	});
	const [invalid, setInvalid] = React.useState(false);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const errorId = React.useId();

	React.useEffect(() => {
		inputRef.current?.focus();
	}, []);
	// The message makes the toolbar taller, so it moves to keep the selection in view.
	React.useEffect(() => {
		if (!editor.isDestroyed) {
			editor.view.dispatch(editor.state.tr.setMeta(TEXT_TOOLBAR_KEY, "updatePosition"));
		}
	}, [editor, invalid]);

	const remove = () => {
		removeLinkAtCaret(editor);
		onDone();
	};
	const apply = () => {
		if (value.trim() === "") {
			remove();
		} else if (setSelectedTextLink(editor, value)) {
			onDone();
		} else {
			setInvalid(true);
		}
	};

	return (
		<div className="emdash-inline-ui-link-edit">
			<div className="emdash-inline-ui-field">
				<input
					ref={inputRef}
					type="text"
					inputMode="url"
					autoComplete="off"
					spellCheck={false}
					className="emdash-inline-ui-input"
					value={value}
					placeholder="Type or paste a URL"
					aria-label="Link URL"
					aria-invalid={invalid || undefined}
					aria-describedby={invalid ? errorId : undefined}
					onChange={(event) => {
						setValue(event.target.value);
						setInvalid(false);
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (event.key === "Enter") {
							event.preventDefault();
							apply();
						} else if (event.key === "Escape") {
							event.preventDefault();
							onDone();
							editor.commands.focus();
						}
					}}
				/>
				{invalid && (
					<p id={errorId} role="alert" className="emdash-inline-ui-field-error">
						This link can't be used. Enter a web address, such as https://example.com.
					</p>
				)}
			</div>
			<ToolbarButton label="Apply link" onClick={apply}>
				<Check />
			</ToolbarButton>
			{linked && (
				<ToolbarButton label="Remove link" onClick={remove}>
					<LinkBreak />
				</ToolbarButton>
			)}
		</div>
	);
}

const NO_ALIGNMENT: ReturnType<typeof selectionAlignment> = { unavailable: true };

export function InlineBubbleMenu({
	editor,
	uiRoot,
	onImageReplaced,
}: {
	editor: Editor;
	uiRoot: HTMLElement;
	onImageReplaced: () => void;
}) {
	const [editingLink, setEditingLink] = React.useState(false);
	const [openMenu, setOpenMenu] = React.useState<"turnInto" | "more" | null>(null);
	// Opening one menu closes the other, whose close then mustn't undo the open.
	const toggleMenu = (menu: "turnInto" | "more", open: boolean) =>
		setOpenMenu((current) => (open ? menu : current === menu ? null : current));
	const [shown, setShown] = React.useState(false);
	const menuRef = React.useRef<HTMLDivElement>(null);
	const editingLinkRef = React.useRef(editingLink);
	editingLinkRef.current = editingLink;
	useTabIntoToolbar(editor, uiRoot);
	const scrollTarget = useScrollParent(editor);

	const state = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => ({
			bold: activeEditor.isActive("bold"),
			italic: activeEditor.isActive("italic"),
			underline: activeEditor.isActive("underline"),
			strike: activeEditor.isActive("strike"),
			code: activeEditor.isActive("code"),
			subscript: activeEditor.isActive("subscript"),
			superscript: activeEditor.isActive("superscript"),
			link: activeEditor.isActive("link"),
			canTurnInto: canTurnInto(activeEditor),
			blockType: activeBlockType(activeEditor),
		}),
	});

	const appendTo = React.useCallback(() => uiRoot, [uiRoot]);
	const options = React.useMemo(
		() => ({
			strategy: "absolute" as const,
			placement: "top-start" as const,
			offset: 8,
			flip: { padding: 8 },
			shift: { padding: 8 },
			size: {
				padding: 8,
				apply: ({
					availableWidth,
					elements,
				}: {
					availableWidth: number;
					elements: { floating: HTMLElement };
				}) => {
					elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
				},
			},
			scrollTarget: scrollTarget ?? undefined,
			onShow: () => {
				const surface = menuRef.current?.firstElementChild;
				setShown(true);
				playToolbarEntrance(surface);
				// Edit link opens the field while this toolbar is still hidden, too early to focus it.
				if (editingLinkRef.current) surface?.querySelector("input")?.focus();
			},
			// A link edit or menu left open doesn't carry over to the next selection.
			onHide: () => {
				setShown(false);
				setEditingLink(false);
				setOpenMenu(null);
			},
		}),
		[scrollTarget],
	);
	const shouldShow = React.useCallback<ShouldShow>(
		({ editor: activeEditor, element, state: editorState, view }) => {
			const { selection } = editorState;
			// TipTap's timers can run this after the editor is gone, when the global document may be too.
			const activeElement = element.ownerDocument.activeElement;
			const hasMenuFocus =
				element.contains(activeElement) ||
				Boolean(activeElement?.closest(`[${TOOLBAR_POPUP_ATTR}]`));
			const show =
				activeEditor.isEditable &&
				(selection instanceof TextSelection || selection instanceof AllSelection) &&
				// A selection of only line breaks or spaces has nothing to format.
				NON_WHITESPACE_REGEX.test(editorState.doc.textBetween(selection.from, selection.to, " ")) &&
				!activeEditor.isActive("codeBlock") &&
				(view.hasFocus() || hasMenuFocus);
			if (show) attachBeforePositioning(element, uiRoot);
			return show;
		},
		[uiRoot],
	);

	const activeType = blockTypes.find((type) => type.id === state.blockType);
	const turnIntoGroups: ToolbarMenuGroup[] = [
		{
			label: "Turn into",
			items: turnIntoMenuTypes(state.blockType).map((type) => ({
				label: type.label,
				icon: type.icon,
				role: "menuitemradio",
				checked: type.id === state.blockType,
				onSelect: () => turnInto(editor, type.id),
			})),
		},
	];
	const alignment = openMenu === "more" ? selectionAlignment(editor) : NO_ALIGNMENT;
	const moreGroups: ToolbarMenuGroup[] = [
		{
			items: [
				{
					label: "Subscript",
					icon: TextSubscript,
					role: "menuitemcheckbox",
					checked: state.subscript,
					onSelect: () => editor.chain().focus().toggleSubscript().run(),
				},
				{
					label: "Superscript",
					icon: TextSuperscript,
					role: "menuitemcheckbox",
					checked: state.superscript,
					onSelect: () => editor.chain().focus().toggleSuperscript().run(),
				},
			],
		},
		{
			label: "Align",
			items: ALIGNMENTS.map(({ value, label, icon }) => ({
				label,
				icon,
				role: "menuitemradio",
				checked: alignment.value === value,
				disabled: alignment.unavailable,
				onSelect: () => editor.chain().focus().setTextAlign(value).run(),
			})),
		},
		{
			items: [
				{
					label: "Clear formatting",
					icon: Eraser,
					onSelect: () => {
						const chain = editor.chain().focus();
						for (const mark of FORMATTING_MARKS) chain.unsetMark(mark);
						chain.run();
					},
				},
			],
		},
	];

	// The toolbars take their scroll target when they're created, and can't show before then anyway.
	if (scrollTarget === null) return null;

	return (
		<InlineUiRootContext.Provider value={uiRoot}>
			<LinkToolbar
				editor={editor}
				appendTo={appendTo}
				scrollTarget={scrollTarget}
				onEdit={() => {
					editor.chain().focus().extendMarkRange("link", linkAtCaret(editor.state)?.attrs).run();
					setEditingLink(true);
				}}
			/>
			<BubbleMenu
				ref={menuRef}
				editor={editor}
				pluginKey={TEXT_TOOLBAR_KEY}
				appendTo={appendTo}
				updateDelay={120}
				options={options}
				shouldShow={shouldShow}
				role="toolbar"
				aria-label="Format selection"
				className="emdash-inline-ui-bar emdash-bubble-menu"
				onKeyDown={(event) => handleToolbarKeyDown(event, editor)}
			>
				<ToolbarShownContext.Provider value={shown}>
					<ToolbarTooltipGroup>
						{editingLink ? (
							<LinkField editor={editor} linked={state.link} onDone={() => setEditingLink(false)} />
						) : (
							// Scrolls sideways, fading at the cut-off edge, when a narrow screen can't fit it.
							<div className="emdash-inline-ui-toolbar">
								{state.canTurnInto && (
									<>
										<ToolbarMenu
											editor={editor}
											label="Turn into"
											placement="bottom-start"
											open={openMenu === "turnInto"}
											onOpenChange={(open) => toggleMenu("turnInto", open)}
											trigger={
												<>
													<span className="emdash-inline-ui-trigger-label">
														{activeType?.label ?? "Turn into"}
													</span>
													<CaretDown className="emdash-inline-ui-caret" aria-hidden="true" />
												</>
											}
											groups={turnIntoGroups}
										/>
										<ToolbarSeparator />
									</>
								)}
								<ToolbarButton
									label={state.link ? "Edit link" : "Add link"}
									active={state.link}
									onClick={() => setEditingLink(true)}
								>
									<LinkIcon />
								</ToolbarButton>
								<ToolbarSeparator />
								{INLINE_MARKS.map(({ mark, label, icon: MarkIcon }) => (
									<ToolbarButton
										key={mark}
										label={label}
										active={state[mark]}
										onClick={() => editor.chain().focus().toggleMark(mark).run()}
									>
										<MarkIcon />
									</ToolbarButton>
								))}
								<ToolbarSeparator />
								<ToolbarMenu
									editor={editor}
									label="More formatting"
									placement="bottom-end"
									iconOnly
									open={openMenu === "more"}
									onOpenChange={(open) => toggleMenu("more", open)}
									trigger={<DotsThree weight="bold" aria-hidden="true" />}
									groups={moreGroups}
								/>
							</div>
						)}
					</ToolbarTooltipGroup>
				</ToolbarShownContext.Provider>
			</BubbleMenu>
			<InlineImageToolbar
				editor={editor}
				uiRoot={uiRoot}
				scrollTarget={scrollTarget}
				onReplaced={onImageReplaced}
			/>
		</InlineUiRootContext.Provider>
	);
}
