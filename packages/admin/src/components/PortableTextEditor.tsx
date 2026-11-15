/**
 * Portable Text Editor
 *
 * TipTap-based rich text editor that stores content as Portable Text.
 * Handles conversion between ProseMirror JSON and Portable Text automatically.
 *
 * Features:
 * - BubbleMenu for inline formatting
 * - Link popover for editing URLs (no window.prompt)
 * - Slash commands for block insertion
 * - Floating menu on empty lines
 */

import {
	Button,
	Input,
	LayerDialog,
	Popover,
	Select,
	Switch,
	Text,
	Tooltip,
	TooltipProvider,
} from "@cloudflare/kumo";
import { Menu } from "@cloudflare/kumo/primitives/menu";
import { Popover as PopoverPrimitive } from "@cloudflare/kumo/primitives/popover";
import {
	DndContext,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
	SortableContext,
	arrayMove,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Element } from "@emdash-cms/blocks";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui as useLinguiContext } from "@lingui/react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
	TextB,
	TextItalic,
	TextUnderline,
	TextStrikethrough,
	TextSubscript,
	TextSuperscript,
	Code,
	TextHOne,
	TextHTwo,
	TextHThree,
	TextHFour,
	TextHFive,
	TextHSix,
	List,
	ListNumbers,
	Quotes,
	Link as LinkIcon,
	Image as ImageIcon,
	Images,
	ArrowUUpLeft,
	ArrowUUpRight,
	TextAlignLeft,
	TextAlignCenter,
	TextAlignRight,
	AlignLeft,
	AlignCenterHorizontal,
	AlignRight,
	Check,
	ImageSquare,
	Rows,
	SlidersHorizontal,
	Subtitles,
	TextAa,
	Minus,
	LinkBreak,
	BracketsAngle,
	FrameCorners,
	CodeBlock,
	Stack,
	Table as TableIcon,
	VideoCamera,
	Plus,
	Trash,
	RowsPlusBottom,
	ColumnsPlusRight,
	DotsSixVertical,
	CaretDown,
	DotsThree,
	Eraser,
	Globe,
	PencilSimple,
	TextT,
	type Icon,
} from "@phosphor-icons/react";
import { X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Extension,
	InputRule,
	type EditorEvents,
	type MappablePosition,
	type Range,
} from "@tiptap/core";
import CharacterCount from "@tiptap/extension-character-count";
import Focus from "@tiptap/extension-focus";
import { isAllowedUri } from "@tiptap/extension-link";
import Typography from "@tiptap/extension-typography";
import type { Mark as ProseMirrorMark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	AllSelection,
	NodeSelection,
	Plugin,
	PluginKey,
	Selection,
	TextSelection,
	type EditorState,
	type Transaction,
} from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { useEditor, EditorContent, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import Suggestion, { exitSuggestion, SuggestionPluginKey } from "@tiptap/suggestion";
import * as React from "react";

import type { MediaItem } from "../lib/api";
import type { Section } from "../lib/api";
import { fetchMediaItem, uploadMedia } from "../lib/api/media.js";
import type { RichTextBinding } from "../lib/co-editing/types.js";
import { guardUnsavedInput, revealErrors } from "../lib/dialog-form.js";
import {
	canonicalMediaProviderId,
	dropsDisplayHeight,
	localMediaFileUrl,
} from "../lib/media-utils.js";
import {
	UnsupportedPortableTextMarksError,
	findUnsupportedPortableTextMarks,
} from "../lib/portable-text-marks.js";
import { cn } from "../lib/utils";
import { UnsafePortableTextTableError } from "../portable-text-table.js";
import {
	equalJsonValues,
	portableTextToProsemirror,
	prosemirrorToPortableText,
	withoutTrailingEmptyParagraph,
	withoutTrailingParagraph,
	type PortableTextBlock,
} from "../portable-text/convert.js";
import { generateKey } from "../portable-text/keys.js";
import { isRemote } from "../portable-text/normalize.js";
import {
	CodeMarkExtension,
	EmDashOrderedList,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
	PortableTextFilledDefaults,
	PortableTextIdentityExtension,
	PortableTextKeys,
	PortableTextNormalizers,
	PortableTextSpanIdentity,
	PortableTextStarterKit,
	PortableTextTable,
	PortableTextTextAlign,
	SubscriptMark,
	SuperscriptMark,
	TableIdentity,
	TopBlockDocument,
} from "../portable-text/schema.js";
import { PortableTextYSync } from "../portable-text/y-sync.js";
import { CaretNext } from "./ArrowIcons.js";
import { BlockKitMediaPickerField } from "./BlockKitMediaPickerField";
import { DialogError } from "./DialogError.js";
import {
	BlockSelectAll,
	BlockSelection,
	DoubleClickLineEnd,
	SelectionHighlights,
	blockInsertPosition,
} from "./editor/BlockCommands.js";
import {
	activeTextBlockType,
	canTurnInto,
	prepareBlockInsert,
	textBlockTypes,
	toggleTextBlockType,
	turnInto,
	turnIntoMenuTypes,
	type TextBlockTypeId,
} from "./editor/blockTypes.js";
import { CodeBlockExtension } from "./editor/CodeBlockNode";
import { DragHandleWrapper } from "./editor/DragHandleWrapper";
import {
	EditorMenuCheckboxItem,
	EditorMenuItem,
	EditorMenuLabel,
	EditorMenuRadioItem,
	EditorMenuSeparator,
	editorMenuPopupClassName,
	editorSurfaceClassName,
	tabToEditor,
} from "./editor/EditorMenu.js";
import { mediaItemToGalleryImage } from "./editor/GalleryDetailPanel";
import { GalleryExtension } from "./editor/GalleryNode";
import { HeadingDropdownMenu } from "./editor/HeadingDropdownMenu";
import {
	closeHistoryGroup,
	endHistoryGroup,
	historyDepth,
	undoLastGroup,
} from "./editor/history.js";
import { HtmlBlockExtension } from "./editor/HtmlBlockNode";
import { IframeBlockExtension } from "./editor/IframeBlockNode";
import { ImageExtension, type ImageSettingsHandle } from "./editor/ImageNode";
import { ImageUploadExtension } from "./editor/ImageUploadExtension.js";
import { liftPastedBlocks } from "./editor/liftPastedBlocks";
import { LinkDestinationInput, normalizeLinkHref } from "./editor/LinkDestinationInput";
import { MarkdownLinkExtension } from "./editor/MarkdownLinkExtension";
import {
	type PluginBlockDef,
	PluginBlockExtension,
	registerPluginBlocks,
	resolveIcon,
} from "./editor/PluginBlockNode";
import { PORTABLE_TEXT_KEY_ATTR } from "./editor/portableTextIdentity.js";
import { runTableAction } from "./editor/TableActions.js";
import { createTableCellSafety, type TablePasteRejection } from "./editor/TableCellSafety.js";
import { createTableClipboard } from "./editor/TableClipboard.js";
import {
	TableMoreMenu,
	TableSelectionAnnouncer,
	TableSizePicker,
	TableToolbarControl,
	insertTable as insertEditorTable,
	useTableControls,
} from "./editor/TableControls.js";
import {
	selectionIsContainedInTableCells,
	selectionTouchesTable,
} from "./editor/TableExtensions.js";
import { createTableResize } from "./editor/TableResize.js";
import { createTextBlockPlaceholder } from "./editor/TextBlockPlaceholder.js";
import { VideoExtension, mediaItemToVideoAttrs } from "./editor/VideoNode";
import { MediaPickerModal } from "./MediaPickerModal";
import { NonListFieldValue, isNonListValue } from "./NonListFieldValue.js";
import { SectionPickerModal } from "./SectionPickerModal";

const bubbleMenuClassName = cn("z-[100] flex items-center gap-0.5 p-1", editorSurfaceClassName);

const INLINE_BUBBLE_MENU_KEY = "emdashInlineBubbleMenu";
const TABLE_BUBBLE_MENU_KEY = "emdashTableBubbleMenu";
const IMAGE_BUBBLE_MENU_KEY = "emdashImageBubbleMenu";
const LINK_BUBBLE_MENU_KEY = "emdashLinkBubbleMenu";

type BubbleMenuCollisionOptions = () => {
	rootBoundary: { x: number; y: number; width: number; height: number };
	padding: number;
};

/**
 * Point the selected image at `href`, or clear its link when `href` is empty.
 * Keeps an existing "open in new tab" choice when only the destination changes.
 * Shared by the toolbar and the bubble menu, which both edit image links.
 */
function setSelectedImageLink(editor: Editor, href: string | null): boolean {
	const trimmed = href ? normalizeLinkHref(href) : "";
	if (trimmed && !isAllowedUri(trimmed)) return false;
	const existing = editor.getAttributes("image").link as { blank?: boolean } | null;
	const link = trimmed ? { href: trimmed, ...(existing?.blank ? { blank: true } : {}) } : null;
	return editor.chain().focus().updateAttributes("image", { link }).run();
}

/**
 * The link at the start of the selection, or holding the caret. A caret at a
 * link's edge, where a click on its first or last letter can leave it, counts
 * too, and between two links the one after the caret wins.
 */
function linkAtCaret(state: EditorState): ProseMirrorMark | undefined {
	const { selection, schema } = state;
	const linkType = schema.marks.link;
	if (!linkType) return undefined;
	const { $from } = selection;
	const after = linkType.isInSet($from.nodeAfter?.marks ?? []);
	if (!selection.empty) return after;
	return after ?? linkType.isInSet($from.nodeBefore?.marks ?? []);
}

/**
 * Links the selected text, or the whole link around the caret, to `value`.
 * At a caret outside a link, the text typed next gets the link up to the first
 * space. Returns `false`, changing nothing, for a URL the editor won't link.
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

/**
 * Anything typed, pasted, or dropped into a quote or list item that Portable
 * Text can't store there lands beside it instead of being lost on save, and
 * `---` typed in one adds the divider the way the slash menu does.
 */
const EditorStarterKit = PortableTextStarterKit.extend({
	addProseMirrorPlugins() {
		return [
			...(this.parent?.() ?? []),
			new Plugin({ props: { transformPastedHTML: liftPastedBlocks } }),
		];
	},
	addExtensions() {
		return (this.parent?.() ?? []).map((extension) => {
			if (extension.name !== "horizontalRule") return extension;
			return extension.extend({
				addInputRules() {
					return (this.parent?.() ?? []).map(
						(rule) =>
							new InputRule({
								find: rule.find,
								handler: (props) => {
									// Table cells can't hold a divider, so the dashes stay text there.
									if (selectionTouchesTable(props.state)) return null;
									if (blockInsertPosition(props.state.selection) === null) {
										return rule.handler(props);
									}
									props
										.chain()
										.deleteRange(props.range)
										.command(({ tr }) => insertDivider(tr))
										.run();
								},
							}),
					);
				},
			});
		});
	},
});

const LinkBoundaryExit = Extension.create({
	name: "linkBoundaryExit",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				appendTransaction(transactions, _oldState, newState) {
					if (
						!transactions.some((transaction) => transaction.selectionSet && !transaction.docChanged)
					) {
						return null;
					}
					const { selection } = newState;
					if (!(selection instanceof TextSelection) || !selection.empty) return null;
					const linkType = newState.schema.marks.link;
					if (!linkType) return null;
					const { nodeBefore, nodeAfter } = selection.$from;
					const linkBefore = linkType.isInSet(nodeBefore?.marks ?? []);
					const linkAfter = linkType.isInSet(nodeAfter?.marks ?? []);
					const leavingLink = linkBefore && !(linkAfter && linkBefore.eq(linkAfter));
					// At the start of a block that opens with a link, typing goes before it.
					const beforeFirstLink = !nodeBefore && linkAfter;
					if (!leavingLink && !beforeFirstLink) return null;
					return newState.tr.removeStoredMark(linkType);
				},
			}),
		];
	},
});

// =============================================================================
// Slash Commands
// =============================================================================

/**
 * Slash command item definition
 */
interface SlashCommandItem {
	id: string;
	/** Built-in commands use `msg`; plugin/API-sourced titles stay plain `string`. */
	title: MessageDescriptor | string;
	description: MessageDescriptor | string;
	icon: Icon | React.ComponentType<{ className?: string }>;
	command: (props: { editor: Editor; range: Range }) => void;
	/** Delay document insertion until a modal-backed command returns a selection. */
	deferInsertion?: boolean;
	opensTablePicker?: boolean;
	aliases?: string[];
	/** Markdown that creates the same block, shown as a hint beside the title. */
	markdown?: string;
	/** Only listed when the query matches, to keep the unfiltered menu short. */
	searchOnly?: boolean;
	/**
	 * Display category. Built-in commands use `msg`-tagged descriptors;
	 * plugin-supplied categories arrive as plain strings via the manifest
	 * and are passed through verbatim when rendered.
	 */
	category?: MessageDescriptor | string;
}

/**
 * Puts a divider where an inserted block can be saved, with the caret in the
 * text after it. TipTap's own command can leave the caret between blocks
 * when the divider ends the document.
 */
function insertDivider(tr: Transaction): boolean {
	prepareBlockInsert(tr);
	const { $from } = tr.selection;
	if ($from.depth !== 1 || $from.parent.content.size > 0) return false;
	const { schema } = tr.doc.type;
	const start = $from.before();
	tr.replaceWith(start, $from.after(), schema.nodes.horizontalRule!.create());
	const after = start + 1;
	if (!tr.doc.resolve(after).nodeAfter?.isTextblock) {
		tr.insert(after, schema.nodes.paragraph!.create());
	}
	tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
	return true;
}

/**
 * Insert a top-level block: at `position` when given, in place of an empty
 * top-level paragraph or an empty line in a list or quote, before the
 * top-level block whose start holds the cursor, and otherwise after it. The
 * new block is node-selected; its node view takes focus itself.
 */
function insertTopLevelBlock(
	editor: Editor,
	block: ProseMirrorNode,
	range?: Range,
	position?: number,
) {
	const tr = closeHistoryGroup(editor.state, editor.state.tr);
	if (range) tr.delete(range.from, range.to);
	if (position === undefined && tr.selection.empty && !tr.selection.$from.parent.content.size) {
		prepareBlockInsert(tr);
	}
	const { selection } = tr;
	const { $from } = selection;
	const atBlockStart =
		$from.parentOffset === 0 &&
		Array.from({ length: $from.depth - 1 }, (_, depth) => $from.index(depth + 1)).every(
			(index) => index === 0,
		);
	let at: number;
	if (position !== undefined) {
		at = position;
		tr.insert(at, block);
	} else if (
		$from.depth === 1 &&
		$from.parent.type.name === "paragraph" &&
		!$from.parent.childCount
	) {
		at = $from.before(1);
		tr.replaceWith(at, $from.after(1), block);
	} else {
		at = $from.depth === 0 ? selection.to : atBlockStart ? $from.before(1) : $from.after(1);
		tr.insert(at, block);
	}
	tr.setSelection(NodeSelection.create(tr.doc, at));
	editor.view.dispatch(tr.scrollIntoView());
}

function insertIframeBlock(editor: Editor, range?: Range, position?: number) {
	insertTopLevelBlock(editor, editor.schema.nodes.iframeBlock!.create(), range, position);
}

function insertHtmlBlock(editor: Editor, range?: Range, position?: number) {
	insertTopLevelBlock(
		editor,
		editor.schema.nodes.htmlBlock!.create({ isolated: true }),
		range,
		position,
	);
}

const BASIC_BLOCKS_CATEGORY = msg`Basic blocks`;
const MEDIA_CATEGORY = msg`Media`;
const ADVANCED_CATEGORY = msg`Advanced`;
const EMBEDS_CATEGORY = msg`Embeds`;

function headingCommand(
	level: 1 | 2 | 3 | 4 | 5 | 6,
	title: MessageDescriptor,
	description: MessageDescriptor,
	icon: Icon,
	aliases: string[],
): SlashCommandItem {
	return {
		id: `heading${level}`,
		title,
		description,
		icon,
		aliases,
		markdown: "#".repeat(level),
		searchOnly: level > 3,
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => turnInto(editor, `heading${level}`, range),
	};
}

/**
 * Default slash commands for built-in block types
 */
const defaultSlashCommands: SlashCommandItem[] = [
	{
		id: "paragraph",
		title: msg`Paragraph`,
		description: msg`Start writing with plain text`,
		icon: TextT,
		aliases: ["text", "plain", "p"],
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => turnInto(editor, "paragraph", range),
	},
	headingCommand(1, msg`Heading 1`, msg`Large section heading`, TextHOne, ["h1", "title"]),
	headingCommand(2, msg`Heading 2`, msg`Medium section heading`, TextHTwo, ["h2", "subtitle"]),
	headingCommand(3, msg`Heading 3`, msg`Small section heading`, TextHThree, ["h3"]),
	{
		id: "bulletList",
		title: msg`Bullet List`,
		description: msg`Create a bullet list`,
		icon: List,
		aliases: ["ul", "unordered", "bulleted"],
		markdown: "-",
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => turnInto(editor, "bulletList", range),
	},
	{
		id: "numberedList",
		title: msg`Numbered List`,
		description: msg`Create a numbered list`,
		icon: ListNumbers,
		aliases: ["ol", "ordered"],
		markdown: "1.",
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => turnInto(editor, "orderedList", range),
	},
	{
		id: "quote",
		title: msg`Quote`,
		description: msg`Insert a blockquote`,
		icon: Quotes,
		aliases: ["blockquote", "cite"],
		markdown: ">",
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => turnInto(editor, "blockquote", range),
	},
	{
		id: "codeBlock",
		title: msg`Code Block`,
		description: msg`Insert a code block`,
		icon: CodeBlock,
		aliases: ["pre", "snippet", "```"],
		markdown: "```",
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => turnInto(editor, "codeBlock", range),
	},
	{
		id: "divider",
		title: msg`Divider`,
		description: msg`Insert a horizontal rule`,
		icon: Minus,
		// Typography turns a typed "--" into an em dash, so "/---" arrives as "/—-".
		aliases: ["hr", "---", "—-", "separator", "line"],
		markdown: "---",
		category: BASIC_BLOCKS_CATEGORY,
		command: ({ editor, range }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.command(({ tr }) => insertDivider(tr))
				.run();
		},
	},
	{
		id: "table",
		title: msg`Table`,
		description: msg`Insert a table`,
		icon: TableIcon,
		aliases: ["grid", "spreadsheet"],
		category: BASIC_BLOCKS_CATEGORY,
		opensTablePicker: true,
		command: () => undefined,
	},
	headingCommand(4, msg`Heading 4`, msg`Smaller section heading`, TextHFour, ["h4"]),
	headingCommand(5, msg`Heading 5`, msg`Minor section heading`, TextHFive, ["h5"]),
	headingCommand(6, msg`Heading 6`, msg`Smallest section heading`, TextHSix, ["h6"]),
];

const htmlSlashCommand: SlashCommandItem = {
	id: "htmlBlock",
	title: msg`HTML`,
	description: msg`Insert raw HTML`,
	icon: BracketsAngle,
	aliases: ["html", "raw", "markup"],
	category: ADVANCED_CATEGORY,
	command: ({ editor, range }) => insertHtmlBlock(editor, range),
};

const iframeSlashCommand: SlashCommandItem = {
	id: "iframe",
	title: msg`Iframe`,
	description: msg`Embed a page from another site`,
	icon: FrameCorners,
	aliases: ["embed", "youtube", "vimeo", "map"],
	category: EMBEDS_CATEGORY,
	command: ({ editor, range }) => insertIframeBlock(editor, range),
};

/**
 * Ranks a command against the slash query: exact aliases (`/h1`) first, then
 * title prefixes, initials (`/bl` → "Bullet List"), word prefixes,
 * substrings, descriptions, and finally loose in-order character matches.
 * The loose matches need three characters, so `/di` doesn't list every
 * "heading". Zero means no match.
 */
function scoreSlashCommand(
	query: string,
	title: string,
	description: string,
	aliases: string[] = [],
): number {
	const q = query.toLowerCase().trim();
	if (!q) return 1;
	const lowerTitle = title.toLowerCase();
	const lowerAliases = aliases.map((alias) => alias.toLowerCase());
	if (lowerAliases.includes(q)) return 100;
	if (lowerTitle === q) return 95;
	if (lowerTitle.startsWith(q)) return 90;
	const words = lowerTitle.split(WHITESPACE_REGEX);
	if (
		q.length > 1 &&
		words
			.map((word) => word[0])
			.join("")
			.startsWith(q)
	)
		return 85;
	if (words.some((word) => word.startsWith(q))) return 80;
	if (lowerAliases.some((alias) => alias.startsWith(q))) return 70;
	if (q.length < 3) return 0;
	if (lowerTitle.includes(q)) return 60;
	if (description.toLowerCase().includes(q)) return 40;
	let index = 0;
	for (const char of lowerTitle) {
		if (char === q[index]) index++;
		if (index === q.length) return 20;
	}
	return 0;
}

/**
 * Slash menu state
 */
interface SlashMenuState {
	isOpen: boolean;
	mode: "commands" | "table-size";
	items: SlashCommandItem[];
	selectedIndex: number;
	clientRect: (() => DOMRect | null) | null;
	range: Range | null;
	dismissedSlashFrom: number | null;
	query: string;
}

/** The slash the block insert button typed, while its menu is open. */
interface InsertedSlashLine {
	/** Where the slash is, once the button has typed it. */
	slash: MappablePosition | null;
	/** The button added the paragraph, rather than typing into an empty one. */
	addedParagraph: boolean;
	/** The undo history's depth just after the button typed the line. */
	undoDepth: number;
}

/** Where `position` is after a dispatch: its transaction and the ones plugins appended. */
function positionAfter(
	editor: Editor,
	position: MappablePosition,
	{ transaction, appendedTransactions }: EditorEvents["transaction"],
): MappablePosition {
	return [transaction, ...appendedTransactions].reduce(
		(current, tr) => editor.utils.getUpdatedPosition(current, tr).position,
		position,
	);
}

/** The nearest element around `element` that scrolls vertically. */
function scrollContainer(element: HTMLElement): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (SCROLLING_OVERFLOW_REGEX.test(getComputedStyle(node).overflowY)) return node;
	}
	return null;
}

function isEmptyParagraph(node: ProseMirrorNode | null | undefined): boolean {
	return node?.type.name === "paragraph" && node.content.size === 0;
}

/** The paragraph the insert button added for this slash, if it holds nothing else. */
function addedSlashParagraph(
	doc: ProseMirrorNode,
	range: Range,
	line: InsertedSlashLine | null,
): Range | null {
	if (!line?.addedParagraph || line.slash?.position !== range.from) return null;
	const $slash = doc.resolve(range.from);
	if ($slash.parent.content.size !== range.to - range.from) return null;
	return { from: $slash.before(), to: $slash.after() };
}

/** The slash the menu was dismissed on, as other clients' edits move it. */
interface DismissedSlash {
	from: number;
	position: MappablePosition;
}

const dismissedSlashKey = new PluginKey<DismissedSlash | null>("dismissedSlash");

/**
 * Create the slash commands TipTap extension
 */
function createSlashCommandsExtension(options: {
	filterCommands: (query: string) => SlashCommandItem[];
	onStateChange: React.Dispatch<React.SetStateAction<SlashMenuState>>;
	getState: () => SlashMenuState;
	onCommand: (item: SlashCommandItem) => void;
	/** Escape or Tab closed the menu without running a command. */
	onDismiss: () => void;
	/** The menu closed; changes the block insert button's line held back can be reported. */
	onExit: (editor: Editor) => void;
}) {
	const { filterCommands, onStateChange, getState, onCommand, onDismiss, onExit } = options;

	const dismissedSlashFrom = (state: EditorState) =>
		dismissedSlashKey.getState(state)?.from ?? getState().dismissedSlashFrom;

	return Extension.create({
		name: "slashCommands",
		onTransaction() {
			const state = getState();
			if (state.dismissedSlashFrom === null) return;
			const from = dismissedSlashFrom(this.editor.state)!;
			const to = Math.min(from + 1, this.editor.state.doc.content.size);
			const dismissed = this.editor.state.doc.textBetween(from, to) === "/" ? from : null;
			if (dismissed !== state.dismissedSlashFrom) {
				onStateChange((prev) => ({ ...prev, dismissedSlashFrom: dismissed }));
			}
		},

		addProseMirrorPlugins() {
			const { editor } = this;
			return [
				// Before the suggestion, which reads where the dismissed slash is now.
				new Plugin<DismissedSlash | null>({
					key: dismissedSlashKey,
					state: {
						init: () => null,
						apply: (tr, dismissed) => {
							const from = getState().dismissedSlashFrom;
							if (from === null) return null;
							if (dismissed?.from !== from) {
								return { from, position: editor.utils.createMappablePosition(from) };
							}
							if (!isRemote(tr)) return dismissed;
							const { position } = editor.utils.getUpdatedPosition(dismissed.position, tr);
							return { from: position.position, position };
						},
					},
				}),
				Suggestion({
					editor,
					char: "/",
					startOfLine: true,
					decorationClass: "emdash-slash-query",
					command: ({ props }) => onCommand(props as SlashCommandItem),
					items: ({ query }) => filterCommands(query),
					// Titles such as "Code Block" can be typed whole; a space after no match ends the query.
					allowSpaces: true,
					allow: ({ state, range }) => {
						if (this.editor.isActive("table") || dismissedSlashFrom(state) === range.from) {
							return false;
						}
						const query = state.doc.textBetween(range.from + 1, range.to);
						return (
							!WHITESPACE_START_REGEX.test(query) &&
							(!WHITESPACE_REGEX.test(query) || filterCommands(query).length > 0)
						);
					},
					render: () => {
						return {
							onStart: (props) => {
								onStateChange({
									isOpen: true,
									mode: "commands",
									items: props.items,
									selectedIndex: 0,
									clientRect: props.clientRect ?? null,
									range: props.range,
									dismissedSlashFrom: null,
									query: props.query,
								});
							},
							onUpdate: (props) => {
								onStateChange((prev) => ({
									...prev,
									items: props.items,
									selectedIndex: 0,
									clientRect: props.clientRect ?? null,
									range: props.range,
									dismissedSlashFrom: null,
									query: props.query,
								}));
							},
							onKeyDown: (props) => {
								if (props.event.key === "Escape" || props.event.key === "Tab") {
									onDismiss();
									return props.event.key === "Escape";
								}

								if (props.event.key === "ArrowUp") {
									onStateChange((prev) => ({
										...prev,
										selectedIndex: (prev.selectedIndex - 1 + prev.items.length) % prev.items.length,
									}));
									return true;
								}

								if (props.event.key === "ArrowDown") {
									onStateChange((prev) => ({
										...prev,
										selectedIndex: (prev.selectedIndex + 1) % prev.items.length,
									}));
									return true;
								}

								if (props.event.key === "Enter") {
									const item = getState().items[getState().selectedIndex];
									if (!item) return false;
									onCommand(item);
									return true;
								}

								return false;
							},
							onExit: () => {
								onStateChange((prev) => ({ ...prev, isOpen: false }));
								onExit(editor);
							},
						};
					},
				}),
			];
		},
	});
}

/** The block insert buttons open the slash menu on a new line, so pressing one doesn't close it first. */
function isBlockInsertButton(target: EventTarget | null): boolean {
	return (
		target instanceof Element &&
		target.closest("[data-block-insert], [data-touch-block-insert]") !== null
	);
}

/** Slash command menu anchored to the TipTap caret. */
function SlashCommandMenu({
	state,
	contextElement,
	getToolbarBottom,
	onCommand,
	onClose,
	onTableInsert,
	onTableCancel,
	setSelectedIndex,
}: {
	state: SlashMenuState;
	/** The editor element, so the menu follows its line when a container scrolls. */
	contextElement: HTMLElement | undefined;
	/** Where the sticky toolbar ends, which the menu stays below. */
	getToolbarBottom: () => number;
	onCommand: (item: SlashCommandItem) => void;
	onClose: () => void;
	onTableInsert: (rows: number, columns: number, withHeaderRow: boolean) => void;
	onTableCancel: () => void;
	setSelectedIndex: (index: number) => void;
}) {
	const { t } = useLingui();
	const containerRef = React.useRef<HTMLDivElement>(null);
	const popupRef = React.useRef<HTMLDivElement>(null);
	const virtualAnchor = React.useMemo(
		() => ({
			getBoundingClientRect: () => {
				const rect = state.clientRect?.();
				// Base UI hides the menu for an empty rect, as when its line scrolls under the toolbar.
				return rect && rect.bottom > getToolbarBottom() ? rect : new DOMRect();
			},
			contextElement,
		}),
		[contextElement, getToolbarBottom, state.clientRect],
	);
	const toolbarBottom = getToolbarBottom();
	const text = (value: MessageDescriptor | string) =>
		typeof value === "string" ? value : t(value);

	// Scroll selected item into view
	React.useEffect(() => {
		if (!state.isOpen) return;
		const container = containerRef.current;
		if (!container) return;

		const selected = container.querySelector<HTMLElement>(`[data-index="${state.selectedIndex}"]`);
		if (!selected) return;
		if (state.selectedIndex === 0) {
			container.scrollTop = 0;
			return;
		}
		selected.scrollIntoView({ block: "nearest" });
	}, [state.selectedIndex, state.isOpen]);

	// Track whether the mouse has actually moved since the menu opened.
	// The menu typically opens right at the text cursor, which may sit under
	// a stationary mouse pointer. Reacting to mouseenter immediately would
	// reset the selection to whichever item happens to be under the pointer
	// the moment the menu renders -- overriding the keyboard-driven default
	// (selectedIndex: 0) and any subsequent arrow-key navigation.
	//
	// Only flip the gate on mousemove, which fires only on real pointer
	// movement, not on elements appearing under a stationary pointer.
	const hasMouseMovedRef = React.useRef(false);
	React.useEffect(() => {
		if (!state.isOpen) {
			hasMouseMovedRef.current = false;
		}
	}, [state.isOpen]);

	React.useEffect(() => {
		if (!state.isOpen) return;

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target && popupRef.current?.contains(target)) return;
			if (isBlockInsertButton(target)) return;
			onClose();
		};

		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [onClose, state.isOpen]);

	const selectedItem = state.items[state.selectedIndex];
	const selectedItemTitle = selectedItem ? text(selectedItem.title) : "";
	const groups = React.useMemo(() => {
		const byCategory: {
			key: string;
			label: string;
			entries: { item: SlashCommandItem; index: number }[];
		}[] = [];
		state.items.forEach((item, index) => {
			const label = item.category ? text(item.category) : t(BASIC_BLOCKS_CATEGORY);
			const key = state.query ? "results" : label;
			const group = byCategory.find((candidate) => candidate.key === key);
			if (group) group.entries.push({ item, index });
			else byCategory.push({ key, label, entries: [{ item, index }] });
		});
		return byCategory;
	}, [state.items, state.query, t]);

	return (
		<PopoverPrimitive.Root
			open={state.isOpen}
			modal={false}
			onOpenChange={(open, details) => {
				if (!open && state.isOpen && !isBlockInsertButton(details.event?.target ?? null)) onClose();
			}}
		>
			<PopoverPrimitive.Portal>
				{/* TipTap owns focus, so Base UI's portal guards must stay out of the Tab order. */}
				<PopoverPrimitive.Positioner
					anchor={virtualAnchor}
					side="bottom"
					align="start"
					sideOffset={6}
					positionMethod="fixed"
					collisionBoundary={{
						x: 0,
						y: toolbarBottom,
						width: window.innerWidth,
						height: Math.max(0, window.innerHeight - toolbarBottom),
					}}
					collisionPadding={8}
					collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
					className="slash-command-menu-positioner z-[100] data-anchor-hidden:invisible"
				>
					<PopoverPrimitive.Popup
						ref={popupRef}
						initialFocus={false}
						finalFocus={false}
						aria-label={t`Insert block`}
						data-slash-command-menu
						className={cn(
							"flex max-h-[min(21rem,var(--available-height))] flex-col overflow-hidden",
							state.mode === "table-size" ? "w-auto" : "w-80 max-w-[calc(100vw-1rem)]",
							editorSurfaceClassName,
							"text-base text-kumo-default",
							"origin-(--transform-origin) transition-[transform,scale,opacity] duration-100 ease-out",
							"data-starting-style:scale-[0.97] data-starting-style:opacity-0",
							"data-ending-style:opacity-0 data-ending-style:duration-75 data-instant:duration-0",
							"motion-reduce:transition-none",
						)}
						onPointerMove={() => {
							hasMouseMovedRef.current = true;
						}}
						onKeyDown={(event) => {
							// Tab past the table picker's controls goes back to the editor, as in the other menus.
							if (state.mode !== "table-size" || event.key !== "Tab") return;
							const controls = [
								...event.currentTarget.querySelectorAll<HTMLElement>("button, input, [tabindex]"),
							].filter((control) => control.tabIndex >= 0 && !control.matches(":disabled"));
							if (document.activeElement !== (event.shiftKey ? controls[0] : controls.at(-1)))
								return;
							event.preventDefault();
							onTableCancel();
						}}
					>
						{state.mode === "table-size" ? (
							<TableSizePicker onInsert={onTableInsert} onCancel={onTableCancel} />
						) : (
							<>
								{selectedItem && (
									<span className="sr-only" role="status">
										{t`Selected ${selectedItemTitle}`}
									</span>
								)}
								<div
									ref={containerRef}
									data-slash-menu-scroll-viewport
									className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1 p-1"
								>
									{state.items.length === 0 ? (
										<p className="px-2 py-1.5 text-kumo-subtle">{t`No results`}</p>
									) : (
										groups.map((group) => (
											<div
												key={group.key}
												role="group"
												aria-label={state.query ? undefined : group.label}
											>
												{!state.query && (
													<div
														aria-hidden="true"
														className="px-2 pt-2 pb-1 text-xs font-medium text-kumo-subtle select-none"
													>
														{group.label}
													</div>
												)}
												{group.entries.map(({ item, index }) => (
													<button
														key={item.id}
														type="button"
														tabIndex={-1}
														data-index={index}
														aria-current={index === state.selectedIndex ? "true" : undefined}
														className={cn(
															"flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-start",
															"pointer-coarse:h-11",
															index === state.selectedIndex && "bg-kumo-tint",
														)}
														onPointerDown={(event) => event.preventDefault()}
														onClick={() => onCommand(item)}
														onMouseEnter={() => {
															// Only react if the user has actually moved the
															// mouse since the menu opened -- not when items
															// appear under a stationary pointer.
															if (hasMouseMovedRef.current) {
																setSelectedIndex(index);
															}
														}}
													>
														<item.icon className="size-[1.125rem] flex-none text-kumo-subtle" />
														<span data-slash-item-title className="min-w-0 flex-1 truncate">
															{text(item.title)}
														</span>
														{item.markdown && (
															<span
																aria-hidden="true"
																className="flex-none ps-3 font-mono text-xs text-kumo-subtle"
															>
																<bdi dir="ltr">{item.markdown}</bdi>
															</span>
														)}
													</button>
												))}
											</div>
										))
									)}
								</div>
								<div className="flex items-center gap-3 border-t border-kumo-hairline px-3 py-2 text-xs text-kumo-subtle">
									<span className="min-w-0 flex-1 truncate" aria-hidden="true">
										{selectedItem ? text(selectedItem.description) : t`Type to filter`}
									</span>
									<span aria-hidden="true" className="flex-none pointer-coarse:hidden">
										<bdi dir="ltr">{t`esc`}</bdi>
									</span>
								</div>
							</>
						)}
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

function getPluginBlockDefaultValues(fields?: Element[]): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};

	for (const field of fields ?? []) {
		const initialValue = "initial_value" in field ? field.initial_value : undefined;
		if (initialValue !== undefined) {
			defaults[field.action_id] = initialValue;
		}
	}

	return defaults;
}

function buildPluginBlockFormValues(
	block: PluginBlockDef | null,
	initialValues?: Record<string, unknown>,
): Record<string, unknown> {
	const defaults = getPluginBlockDefaultValues(block?.fields);
	return initialValues ? { ...defaults, ...initialValues } : defaults;
}

function hasPluginBlockFormData(values: Record<string, unknown>): boolean {
	return Object.values(values).some(
		(value) => value !== undefined && value !== null && value !== "",
	);
}

interface PluginBlockProblems {
	url?: MessageDescriptor;
	/** Top-level fields by `action_id`. */
	fields: Record<string, MessageDescriptor>;
	form?: MessageDescriptor;
}

const ABSOLUTE_URI_PATTERN = /^([a-z][a-z0-9+.-]*):\S+$/i;
const UNSAFE_URI_SCHEMES = new Set(["javascript", "data", "vbscript"]);

/**
 * Any absolute URI a block can embed. URL parsing alone would refuse some,
 * such as Bluesky's `at://did:plc:…` post URIs.
 */
function isEmbeddableUrl(url: string): boolean {
	const scheme = ABSOLUTE_URI_PATTERN.exec(url)?.[1]?.toLowerCase();
	if (!scheme || UNSAFE_URI_SCHEMES.has(scheme)) return false;
	return scheme === "http" || scheme === "https" ? URL.canParse(url) : true;
}

function numberRangeProblem(field: Element, value: unknown): MessageDescriptor | undefined {
	if (field.type !== "number_input" || typeof value !== "number") return undefined;
	const min = typeof field.min === "number" ? field.min : undefined;
	const max = typeof field.max === "number" ? field.max : undefined;
	if ((min === undefined || value >= min) && (max === undefined || value <= max)) return undefined;
	if (min !== undefined && max !== undefined) return msg`Enter a number between ${min} and ${max}.`;
	if (min !== undefined) return msg`Enter a number of ${min} or more.`;
	if (max !== undefined) return msg`Enter a number of ${max} or less.`;
	return undefined;
}

function pluginBlockProblems(
	block: PluginBlockDef | null,
	values: Record<string, unknown>,
): PluginBlockProblems {
	const fields = block?.fields ?? [];
	if (fields.length === 0) {
		const url = typeof values.id === "string" ? values.id.trim() : "";
		return isEmbeddableUrl(url)
			? { fields: {} }
			: { fields: {}, url: msg`Enter a full URL, such as https://example.com.` };
	}
	if (!hasPluginBlockFormData(values)) {
		return { fields: {}, form: msg`Fill in at least one field.` };
	}
	const fieldProblems: Record<string, MessageDescriptor> = {};
	for (const field of fields) {
		const problem = numberRangeProblem(field, values[field.action_id]);
		if (problem) fieldProblems[field.action_id] = problem;
	}
	return { fields: fieldProblems };
}

/**
 * The plugin block the modal edits, by its key, or by its position while no
 * other block has the same key. A null position means the block was deleted.
 */
type EditedPluginBlock = { key: string } | PositionedPluginBlock;

/** A plugin block followed by position, with the type and ID it had when the modal opened. */
interface PositionedPluginBlock {
	position: MappablePosition | null;
	blockType: unknown;
	id: unknown;
}

function editedPluginBlockAt(editor: Editor, pos: number): EditedPluginBlock | null {
	const { doc } = editor.state;
	const node = doc.nodeAt(pos);
	if (node?.type.name !== "pluginBlock") return null;
	const positioned = (): PositionedPluginBlock => ({
		position: editor.utils.createMappablePosition(pos),
		blockType: node.attrs.blockType,
		id: node.attrs.id,
	});
	const key: unknown = node.attrs[PORTABLE_TEXT_KEY_ATTR];
	if (typeof key !== "string" || !key) return positioned();
	let holders = 0;
	doc.forEach((child) => {
		if (child.type.name === "pluginBlock" && child.attrs[PORTABLE_TEXT_KEY_ATTR] === key) holders++;
	});
	return holders === 1 ? { key } : positioned();
}

/**
 * Finds a positioned plugin block again after another client's change, which
 * replaces the whole document: where its position now points while a block of
 * the same type and ID is there, or else the only top-level block of that type
 * and ID.
 */
function refindPluginBlock(
	editor: Editor,
	block: PositionedPluginBlock,
	position: MappablePosition,
): MappablePosition | null {
	const same = (node: ProseMirrorNode | null) =>
		node?.type.name === "pluginBlock" &&
		node.attrs.blockType === block.blockType &&
		node.attrs.id === block.id;
	const { doc } = editor.state;
	if (same(doc.nodeAt(position.position))) return position;
	const found: number[] = [];
	doc.forEach((child, offset) => {
		if (same(child)) found.push(offset);
	});
	return found.length === 1 ? editor.utils.createMappablePosition(found[0]!) : null;
}

function findPluginBlock(
	doc: ProseMirrorNode,
	block: EditedPluginBlock,
): { node: ProseMirrorNode; pos: number } | null {
	if ("position" in block) {
		if (block.position === null) return null;
		const pos = block.position.position;
		const node = doc.nodeAt(pos);
		return node?.type.name === "pluginBlock" ? { node, pos } : null;
	}
	let pos = 0;
	for (let index = 0; index < doc.childCount; index++) {
		const node = doc.child(index);
		if (node.type.name === "pluginBlock" && node.attrs[PORTABLE_TEXT_KEY_ATTR] === block.key) {
			return { node, pos };
		}
		pos += node.nodeSize;
	}
	return null;
}

/**
 * Plugin block insertion/editing modal.
 * When the block has `fields`, renders Block Kit elements.
 * Otherwise falls back to a simple URL input.
 */
function PluginBlockModal({
	block,
	initialValues,
	onClose,
	onInsert,
}: {
	block: PluginBlockDef | null;
	/** Pre-populated values when editing an existing block */
	initialValues?: Record<string, unknown>;
	onClose: () => void;
	/** Returns why the values couldn't be saved, leaving the modal open. */
	onInsert: (values: Record<string, unknown>) => MessageDescriptor | undefined;
}) {
	const [formValues, setFormValues] = React.useState<Record<string, unknown>>({});
	const [touched, setTouched] = React.useState(false);
	const [submitted, setSubmitted] = React.useState(false);
	const [insertProblem, setInsertProblem] = React.useState<MessageDescriptor | undefined>();
	const inputRef = React.useRef<HTMLInputElement>(null);
	const formId = React.useId();
	const { t } = useLingui();

	React.useEffect(() => {
		if (block) {
			setFormValues(buildPluginBlockFormValues(block, initialValues));
			setTouched(false);
			setSubmitted(false);
			setInsertProblem(undefined);
			if (!block.fields || block.fields.length === 0) {
				setTimeout(() => inputRef.current?.focus(), 0);
			}
		}
	}, [block, initialValues]);

	const problems = pluginBlockProblems(block, formValues);
	const urlError = submitted && problems.url ? t(problems.url) : undefined;
	const formError = submitted && problems.form ? t(problems.form) : null;
	const fieldErrors = submitted ? problems.fields : {};

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		e.stopPropagation();
		const form = e.currentTarget;
		if (problems.url || problems.form || Object.keys(problems.fields).length > 0) {
			revealErrors(form, () => setSubmitted(true));
			return;
		}
		// The form is noValidate, so the browser's own checks on fields inside repeater items run here.
		if (!form.reportValidity()) return;
		if (block?.fields && block.fields.length > 0) {
			setInsertProblem(onInsert(formValues));
		} else {
			const url = typeof formValues.id === "string" ? formValues.id.trim() : "";
			setInsertProblem(onInsert({ id: url }));
		}
	};

	const handleFieldChange = (actionId: string, value: unknown) => {
		setTouched(true);
		setFormValues((prev) => ({ ...prev, [actionId]: value }));
	};

	const isEditing = !!initialValues;
	const hasFields = block?.fields && block.fields.length > 0;

	const dialogSize = hasFields ? "xl" : "sm";

	return (
		<LayerDialog.Root
			open={!!block}
			{...guardUnsavedInput(touched, (open: boolean) => !open && onClose())}
		>
			<LayerDialog.Content size={dialogSize}>
				<LayerDialog.Title>
					{isEditing ? t`Edit ${block?.label || ""}` : t`Insert ${block?.label || ""}`}
				</LayerDialog.Title>
				<LayerDialog.Description>
					{hasFields ? t`Fill in what this block shows.` : t`Paste the address of what to embed.`}
				</LayerDialog.Description>
				<LayerDialog.Body>
					<form id={formId} noValidate onSubmit={handleSubmit}>
						<div className="grid gap-5" data-field-invalid={formError ? true : undefined}>
							{hasFields ? (
								block.fields!.map((field) => {
									const fieldError = fieldErrors[field.action_id];
									const errorId = fieldError ? `${formId}-${field.action_id}-error` : undefined;
									return (
										<div key={field.action_id} data-field-invalid={fieldError ? true : undefined}>
											<BlockKitField
												field={field}
												pluginId={block.pluginId}
												value={formValues[field.action_id]}
												onChange={handleFieldChange}
												errorId={errorId}
											/>
											{fieldError && (
												<Text
													as="p"
													id={errorId}
													role="alert"
													variant="error"
													size="sm"
													DANGEROUS_className="mt-2"
												>
													{t(fieldError)}
												</Text>
											)}
										</div>
									);
								})
							) : (
								<Input
									dir="ltr"
									ref={inputRef}
									type="text"
									inputMode="url"
									className="w-full"
									label={t`URL`}
									placeholder={block?.placeholder || t`Enter URL...`}
									value={typeof formValues.id === "string" ? formValues.id : ""}
									onChange={(e) => handleFieldChange("id", e.target.value)}
									required
									error={urlError}
									aria-invalid={urlError ? true : undefined}
								/>
							)}
						</div>
						<DialogError
							message={formError ?? (insertProblem ? t(insertProblem) : null)}
							className="mt-4"
						/>
					</form>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={t`Cancel`}>
					<LayerDialog.Action type="submit" form={formId}>
						{isEditing ? t`Save` : t`Insert`}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</LayerDialog.Root>
	);
}

/**
 * Renders a single Block Kit field element.
 * Supports text_input, number_input, select (with optional async options), and toggle.
 */
function BlockKitField({
	field,
	pluginId,
	value,
	onChange,
	errorId,
}: {
	field: Element;
	pluginId?: string;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
	/** The element describing this field's error, when it has one. */
	errorId?: string;
}) {
	const id = React.useId();
	switch (field.type) {
		case "text_input": {
			const multiline = !!field.multiline;
			const placeholder = typeof field.placeholder === "string" ? field.placeholder : undefined;
			const Tag = multiline ? "textarea" : "input";
			return (
				<div>
					<label id={`${id}-label`} htmlFor={id} className="text-sm font-medium mb-1.5 block">
						{field.label}
					</label>
					{multiline ? (
						<Tag
							id={id}
							aria-labelledby={`${id}-label`}
							className="flex w-full rounded-md border border-kumo-line bg-transparent px-3 py-2 text-sm ring-offset-background placeholder:text-kumo-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 min-h-[80px]"
							placeholder={placeholder}
							value={typeof value === "string" ? value : ""}
							onChange={(e) => onChange(field.action_id, e.target.value)}
						/>
					) : (
						<Input
							id={id}
							aria-labelledby={`${id}-label`}
							type="text"
							className="w-full"
							placeholder={placeholder}
							value={typeof value === "string" ? value : ""}
							onChange={(e) => onChange(field.action_id, e.target.value)}
						/>
					)}
				</div>
			);
		}
		case "number_input": {
			const min = typeof field.min === "number" ? field.min : undefined;
			const max = typeof field.max === "number" ? field.max : undefined;
			return (
				<div>
					<label id={`${id}-label`} htmlFor={id} className="text-sm font-medium mb-1.5 block">
						{field.label}
					</label>
					<Input
						id={id}
						aria-labelledby={`${id}-label`}
						aria-invalid={errorId ? true : undefined}
						aria-describedby={errorId}
						type="number"
						className="w-full"
						min={min}
						max={max}
						value={typeof value === "number" ? String(value) : ""}
						onChange={(e) =>
							onChange(field.action_id, e.target.value ? Number(e.target.value) : undefined)
						}
					/>
				</div>
			);
		}
		case "select": {
			return <DynamicSelect field={field} pluginId={pluginId} value={value} onChange={onChange} />;
		}
		case "toggle": {
			return (
				<Switch
					aria-label={field.label}
					checked={!!value}
					onCheckedChange={(checked) => onChange(field.action_id, checked)}
					label={<span className="text-sm font-medium">{field.label}</span>}
				/>
			);
		}
		case "repeater": {
			if (isNonListValue(value)) {
				return (
					<NonListFieldValue
						label={field.label}
						value={value}
						onReplace={() => onChange(field.action_id, [])}
					/>
				);
			}
			return (
				<BlockKitRepeater field={field} pluginId={pluginId} value={value} onChange={onChange} />
			);
		}
		case "media_picker": {
			return (
				<BlockKitMediaPickerField
					actionId={field.action_id}
					label={field.label}
					placeholder={field.placeholder}
					mimeTypeFilter={field.mime_type_filter}
					value={value}
					onChange={onChange}
				/>
			);
		}
		default:
			return <div className="text-sm text-kumo-subtle">Unknown field type: {field.type}</div>;
	}
}

// ── Repeater support ─────────────────────────────────────────────────────────

type RepeaterItem = Record<string, unknown> & { _key: string };

function ensureKeys(items: unknown[]): RepeaterItem[] {
	return items.map((item, i) => {
		const obj = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		return { ...obj, _key: (obj._key as string) || `item-${i}-${Date.now()}` };
	});
}

function stripKeys(items: RepeaterItem[]): Record<string, unknown>[] {
	return items.map(({ _key, ...rest }) => rest);
}

function BlockKitRepeater({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "repeater" }>;
	pluginId?: string;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	const { t } = useLingui();
	const labelId = React.useId();
	const rawItems = React.useMemo<unknown[]>(() => (Array.isArray(value) ? value : []), [value]);

	const [items, setItems] = React.useState<RepeaterItem[]>(() => ensureKeys(rawItems));
	const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	// Track the array we just emitted upstream. When `value` flows back as
	// the same reference, the resync below is a no-op and we skip the
	// setState round-trip that would otherwise reseed local state on every
	// keystroke.
	const lastEmittedRef = React.useRef<unknown[] | null>(null);

	// Preserve each item's _key by position so round-trips through onChange
	// (which strips _key) don't remount children and flip them back to
	// collapsed on every keystroke.
	React.useEffect(() => {
		if (lastEmittedRef.current === rawItems) return;
		setItems((prev) =>
			rawItems.map((item, i) => {
				const obj = (typeof item === "object" && item !== null ? item : {}) as Record<
					string,
					unknown
				>;
				const existingKey = (obj._key as string) || prev[i]?._key;
				return {
					...obj,
					_key: existingKey || `item-${i}-${Date.now()}`,
				};
			}),
		);
	}, [rawItems]);

	const minItems = field.min_items ?? 0;
	const maxItems = field.max_items;
	const canAdd = maxItems === undefined || items.length < maxItems;
	const canRemove = items.length > minItems;
	// Only interpolate plugin-provided labels into translations; otherwise
	// use a self-contained `Add item` string so message extractors and
	// translators see whole, inflectable phrases.
	const addButtonLabel = field.item_label ? t`Add ${field.item_label}` : t`Add item`;

	const emit = (next: RepeaterItem[]) => {
		setItems(next);
		const stripped = stripKeys(next);
		lastEmittedRef.current = stripped;
		onChange(field.action_id, stripped);
	};

	const handleAdd = () => {
		if (!canAdd) return;
		const newItem: RepeaterItem = {
			_key: `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
		};
		for (const sf of field.fields) {
			switch (sf.type) {
				case "toggle":
					newItem[sf.action_id] = false;
					break;
				case "number_input":
					newItem[sf.action_id] = undefined;
					break;
				default:
					newItem[sf.action_id] = "";
			}
		}
		setExpanded((prev) => {
			const next = new Set(prev);
			next.add(newItem._key);
			return next;
		});
		emit([...items, newItem]);
	};

	const handleRemove = (key: string) => {
		if (!canRemove) return;
		setExpanded((prev) => {
			if (!prev.has(key)) return prev;
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
		emit(items.filter((it) => it._key !== key));
	};

	const handleItemChange = (key: string, subActionId: string, subValue: unknown) => {
		emit(items.map((it) => (it._key === key ? { ...it, [subActionId]: subValue } : it)));
	};

	const handleDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (!over || active.id === over.id) return;
		const oldIndex = items.findIndex((it) => it._key === active.id);
		const newIndex = items.findIndex((it) => it._key === over.id);
		if (oldIndex === -1 || newIndex === -1) return;
		emit(arrayMove(items, oldIndex, newIndex));
	};

	const toggleExpanded = (key: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return (
		<div role="group" aria-labelledby={labelId} className="space-y-2">
			<div className="flex items-center justify-between">
				<span id={labelId} className="text-sm font-medium">
					{field.label}
					{items.length > 0 && (
						<span className="ms-2 text-kumo-subtle font-normal">({items.length})</span>
					)}
				</span>
				{canAdd && (
					<Button variant="outline" size="sm" icon={<Plus />} onClick={handleAdd} type="button">
						{addButtonLabel}
					</Button>
				)}
			</div>

			{items.length === 0 ? (
				<div className="border-2 border-dashed rounded-lg p-6 text-center text-kumo-subtle">
					<p className="text-sm">{t`No items yet`}</p>
					{canAdd && (
						<Button
							variant="outline"
							size="sm"
							className="mt-2"
							icon={<Plus />}
							onClick={handleAdd}
							type="button"
						>
							{addButtonLabel}
						</Button>
					)}
				</div>
			) : (
				<DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
					<SortableContext
						items={items.map((it) => it._key)}
						strategy={verticalListSortingStrategy}
					>
						<div className="space-y-2">
							{items.map((item, index) => (
								<BlockKitRepeaterItem
									key={item._key}
									item={item}
									index={index}
									fields={field.fields}
									pluginId={pluginId}
									isCollapsed={!expanded.has(item._key)}
									onToggleCollapse={() => toggleExpanded(item._key)}
									onRemove={canRemove ? () => handleRemove(item._key) : undefined}
									onChange={(subActionId, v) => handleItemChange(item._key, subActionId, v)}
								/>
							))}
						</div>
					</SortableContext>
				</DndContext>
			)}
		</div>
	);
}

function BlockKitRepeaterItem({
	item,
	index,
	fields,
	pluginId,
	isCollapsed,
	onToggleCollapse,
	onRemove,
	onChange,
}: {
	item: RepeaterItem;
	index: number;
	fields: Extract<Element, { type: "repeater" }>["fields"];
	pluginId?: string;
	isCollapsed: boolean;
	onToggleCollapse: () => void;
	onRemove?: () => void;
	onChange: (subActionId: string, value: unknown) => void;
}) {
	const { t } = useLingui();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: item._key,
	});

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	// Summary label: value of the first text_input sub-field, falling back to "Item N".
	const summaryField = fields.find((f) => f.type === "text_input");
	const summaryValue =
		summaryField && typeof item[summaryField.action_id] === "string"
			? (item[summaryField.action_id] as string)
			: "";
	const summaryLabel = summaryValue.trim() || t`Item ${index + 1}`;

	return (
		<div
			ref={setNodeRef}
			style={style}
			className={cn(
				"border border-kumo-line rounded-lg bg-kumo-base",
				isDragging && "opacity-50 ring-2 ring-kumo-brand",
			)}
		>
			<div className="flex items-center gap-2 px-3 py-2 border-b border-kumo-line">
				<span
					className="inline-flex h-4 w-4 text-kumo-subtle cursor-grab shrink-0"
					aria-label={t`Drag to reorder`}
					{...attributes}
					{...listeners}
				>
					<DotsSixVertical className="h-4 w-4" />
				</span>
				<button
					type="button"
					className="flex items-center gap-2 flex-1 min-w-0 text-start cursor-pointer"
					onClick={onToggleCollapse}
					aria-expanded={!isCollapsed}
				>
					{isCollapsed ? (
						<CaretNext className="h-4 w-4 text-kumo-subtle shrink-0" />
					) : (
						<CaretDown className="h-4 w-4 text-kumo-subtle shrink-0" />
					)}
					<span className="text-sm font-medium flex-1 truncate">{summaryLabel}</span>
				</button>
				{onRemove && (
					<Button
						variant="ghost"
						shape="square"
						type="button"
						onClick={onRemove}
						aria-label={t`Remove item ${index + 1}`}
					>
						<Trash className="h-3.5 w-3.5 text-kumo-danger" />
					</Button>
				)}
			</div>

			{!isCollapsed && (
				<div className="p-3 space-y-3">
					{fields.map((sf) => (
						<BlockKitField
							key={sf.action_id}
							field={sf}
							pluginId={pluginId}
							value={item[sf.action_id]}
							onChange={(actionId, v) => onChange(actionId, v)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Select field that supports loading options dynamically via `optionsRoute`.
 * When `optionsRoute` is set, fetches `{ items: [{ id, name }] }` from the plugin route.
 */
function DynamicSelect({
	field,
	pluginId,
	value,
	onChange,
}: {
	field: Extract<Element, { type: "select" }>;
	pluginId?: string;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}) {
	const labelId = React.useId();
	const [dynamicOptions, setDynamicOptions] = React.useState<Array<{
		label: string;
		value: string;
	}> | null>(null);
	const [loading, setLoading] = React.useState(false);
	const { t } = useLingui();

	React.useEffect(() => {
		if (!field.optionsRoute || !pluginId) return;
		const controller = new AbortController();
		setLoading(true);
		void (async () => {
			try {
				const res = await fetch(`/_emdash/api/plugins/${pluginId}/${field.optionsRoute}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-EmDash-Request": "1",
					},
					body: JSON.stringify({}),
					signal: controller.signal,
				});
				if (res.ok) {
					const body = (await res.json()) as {
						data: { items?: Array<{ id: string; name: string }> };
					};
					if (body.data?.items) {
						setDynamicOptions(
							body.data.items.map((item) => ({ label: item.name, value: item.id })),
						);
					}
				}
			} catch {
				// Failed to load options or aborted — static options will be used
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			}
		})();
		return () => controller.abort();
	}, [field.optionsRoute, pluginId]);

	const options = dynamicOptions ?? field.options;

	return (
		<div>
			<span id={labelId} className="text-sm font-medium mb-1.5 block">
				{field.label}
			</span>
			{loading ? (
				<div className="flex h-10 items-center px-3 text-sm text-kumo-subtle">{t`Loading...`}</div>
			) : (
				<Select
					aria-labelledby={labelId}
					className="w-full"
					value={typeof value === "string" ? value : ""}
					onValueChange={(v) => onChange(field.action_id, v ?? "")}
					items={{
						"": t`Select...`,
						...Object.fromEntries(options.map((opt) => [opt.value, opt.label])),
					}}
				/>
			)}
		</div>
	);
}

// Re-export for consumers
export type { PluginBlockDef } from "./editor/PluginBlockNode";

// Exported for unit testing (pure functions, no React dependencies)
export { prosemirrorToPortableText as _prosemirrorToPortableText };
export { portableTextToProsemirror as _portableTextToProsemirror };
export {
	buildPluginBlockFormValues as _buildPluginBlockFormValues,
	hasPluginBlockFormData as _hasPluginBlockFormData,
};

// =============================================================================
// Editor Footer with Writing Metrics
// =============================================================================

// Reading speed used for the footer metrics. CJK characters get a separate,
// higher rate because they are denser than space-delimited words. These mirror
// the published reading-time util (templates/blog/src/utils/reading-time.ts,
// covered by packages/core/tests/unit/templates/blog-reading-time.test.ts) so
// the editor footer and the rendered site report the same numbers.
const WORDS_PER_MINUTE = 200;
const CJK_CHARACTERS_PER_MINUTE = 500;
const WHITESPACE_REGEX = /\s+/;
const WHITESPACE_START_REGEX = /^\s/;
const NON_WHITESPACE_REGEX = /\S/;
const SCROLLING_OVERFLOW_REGEX = /auto|scroll|overlay/;

// CJK scripts do not separate words with spaces, so a split()-based count treats
// a whole paragraph as a single word. Count those characters individually.
const CJK_CHARACTER_REGEX =
	/\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/gu;

function countCjkCharacters(text: string): number {
	return text.match(CJK_CHARACTER_REGEX)?.length ?? 0;
}

function countNonCjkWords(text: string): number {
	return text.replace(CJK_CHARACTER_REGEX, " ").split(WHITESPACE_REGEX).filter(Boolean).length;
}

/**
 * Word count for the editor footer. CJK characters are counted individually
 * because they are not delimited by spaces; other scripts are counted by word.
 * Used as the `wordCounter` for the CharacterCount extension, whose default
 * (`text.split(' ')`) reports a spaceless CJK paragraph as a single word.
 */
export function countWords(text: string): number {
	return countNonCjkWords(text) + countCjkCharacters(text);
}

/**
 * Calculate reading time in minutes for the given text. Word-based scripts are
 * read at WORDS_PER_MINUTE and CJK characters at CJK_CHARACTERS_PER_MINUTE.
 * Returns 0 for an empty document.
 */
export function calculateReadingTime(text: string): number {
	return Math.ceil(
		countNonCjkWords(text) / WORDS_PER_MINUTE +
			countCjkCharacters(text) / CJK_CHARACTERS_PER_MINUTE,
	);
}

/**
 * Editor footer showing writing metrics (word count, character count, reading time)
 */
function EditorFooter({
	editor,
	variant = "boxed",
}: {
	editor: Editor;
	variant?: PortableTextEditorProps["variant"];
}) {
	const { words, characters, text } = useEditorState({
		editor,
		selector: (ctx) => {
			const storage: { words: () => number; characters: () => number } =
				ctx.editor.storage.characterCount;
			return {
				words: storage.words(),
				characters: storage.characters(),
				text: ctx.editor.getText(),
			};
		},
	});

	// Subscribes to locale changes so the plural messages below re-render.
	useLinguiContext();
	const readingTime = calculateReadingTime(text);

	if (variant === "document") {
		if (characters === 0) return null;
		return (
			<div className="flex items-center gap-3">
				<span aria-hidden="true" className="h-px min-w-6 flex-1 bg-kumo-hairline" />
				<div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-kumo-subtle tabular-nums">
					<span>{plural(words, { one: "# word", other: "# words" })}</span>
					<span aria-hidden="true">·</span>
					<span>{plural(characters, { one: "# character", other: "# characters" })}</span>
					<span aria-hidden="true">·</span>
					<span>{plural(readingTime, { one: "# min read", other: "# min read" })}</span>
				</div>
				<span aria-hidden="true" className="h-px min-w-6 flex-1 bg-kumo-hairline" />
			</div>
		);
	}

	return (
		<div className="border-t px-4 py-2 flex items-center gap-4 text-xs text-kumo-subtle">
			<span>{plural(words, { one: "# word", other: "# words" })}</span>
			<span>{plural(characters, { one: "# character", other: "# characters" })}</span>
			<span>{plural(readingTime, { one: "# min read", other: "# min read" })}</span>
		</div>
	);
}

/**
 * The space below the last block, holding the word count. Clicking anywhere
 * in it continues writing at the end, like the end of a page.
 */
function DocumentEnd({
	editor,
	editable,
	children,
}: {
	editor: Editor;
	editable: boolean;
	children?: React.ReactNode;
}) {
	if (!editable) return <div className="pt-8 pb-6">{children}</div>;
	return (
		<div
			className="cursor-text pt-8 pb-6"
			onMouseDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				// The trailing-node extension keeps a paragraph after any other last block.
				if (!event.shiftKey) {
					editor.commands.focus("end");
					return;
				}
				const { doc, selection } = editor.state;
				// A selected block, such as an image, stays in the selection.
				const anchor =
					selection instanceof NodeSelection
						? (Selection.findFrom(selection.$from, -1, true)?.from ?? selection.from)
						: selection.anchor;
				const extended = TextSelection.between(doc.resolve(anchor), Selection.atEnd(doc).$to);
				editor.chain().focus().setTextSelection({ from: extended.anchor, to: extended.head }).run();
			}}
		>
			{children}
		</div>
	);
}

export { EditorFooter as _EditorFooter };

/** Focus mode state for the editor */
export type FocusMode = "normal" | "spotlight";

/** Describes a block sidebar panel request from a node view */
export interface BlockSidebarPanel {
	type: string;
	attrs: Record<string, unknown>;
	onUpdate: (attrs: Record<string, unknown>) => void;
	onReplace: (attrs: Record<string, unknown>) => void;
	onDelete: () => void;
	onClose: () => void;
}

// Editor Props
export interface PortableTextEditorProps {
	value?: PortableTextBlock[];
	onChange?: (value: PortableTextBlock[]) => void;
	placeholder?: string;
	className?: string;
	editable?: boolean;
	/** ID of label element for accessibility */
	"aria-labelledby"?: string;
	/** Plugin blocks available for insertion via slash commands */
	pluginBlocks?: PluginBlockDef[];
	/** Focus mode - controlled from parent for distraction-free mode coordination */
	focusMode?: FocusMode;
	/** Callback when focus mode changes */
	onFocusModeChange?: (mode: FocusMode) => void;
	/** Callback to receive the editor instance for external integrations.
	 * Called with the editor on mount, and with `null` on unmount so consumers
	 * can clear stale references (e.g. before the next instance mounts). */
	onEditorReady?: (editor: Editor | null) => void;
	/** Minimal chrome - hides toolbar, border, footer (distraction-free mode) */
	minimal?: boolean;
	/** Callback when a block node requests sidebar space (e.g. image settings) */
	onBlockSidebarOpen?: (panel: BlockSidebarPanel) => void;
	/** Callback when a block node closes its sidebar */
	onBlockSidebarClose?: () => void;
	/**
	 * `boxed` (default) frames the editor with a border and an attached
	 * toolbar. `document` lays it out like a page: no frame, a floating toolbar
	 * that sticks while you scroll, and block handles in a gutter the host
	 * reserves with `--emdash-editor-gutter` inline padding.
	 */
	variant?: "boxed" | "document";
	/**
	 * Called when ArrowUp moves past the first line of the document, so the
	 * host can move focus to the field above, such as the page title.
	 */
	onArrowUpAtStart?: () => void;
	/**
	 * Binds the editor to a field of a co-editing room, read once on mount. The
	 * room's document is then the content: `value` is ignored, `onChange` is
	 * never called, and undo is the room's own, limited to this editor's edits.
	 */
	collaboration?: RichTextBinding;
}

// For external providers, src is only used for admin preview; the frontend Image
// component uses provider + mediaId to generate proper URLs.
function mediaItemToImageAttrs(item: MediaItem) {
	return {
		src: item.url,
		alt: item.alt || item.filename,
		mediaId: item.id,
		provider: canonicalMediaProviderId(item.provider),
		width: item.width,
		height: item.height,
		blurhash: item.blurhash,
		dominantColor: item.dominantColor,
	};
}

const EMPTY_PLUGIN_BLOCKS: PluginBlockDef[] = [];
const BUILTIN_BLOCKS_PLUGIN_ID = "emdash";

/**
 * The repeater drops `_key` from the rows it emits, so each button's key rides
 * along under this name while the form is open.
 */
const BUTTON_KEY_FIELD = "_editorKey";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withButtonKeyField(buttons: unknown): unknown {
	if (!Array.isArray(buttons)) return buttons;
	return buttons.map((item) =>
		isRecord(item) && typeof item._key === "string"
			? { ...item, [BUTTON_KEY_FIELD]: item._key }
			: item,
	);
}

/** Shapes repeater rows into the `button` items `Buttons.astro` renders. */
function normalizeButtonItems(items: unknown): unknown {
	if (!Array.isArray(items)) return items;
	return items.filter(isRecord).map((item) => {
		const { url, style, [BUTTON_KEY_FIELD]: key, ...rest } = item;
		return {
			...rest,
			_type: "button",
			_key: typeof key === "string" && key ? key : generateKey(),
			text: typeof item.text === "string" ? item.text : "",
			...(typeof url === "string" && url.trim() ? { url: url.trim() } : {}),
			...(typeof style === "string" && style ? { style } : {}),
		};
	});
}

/**
 * Portable Text Editor Component
 */
export function PortableTextEditor({
	value,
	onChange,
	placeholder,
	className,
	editable = true,
	"aria-labelledby": ariaLabelledby,
	pluginBlocks: externalPluginBlocks = EMPTY_PLUGIN_BLOCKS,
	focusMode: controlledFocusMode,
	onEditorReady,
	minimal = false,
	onBlockSidebarOpen,
	onBlockSidebarClose,
	variant = "boxed",
	onArrowUpAtStart,
	collaboration: collaborationProp,
}: PortableTextEditorProps) {
	const { t } = useLingui();
	const [collaboration] = React.useState(collaborationProp);
	// The drag handle's plugin moves the handle's element out of React's tree, so the handle can't
	// unmount while the editor lives. Once mounted it stays, and hides itself while read-only.
	const [dragHandleMounted, setDragHandleMounted] = React.useState(editable);
	if (editable && !dragHandleMounted) setDragHandleMounted(true);
	const onArrowUpAtStartRef = React.useRef(onArrowUpAtStart);
	onArrowUpAtStartRef.current = onArrowUpAtStart;
	const isDocument = variant === "document";
	const documentPlaceholder = placeholder ?? t`Start writing, or type '/' for commands`;
	const placeholderRef = React.useRef<Parameters<typeof createTextBlockPlaceholder>[0]>(
		() => documentPlaceholder,
	);
	// An empty heading always names its level; other blocks hint only where the caret is.
	placeholderRef.current = ({ node, parent, hasAnchor }) => {
		if (node.type.name === "heading") {
			const headingType = textBlockTypes.find((type) => type.id === `heading${node.attrs.level}`);
			return headingType ? t(headingType.label) : documentPlaceholder;
		}
		if (node.type.name !== "paragraph" || !hasAnchor) return "";
		if (parent?.type.name === "listItem") return t`List`;
		if (parent?.type.name === "blockquote") return t`Quote`;
		return documentPlaceholder;
	};
	const toolbarRef = React.useRef<HTMLDivElement>(null);
	// Where the sticky toolbar's cover ends: its card, and the fade under it while it's stuck.
	const getToolbarBottom = React.useCallback(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar) return 0;
		const { bottom } = toolbar.getBoundingClientRect();
		if (!toolbar.hasAttribute("data-stuck")) return bottom;
		return bottom + (Number.parseFloat(getComputedStyle(toolbar, "::after").height) || 0);
	}, []);
	const floatingRootRef = React.useRef<HTMLDivElement>(null);
	const appendBubbleMenu = React.useCallback(() => floatingRootRef.current!, []);
	const getBubbleMenuCollisionOptions = React.useCallback(() => {
		const viewport = window.visualViewport;
		const viewportTop = viewport?.offsetTop ?? 0;
		const viewportLeft = viewport?.offsetLeft ?? 0;
		const viewportWidth = viewport?.width ?? window.innerWidth;
		const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
		const toolbarBottom = getToolbarBottom() || viewportTop;
		const safeTop = Math.min(viewportBottom, Math.max(viewportTop, toolbarBottom));

		return {
			rootBoundary: {
				x: viewportLeft,
				y: safeTop,
				width: viewportWidth,
				height: Math.max(0, viewportBottom - safeTop),
			},
			padding: 8,
		};
	}, []);

	// Use a ref for onChange to avoid recreating the editor when the callback changes
	const onChangeRef = React.useRef(onChange);
	const lastPortableTextValueRef = React.useRef(value || []);
	// The document last handed to onChange, starting from the loaded one.
	const lastReportedDocRef = React.useRef<ProseMirrorNode | null>(null);
	React.useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	const focusMode = controlledFocusMode ?? "normal";

	// Media picker state (for image insertion)
	const [mediaPickerOpen, setMediaPickerOpen] = React.useState(false);

	const [videoPickerOpen, setVideoPickerOpen] = React.useState(false);

	// Multi-select media picker state (for gallery insertion)
	const [galleryPickerOpen, setGalleryPickerOpen] = React.useState(false);
	const [conversionErrorMarks, setConversionErrorMarks] = React.useState<string[]>([]);
	const [conversionTableError, setConversionTableError] =
		React.useState<UnsafePortableTextTableError | null>(null);
	const [sectionInsertErrorMarks, setSectionInsertErrorMarks] = React.useState<string[]>([]);
	const [sectionInsertTableError, setSectionInsertTableError] = React.useState(false);
	const tablePasteErrorIdRef = React.useRef(0);
	const [tablePasteError, setTablePasteError] = React.useState<{
		id: number;
		reason: TablePasteRejection;
	} | null>(null);
	const [tableAnnouncement, setTableAnnouncement] = React.useState<{
		id: number;
		text: string;
	} | null>(null);
	const announceTable = React.useCallback((text: string) => {
		setTableAnnouncement((current) => ({ id: (current?.id ?? 0) + 1, text }));
	}, []);
	const rejectTablePaste = React.useCallback((reason: TablePasteRejection) => {
		tablePasteErrorIdRef.current++;
		setTablePasteError({ id: tablePasteErrorIdRef.current, reason });
	}, []);
	const extensionAnnouncementRef = React.useRef<(rows?: number, columns?: number) => void>(
		() => {},
	);
	extensionAnnouncementRef.current = (rows, columns) =>
		announceTable(
			rows === undefined ? t`Column width resized` : t`${rows} × ${columns} table pasted`,
		);
	const queryClient = useQueryClient();
	const uploadImageRef = React.useRef(async (file: File, signal: AbortSignal) => {
		const item = await uploadMedia(file, { signal });
		void queryClient.invalidateQueries({ queryKey: ["media"] });
		if (file.type.startsWith("video/")) return mediaItemToVideoAttrs(item);
		return mediaItemToImageAttrs({ ...item, url: item.url || localMediaFileUrl(item.storageKey) });
	});

	// Plugin block insertion/editing state
	const [pluginBlockModal, setPluginBlockModal] = React.useState<PluginBlockDef | null>(null);
	const [pluginBlockInitialValues, setPluginBlockInitialValues] = React.useState<
		Record<string, unknown> | undefined
	>(undefined);
	/** The plugin block the modal is editing, or null while it inserts one */
	const editingBlockRef = React.useRef<EditedPluginBlock | null>(null);

	// Section picker state (for inserting sections)
	const [sectionPickerOpen, setSectionPickerOpen] = React.useState(false);
	const pendingBlockInsertPosRef = React.useRef<MappablePosition | null>(null);
	const openToolbarImagePicker = React.useCallback(() => {
		pendingBlockInsertPosRef.current = null;
		setMediaPickerOpen(true);
	}, []);

	// Slash commands state
	const [slashMenuState, setSlashMenuStateRaw] = React.useState<SlashMenuState>({
		isOpen: false,
		mode: "commands",
		items: [],
		selectedIndex: 0,
		clientRect: null,
		range: null,
		dismissedSlashFrom: null,
		query: "",
	});
	const insertedLineRef = React.useRef<InsertedSlashLine | null>(null);
	const slashMenuActionsRef = React.useRef({
		run: (_item: SlashCommandItem) => {},
		dismiss: () => {},
	});

	// Ref to access current state synchronously in keyboard handlers.
	//
	// TipTap's Suggestion plugin invokes onKeyDown handlers synchronously and
	// reads state via getState() during the same call. A useEffect-based sync
	// runs after commit -- too late, so keyboard handlers would see stale
	// state (empty items, null range, stale selectedIndex) on the first event
	// after a state change. This caused intermittent CI failures where Enter
	// would not execute a command and arrow navigation would skip selections.
	//
	// To guarantee the ref is current even when callers pass a functional
	// updater (which React would otherwise defer until it processes the
	// queued update), we compute `next` synchronously from the ref's current
	// value, write the ref immediately, and enqueue the React update using
	// the precomputed `next`. The ref acts as the canonical "latest intent"
	// store for any synchronous reader between setter call and React commit.
	//
	// Invariant: slashMenuStateRef.current reflects the most recent intent
	// passed to setSlashMenuState, not necessarily committed React state. That
	// is safe for synchronous keyboard handlers (which is all we use it for)
	// but should not be relied on for interleaved concurrent renders.
	const slashMenuStateRef = React.useRef(slashMenuState);
	const setSlashMenuState: React.Dispatch<React.SetStateAction<SlashMenuState>> = React.useCallback(
		(action) => {
			const next = typeof action === "function" ? action(slashMenuStateRef.current) : action;
			slashMenuStateRef.current = next;
			setSlashMenuStateRaw(next);
		},
		[],
	);

	const pluginBlocks = React.useMemo(() => {
		if (externalPluginBlocks.some((block) => block.type === "buttons")) return externalPluginBlocks;
		const buttonsBlock: PluginBlockDef = {
			type: "buttons",
			pluginId: BUILTIN_BLOCKS_PLUGIN_ID,
			label: t`Buttons`,
			icon: "link",
			description: t`Add one or more link buttons`,
			category: t(BASIC_BLOCKS_CATEGORY),
			fields: [
				{
					type: "select",
					action_id: "layout",
					label: t`Layout`,
					initial_value: "horizontal",
					options: [
						{ label: t`Horizontal`, value: "horizontal" },
						{ label: t`Vertical`, value: "vertical" },
					],
				},
				{
					type: "repeater",
					action_id: "buttons",
					label: t`Buttons`,
					item_label: t`button`,
					fields: [
						{ type: "text_input", action_id: "text", label: t`Text` },
						{ type: "text_input", action_id: "url", label: t`URL`, placeholder: "https://" },
						{
							type: "select",
							action_id: "style",
							label: t`Style`,
							options: [
								{ label: t({ message: "Default", context: "button style" }), value: "default" },
								{ label: t({ message: "Outline", context: "button style" }), value: "outline" },
								{ label: t({ message: "Fill", context: "button style" }), value: "fill" },
							],
						},
					],
				},
			],
		};
		return [...externalPluginBlocks, buttonsBlock];
	}, [externalPluginBlocks, t]);
	const pluginBlockTypes = React.useMemo(
		() => new Set(pluginBlocks.map((block) => block.type)),
		[pluginBlocks],
	);
	const pluginBlockTypesRef = React.useRef(pluginBlockTypes);
	pluginBlockTypesRef.current = pluginBlockTypes;

	// Build slash commands
	const slashCommands = React.useMemo(() => {
		// From the block insert button, insert at its position in the same undo step.
		const topLevelInsert = (
			item: SlashCommandItem,
			insert: typeof insertHtmlBlock,
		): SlashCommandItem => ({
			...item,
			deferInsertion: true,
			command: ({ editor, range }) => {
				const position = pendingBlockInsertPosRef.current?.position ?? null;
				pendingBlockInsertPosRef.current = null;
				if (position === null) insert(editor, range);
				else insert(editor, undefined, position);
			},
		});

		const cmds: SlashCommandItem[] = [...defaultSlashCommands];
		cmds.push(
			{
				id: "image",
				title: msg`Image`,
				description: msg`Insert an image`,
				icon: ImageIcon,
				aliases: ["img", "photo", "picture", "url"],
				category: MEDIA_CATEGORY,
				deferInsertion: true,
				command: ({ editor, range }) => {
					editor.chain().focus().deleteRange(range).run();
					setMediaPickerOpen(true);
				},
			},
			{
				id: "gallery",
				title: msg`Gallery`,
				description: msg`Insert an image gallery`,
				icon: Images,
				aliases: ["gal", "photos", "grid"],
				category: MEDIA_CATEGORY,
				deferInsertion: true,
				command: ({ editor, range }) => {
					editor.chain().focus().deleteRange(range).run();
					setGalleryPickerOpen(true);
				},
			},
		);
		// A plugin's own video block replaces the built-in one.
		if (!pluginBlockTypes.has("video")) {
			cmds.push({
				id: "video",
				title: msg`Video`,
				description: msg`Upload or choose a video`,
				icon: VideoCamera,
				aliases: ["movie", "clip", "mp4", "film"],
				category: MEDIA_CATEGORY,
				deferInsertion: true,
				command: ({ editor, range }) => {
					editor.chain().focus().deleteRange(range).run();
					setVideoPickerOpen(true);
				},
			});
		}
		cmds.push(topLevelInsert(htmlSlashCommand, insertHtmlBlock), {
			id: "section",
			title: msg`Section`,
			description: msg`Insert a reusable section`,
			icon: Stack,
			aliases: ["pattern", "block", "template"],
			category: ADVANCED_CATEGORY,
			deferInsertion: true,
			command: ({ editor, range }) => {
				editor.chain().focus().deleteRange(range).run();
				setSectionPickerOpen(true);
			},
		});
		// A plugin's own iframe block replaces the built-in one.
		if (!pluginBlockTypes.has("iframe")) {
			cmds.push(topLevelInsert(iframeSlashCommand, insertIframeBlock));
		}

		// Add plugin block commands (API labels/descriptions: plain strings, not msg-wrapped).
		// Plugins can supply a custom `category` (plain string) — falls back to "Embeds".
		for (const block of pluginBlocks) {
			cmds.push({
				id: `plugin-${block.pluginId}-${block.type}`,
				title: block.label,
				description: block.description ?? t(msg`Embed a ${block.label}`),
				icon: resolveIcon(block.icon),
				aliases: [block.type],
				category: block.category ?? EMBEDS_CATEGORY,
				deferInsertion: true,
				command: ({ editor, range }) => {
					editor.chain().focus().deleteRange(range).run();
					setPluginBlockModal(block);
				},
			});
		}

		return cmds;
	}, [pluginBlockTypes, pluginBlocks, t]);

	// Filter commands by query — accessed via ref so the Suggestion plugin
	// (created once) always sees the latest command list without needing
	// the extension to be recreated.
	const filterCommandsRef = React.useRef((_q: string): SlashCommandItem[] => []);
	filterCommandsRef.current = (query: string) => {
		const text = (label: MessageDescriptor | string) =>
			typeof label === "string" ? label : t(label);
		if (!query.trim()) {
			// The menu groups commands by category, so arrow keys must follow that order.
			const visible = slashCommands.filter((item) => !item.searchOnly);
			const categories = [
				...new Set(visible.map((item) => text(item.category ?? BASIC_BLOCKS_CATEGORY))),
			];
			const rank = (item: SlashCommandItem) =>
				categories.indexOf(text(item.category ?? BASIC_BLOCKS_CATEGORY));
			return visible.toSorted((a, b) => rank(a) - rank(b));
		}
		return slashCommands
			.map((item, order) => ({
				item,
				order,
				score: scoreSlashCommand(query, text(item.title), text(item.description), [
					...(item.aliases ?? []),
					...(item.markdown ? [item.markdown] : []),
				]),
			}))
			.filter((entry) => entry.score > 0)
			.toSorted((a, b) => b.score - a.score || a.order - b.order)
			.map((entry) => entry.item);
	};

	// Convert initial value to ProseMirror format
	// A room never holds content with marks the editor can't keep.
	const initialUnsupportedMarks = React.useMemo(
		() => (collaboration ? [] : findUnsupportedPortableTextMarks(value || [])),
		[],
	);
	const unsupportedMarks = React.useMemo(
		() => [...new Set([...initialUnsupportedMarks, ...conversionErrorMarks])].toSorted(),
		[conversionErrorMarks, initialUnsupportedMarks],
	);
	const initialConversion = React.useMemo(() => {
		const emptyDocument = { type: "doc" as const, content: [{ type: "paragraph" }] };
		if (collaboration || initialUnsupportedMarks.length > 0) {
			return { content: emptyDocument, tableError: null };
		}
		try {
			return {
				content: portableTextToProsemirror(value || [], pluginBlockTypes),
				tableError: null,
			};
		} catch (error) {
			if (error instanceof UnsafePortableTextTableError) {
				return { content: emptyDocument, tableError: error };
			}
			throw error;
		}
	}, []); // Only compute once on mount
	const initialContent = initialConversion.content;
	const tableConversionError = initialConversion.tableError ?? conversionTableError;

	/**
	 * Hands the document to `onChange` as Portable Text. While the slash line
	 * the block insert button typed is open, changes wait until its menu
	 * closes, so the line alone isn't an edit for autosave to save.
	 *
	 * Documents are compared rather than their Portable Text: stored content
	 * the converter would write in a different shape (empty `markDefs`, a
	 * missing `style`, fields it doesn't map) is unchanged until the document is.
	 */
	const reportChange = React.useCallback((changedEditor: Editor) => {
		const cb = onChangeRef.current;
		if (!cb || collaboration) return;
		if (insertedLineRef.current && SuggestionPluginKey.getState(changedEditor.state)?.active)
			return;
		lastReportedDocRef.current ??= changedEditor.schema.nodeFromJSON(initialContent);
		if (
			withoutTrailingEmptyParagraph(changedEditor.state.doc).eq(
				withoutTrailingEmptyParagraph(lastReportedDocRef.current),
			)
		)
			return;
		lastReportedDocRef.current = changedEditor.state.doc;
		const doc = changedEditor.getJSON();
		// TipTap's getJSON() returns JSONContent which is structurally compatible
		const pmDoc = doc as Parameters<typeof prosemirrorToPortableText>[0];
		try {
			const portableText = prosemirrorToPortableText(pmDoc);
			if (equalJsonValues(portableText, lastPortableTextValueRef.current)) return;
			lastPortableTextValueRef.current = portableText;
			cb(portableText);
		} catch (error) {
			if (error instanceof UnsupportedPortableTextMarksError) {
				setConversionErrorMarks(error.marks);
				return;
			}
			if (error instanceof UnsafePortableTextTableError) {
				setConversionTableError(error);
				return;
			}
			throw error;
		}
	}, []);

	// Memoize the entire extensions array so TipTap never diffs/replaces
	// plugins on re-render. The loop was: extension array changes → useEditor
	// calls setOptions → old Suggestion plugin destroyed → onExit fires
	// setSlashMenuState → re-render → new extension array → repeat.
	// All mutable state (filterCommands, onChange) is accessed via refs.
	const extensions = React.useMemo(
		() => [
			PortableTextIdentityExtension,
			PortableTextSpanIdentity,
			LinkBoundaryExit,
			collaboration ? EditorStarterKit.configure({ undoRedo: false }) : EditorStarterKit,
			TopBlockDocument,
			EmDashOrderedList,
			CodeMarkExtension,
			CodeBlockExtension,
			HtmlBlockExtension,
			IframeBlockExtension,
			VideoExtension,
			GalleryExtension,
			ImageExtension,
			ImageUploadExtension.configure({
				upload: (file, signal) => uploadImageRef.current(file, signal),
				// A plugin's own video block replaces the built-in one.
				acceptsVideo: () => !pluginBlockTypesRef.current.has("video"),
			}),
			MarkdownLinkExtension,
			PluginBlockExtension,
			SubscriptMark,
			SuperscriptMark,
			PortableTextTable,
			createTableResize(() => extensionAnnouncementRef.current()),
			EmDashTableRow,
			EmDashTableHeader,
			EmDashTableCell,
			TableIdentity,
			PortableTextNormalizers,
			PortableTextKeys,
			PortableTextYSync,
			PortableTextFilledDefaults,
			BlockFormatShortcuts,
			BlockSelection.configure({
				onArrowUpAtStart: () => {
					const handler = onArrowUpAtStartRef.current;
					if (!handler) return false;
					handler();
					return true;
				},
			}),
			BlockSelectAll,
			DoubleClickLineEnd,
			SelectionHighlights,
			createTableCellSafety(rejectTablePaste),
			createTableClipboard(rejectTablePaste, (rows, columns) =>
				extensionAnnouncementRef.current(rows, columns),
			),
			createTextBlockPlaceholder((props) => placeholderRef.current(props)),
			PortableTextTextAlign,
			createSlashCommandsExtension({
				filterCommands: (query: string) => filterCommandsRef.current(query),
				onStateChange: setSlashMenuState,
				getState: () => slashMenuStateRef.current,
				onCommand: (item) => slashMenuActionsRef.current.run(item),
				onDismiss: () => slashMenuActionsRef.current.dismiss(),
				onExit: (exitedEditor) => {
					if (insertedLineRef.current) reportChange(exitedEditor);
					insertedLineRef.current = null;
				},
			}),
			CharacterCount.configure({ wordCounter: countWords }),
			Focus.configure({
				className: "has-focus",
				mode: "all",
			}),
			Typography,
			...(collaboration?.extensions ?? []),
		],
		[], // Created once — all mutable state accessed via refs
	);

	const editorLabel = t`Rich text editor`;
	// Tiptap gives the editor a textbox role, so a read-only editor has to say so itself.
	const editableRef = React.useRef(true);
	// Stable editorProps reference — a new object every render would cause
	// compareOptions to call setOptions → updateState → plugin teardown →
	// Suggestion onExit → setSlashMenuState → re-render → infinite loop.
	const editorProps = React.useMemo(
		() => ({
			// Typing or moving the caret under the document's sticky toolbar, or the fade under
			// it, scrolls the caret out from under them.
			scrollThreshold: isDocument ? { top: 96, right: 0, bottom: 0, left: 0 } : 0,
			scrollMargin: isDocument ? { top: 96, right: 5, bottom: 5, left: 5 } : 5,
			attributes: (): Record<string, string> => ({
				"aria-label": editorLabel,
				...(ariaLabelledby ? { "aria-labelledby": ariaLabelledby } : {}),
				...(editableRef.current ? {} : { "aria-readonly": "true" }),
				class: isDocument
					? "emdash-document flow-root min-h-32 pb-2 focus:outline-none"
					: "prose prose-sm sm:prose-base dark:prose-invert flow-root w-full max-w-[calc(75ch+8rem)] mx-auto focus:outline-none min-h-[200px] p-4 ps-14 pe-14 sm:ps-16 sm:pe-16",
				dir: "auto",
			}),
		}),
		[ariaLabelledby, editorLabel, isDocument],
	);

	const editorEditable = editable && unsupportedMarks.length === 0 && tableConversionError === null;
	editableRef.current = editorEditable;
	const editor = useEditor({
		extensions,
		content: collaboration ? "" : (initialContent as Parameters<typeof useEditor>[0]["content"]),
		editable: editorEditable,
		immediatelyRender: true,
		editorProps,
		onUpdate: ({ editor: updatedEditor }) => reportChange(updatedEditor),
	});
	// useEditor reads its options once, so a later `editable` reaches the editor here, without the
	// update event that would report a change.
	React.useEffect(() => {
		if (editor && !editor.isDestroyed && editor.isEditable !== editorEditable) {
			editor.setEditable(editorEditable, false);
		}
	}, [editor, editorEditable]);

	/**
	 * Takes the line the block insert button typed back out, or only its slash
	 * from an empty line that was already there. While the line holds only the
	 * slash command and is still the last change in the undo history, the change
	 * is undone instead, so no undo step is left behind that does nothing.
	 */
	const removeInsertedLine = React.useCallback(
		(activeEditor: Editor, line: InsertedSlashLine, range: Range) => {
			const { state, view } = activeEditor;
			const dispatch = (tr: Transaction) => view.dispatch(tr);
			// Text typed after the caret moved back sits outside the range, and undoing would take it too.
			const onlyCommand =
				state.doc.resolve(range.from).parent.content.size === range.to - range.from;
			if (onlyCommand && historyDepth(state) === line.undoDepth && undoLastGroup(state, dispatch)) {
				return;
			}
			const removed = addedSlashParagraph(state.doc, range, line) ?? range;
			const tr = state.tr.delete(removed.from, removed.to).setMeta("addToHistory", false);
			dispatch(closeHistoryGroup(state, tr));
		},
		[],
	);

	/**
	 * Closes the menu without running a command, keeping what was typed. The
	 * line the block insert button typed goes again if nothing followed its
	 * slash.
	 */
	const closeSlashMenu = React.useCallback(() => {
		const { range } = slashMenuStateRef.current;
		const untouched =
			editor !== null &&
			range !== null &&
			insertedLineRef.current?.slash?.position === range.from &&
			editor.state.doc.textBetween(range.from, range.to) === "/" &&
			editor.state.doc.resolve(range.from).parent.content.size === 1;
		setSlashMenuState((prev) => ({
			...prev,
			isOpen: false,
			mode: "commands",
			dismissedSlashFrom: untouched || !range ? prev.dismissedSlashFrom : range.from,
		}));
		if (!editor || !range) return;
		if (!untouched) {
			exitSuggestion(editor.view);
			return;
		}
		removeInsertedLine(editor, insertedLineRef.current!, range);
	}, [editor, removeInsertedLine, setSlashMenuState]);

	/**
	 * The block insert button types a slash on a new line at `insertPos`, or
	 * into the empty paragraph just before it, which opens the slash menu there.
	 */
	const openBlockInsertMenuAt = React.useCallback(
		(insertPos: number) => {
			if (!editor) return;
			let pos = insertPos;
			if (slashMenuStateRef.current.isOpen) {
				let insert = editor.utils.createMappablePosition(insertPos);
				const follow = ({ transaction }: EditorEvents["transaction"]) => {
					insert = editor.utils.getUpdatedPosition(insert, transaction).position;
				};
				editor.on("transaction", follow);
				closeSlashMenu();
				editor.off("transaction", follow);
				pos = insert.position;
			}
			const { doc } = editor.state;
			if (pos < 0 || pos > doc.content.size || doc.resolve(pos).depth !== 0) return;
			const { nodeBefore, nodeAfter } = doc.resolve(pos);
			// An empty paragraph beside the insert point takes the slash instead of gaining a neighbour.
			const reuseBefore = isEmptyParagraph(nodeBefore);
			const reuse = reuseBefore || isEmptyParagraph(nodeAfter);
			const slashPos = reuseBefore ? pos - 1 : pos + 1;
			// A stale dismissed position could block this slash; opening a menu forgets it anyway.
			setSlashMenuState((prev) => ({ ...prev, dismissedSlashFrom: null }));
			const inserted: InsertedSlashLine = { slash: null, addedParagraph: !reuse, undoDepth: -1 };
			insertedLineRef.current = inserted;
			editor
				.chain()
				.focus()
				.command(({ state, tr }) => {
					closeHistoryGroup(state, tr);
					if (!reuse) tr.insert(pos, tr.doc.type.schema.nodes.paragraph!.create());
					tr.insertText("/", slashPos).setSelection(TextSelection.create(tr.doc, slashPos + 1));
					return true;
				})
				.run();
			// An upload that lands while the menu is open must not join the slash's undo step, which
			// dismissing the menu undoes.
			endHistoryGroup(editor.state);
			inserted.slash = editor.utils.createMappablePosition(slashPos);
			inserted.undoDepth = historyDepth(editor.state);
			// Scrolls far enough for the menu, up to 21rem tall, to open below the line, without
			// scrolling the line under the toolbar.
			const line = editor.view.coordsAtPos(slashPos);
			const scroller = scrollContainer(editor.view.dom);
			const viewBottom = Math.min(
				window.innerHeight,
				scroller?.getBoundingClientRect().bottom ?? Infinity,
			);
			const room = 23 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
			const distance = Math.min(line.bottom + room - viewBottom, line.top - getToolbarBottom() - 8);
			if (distance > 0) (scroller ?? window).scrollBy({ top: distance });
		},
		[closeSlashMenu, editor, getToolbarBottom, setSlashMenuState],
	);

	/**
	 * The range a slash command replaces. The slash the block insert button
	 * typed is cleared outside the undo history first, so undoing the command
	 * doesn't bring it back; undoing it again removes a line the button added.
	 * A picker inserts where the button's line was, so cancelling the picker
	 * leaves nothing behind.
	 */
	const takeSlashRange = React.useCallback(
		(activeEditor: Editor, range: Range, deferred: boolean): Range => {
			pendingBlockInsertPosRef.current = null;
			const line = insertedLineRef.current;
			const slash = line?.slash;
			if (!line || slash?.position !== range.from) return range;
			const paragraph = addedSlashParagraph(activeEditor.state.doc, range, line);
			if (paragraph && !deferred) {
				const { state } = activeEditor;
				const tr = state.tr.delete(range.from, range.to).setMeta("addToHistory", false);
				activeEditor.view.dispatch(closeHistoryGroup(state, tr));
			} else {
				removeInsertedLine(activeEditor, line, range);
				if (paragraph) {
					pendingBlockInsertPosRef.current = activeEditor.utils.createMappablePosition(
						paragraph.from,
					);
				} else {
					const { state } = activeEditor;
					activeEditor.view.dispatch(
						state.tr.setSelection(TextSelection.create(state.doc, slash.position)),
					);
				}
			}
			const caret = activeEditor.state.selection.from;
			return { from: caret, to: caret };
		},
		[removeInsertedLine],
	);

	const executeSlashCommand = React.useCallback(
		(item: SlashCommandItem) => {
			const { range } = slashMenuStateRef.current;
			if (!editor || !range) return;
			if (item.opensTablePicker) {
				setSlashMenuState((current) => ({ ...current, mode: "table-size", isOpen: true }));
				return;
			}
			item.command({ editor, range: takeSlashRange(editor, range, item.deferInsertion === true) });
			setSlashMenuState((prev) => ({ ...prev, isOpen: false, mode: "commands" }));
		},
		[editor, setSlashMenuState, takeSlashRange],
	);
	slashMenuActionsRef.current = { run: executeSlashCommand, dismiss: closeSlashMenu };

	const handleTouchInsertBlock = React.useCallback(() => {
		if (!editor) return;
		const { $from } = editor.state.selection;
		const topLevelPos = $from.depth > 0 ? $from.before(1) : $from.pos;
		const topLevelNode = editor.state.doc.nodeAt(topLevelPos);
		openBlockInsertMenuAt(
			topLevelNode ? topLevelPos + topLevelNode.nodeSize : editor.state.doc.content.size,
		);
	}, [editor, openBlockInsertMenuAt]);

	// Notify when editor is ready, and on unmount so consumers can clear the
	// reference before TipTap destroys the instance (e.g. when keying by item.id
	// to switch translations).
	React.useEffect(() => {
		if (editor && onEditorReady && unsupportedMarks.length === 0 && tableConversionError === null) {
			onEditorReady(editor);
			return () => {
				onEditorReady(null);
			};
		}
		return undefined;
	}, [editor, onEditorReady, tableConversionError, unsupportedMarks.length]);

	React.useEffect(() => {
		const viewport = window.visualViewport;
		if (!editor || !viewport) return;

		let frame = 0;
		const updateBubbleMenuPositions = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				if (editor.isDestroyed) return;
				editor.view.dispatch(
					editor.state.tr
						.setMeta(INLINE_BUBBLE_MENU_KEY, "updatePosition")
						.setMeta(TABLE_BUBBLE_MENU_KEY, "updatePosition")
						.setMeta(IMAGE_BUBBLE_MENU_KEY, "updatePosition")
						.setMeta(LINK_BUBBLE_MENU_KEY, "updatePosition"),
				);
			});
		};
		// The bubble menus only follow the window's scroll, so they'd stay put over the
		// sticky toolbar when the container around the editor scrolls instead.
		const updateOnContainerScroll = (event: Event) => {
			if (!(event.target instanceof Node) || !event.target.contains(editor.view.dom)) return;
			const root = editor.view.dom.closest("[data-emdash-editor-floating-root]");
			if (root?.querySelector(BUBBLE_MENU_SELECTOR)) updateBubbleMenuPositions();
		};

		viewport.addEventListener("resize", updateBubbleMenuPositions);
		viewport.addEventListener("scroll", updateBubbleMenuPositions);
		document.addEventListener("scroll", updateOnContainerScroll, { capture: true, passive: true });
		return () => {
			cancelAnimationFrame(frame);
			viewport.removeEventListener("resize", updateBubbleMenuPositions);
			viewport.removeEventListener("scroll", updateBubbleMenuPositions);
			document.removeEventListener("scroll", updateOnContainerScroll, { capture: true });
		};
	}, [editor]);

	// Register plugin blocks into editor storage so the node view can look up metadata
	React.useEffect(() => {
		if (editor) {
			registerPluginBlocks(
				editor as unknown as { storage: Record<string, Record<string, unknown>> },
				pluginBlocks,
			);
		}
	}, [editor, pluginBlocks]);

	// Wire up the onEditBlock callback so the node view can open the Block Kit modal
	React.useEffect(() => {
		if (!editor) return;
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>)
			.pluginBlock;
		if (!storage) return;
		storage.onEditBlock = (attrs: {
			blockType: string;
			id: string;
			data: Record<string, unknown>;
			pos: number;
		}) => {
			const blockDef = pluginBlocks.find((b) => b.type === attrs.blockType);
			if (!blockDef) return;
			const block = editedPluginBlockAt(editor, attrs.pos);
			if (block === null) return;
			editingBlockRef.current = block;
			const data =
				blockDef.pluginId === BUILTIN_BLOCKS_PLUGIN_ID && blockDef.type === "buttons"
					? { ...attrs.data, buttons: withButtonKeyField(attrs.data.buttons) }
					: attrs.data;
			setPluginBlockInitialValues({ id: attrs.id, ...data });
			setPluginBlockModal(blockDef);
		};
		return () => {
			storage.onEditBlock = null;
		};
	}, [editor, pluginBlocks]);

	// Wire up block sidebar callbacks so node views (e.g. ImageNode) can request sidebar space
	const onBlockSidebarOpenRef = React.useRef(onBlockSidebarOpen);
	onBlockSidebarOpenRef.current = onBlockSidebarOpen;
	const onBlockSidebarCloseRef = React.useRef(onBlockSidebarClose);
	onBlockSidebarCloseRef.current = onBlockSidebarClose;

	React.useEffect(() => {
		if (!editor) return;
		const editorStorage = editor.storage as unknown as Record<string, Record<string, unknown>>;
		// Both node types share the same sidebar plumbing
		const storages = [editorStorage.image, editorStorage.gallery].filter(
			(storage): storage is Record<string, unknown> => storage !== undefined,
		);
		for (const storage of storages) {
			storage.onOpenBlockSidebar = (panel: BlockSidebarPanel) => {
				onBlockSidebarOpenRef.current?.(panel);
			};
			storage.onCloseBlockSidebar = () => {
				onBlockSidebarCloseRef.current?.();
			};
		}
		return () => {
			for (const storage of storages) {
				storage.onOpenBlockSidebar = null;
				storage.onCloseBlockSidebar = null;
			}
		};
	}, [editor]);

	// A picker can stay open while an upload lands, so the insert position follows the document.
	React.useEffect(() => {
		if (!editor) return;
		const follow = ({ transaction, appendedTransactions }: EditorEvents["transaction"]) => {
			let position = pendingBlockInsertPosRef.current;
			if (position === null) return;
			for (const tr of [transaction, ...appendedTransactions]) {
				const updated = editor.utils.getUpdatedPosition(position, tr);
				// A block added right at the position stays after the one the picker inserts there.
				if (updated.mapResult) updated.position.position = tr.mapping.map(position.position, -1);
				position = updated.position;
			}
			pendingBlockInsertPosRef.current = position;
		};
		editor.on("transaction", follow);
		return () => {
			editor.off("transaction", follow);
		};
	}, [editor]);

	// The insert button's slash follows the document, which other clients change while its menu is open.
	React.useEffect(() => {
		if (!editor) return;
		const follow = (event: EditorEvents["transaction"]) => {
			const line = insertedLineRef.current;
			if (line?.slash) line.slash = positionAfter(editor, line.slash, event);
		};
		editor.on("transaction", follow);
		return () => {
			editor.off("transaction", follow);
		};
	}, [editor]);

	// The plugin block modal finds a block with no key by position, so it follows the document too.
	React.useEffect(() => {
		if (!editor) return;
		const follow = ({ transaction, appendedTransactions }: EditorEvents["transaction"]) => {
			const block = editingBlockRef.current;
			if (!block || !("position" in block) || block.position === null) return;
			let position: MappablePosition | null = block.position;
			let remote = false;
			for (const tr of [transaction, ...appendedTransactions]) {
				if (position === null) break;
				const { position: next, mapResult } = editor.utils.getUpdatedPosition(position, tr);
				position = mapResult?.deleted ? null : next;
				remote ||= mapResult === null;
			}
			if (remote && position !== null) position = refindPluginBlock(editor, block, position);
			editingBlockRef.current = { ...block, position };
		};
		editor.on("transaction", follow);
		return () => {
			editor.off("transaction", follow);
		};
	}, [editor]);

	// Handle image selection from media picker
	const handleImageSelect = React.useCallback(
		(item: MediaItem) => {
			if (editor) {
				const attrs = mediaItemToImageAttrs(item);
				const insertPos = pendingBlockInsertPosRef.current?.position ?? null;
				const chain = editor.chain().focus();
				if (insertPos === null) {
					chain
						.command(({ tr }) => prepareBlockInsert(tr))
						.setImage(attrs)
						.scrollIntoView()
						.run();
				} else {
					chain.insertContentAt(insertPos, { type: "image", attrs }).run();
				}
			}
			pendingBlockInsertPosRef.current = null;
			setMediaPickerOpen(false);
		},
		[editor],
	);

	const handleVideoSelect = React.useCallback(
		(item: MediaItem) => {
			if (editor?.isEditable) {
				const video = editor.schema.nodes.videoBlock!.create(mediaItemToVideoAttrs(item));
				const position = pendingBlockInsertPosRef.current?.position;
				insertTopLevelBlock(editor, video, undefined, position);
				editor.view.focus();
			}
			pendingBlockInsertPosRef.current = null;
			setVideoPickerOpen(false);
		},
		[editor],
	);

	// Handle gallery insertion from the multi-select media picker
	const handleGallerySelect = React.useCallback(
		(items: MediaItem[]) => {
			if (editor && items.length > 0) {
				const attrs = { images: items.map(mediaItemToGalleryImage), columns: 3 };
				const insertPos = pendingBlockInsertPosRef.current?.position ?? null;
				const chain = editor.chain().focus();
				if (insertPos === null) {
					chain
						.command(({ tr }) => prepareBlockInsert(tr))
						.setGallery(attrs)
						.scrollIntoView()
						.run();
				} else {
					chain.insertContentAt(insertPos, { type: "gallery", attrs }).run();
				}
			}
			pendingBlockInsertPosRef.current = null;
			setGalleryPickerOpen(false);
		},
		[editor],
	);

	// Handle plugin block insertion or update
	const handlePluginBlockInsert = React.useCallback(
		(values: Record<string, unknown>): MessageDescriptor | undefined => {
			if (!editor || !pluginBlockModal) return undefined;

			const { id: formId, ...fieldData } = values;
			const isBuiltinButtons =
				pluginBlockModal.pluginId === BUILTIN_BLOCKS_PLUGIN_ID &&
				pluginBlockModal.type === "buttons";
			// A buttons group has no URL of its own; an older editor could store one here.
			const id = isBuiltinButtons ? "" : formId;
			const data = isBuiltinButtons
				? { ...fieldData, buttons: normalizeButtonItems(fieldData.buttons) }
				: fieldData;
			const editing = editingBlockRef.current;

			if (editing !== null) {
				// Editing an existing block — update its attributes in place.
				// Use the chain API so TipTap's onUpdate fires reliably
				// (raw view.dispatch may not trigger onUpdate for attribute-only
				// changes on atom nodes in some TipTap versions).
				const edited = editor
					.chain()
					.command(({ tr }) => {
						const block = findPluginBlock(tr.doc, editing);
						if (!block) return false;
						tr.setNodeMarkup(block.pos, undefined, {
							...block.node.attrs,
							[PORTABLE_TEXT_KEY_ATTR]: block.node.attrs[PORTABLE_TEXT_KEY_ATTR] || generateKey(),
							id: typeof id === "string" ? id : block.node.attrs.id,
							data,
						});
						return true;
					})
					.run();
				if (!edited) return msg`This block was deleted, so your changes can't be saved.`;
			} else {
				// Inserting a new block
				const content = {
					type: "pluginBlock",
					attrs: {
						blockType: pluginBlockModal.type,
						id: typeof id === "string" ? id : "",
						data,
					},
				};
				const insertPos = pendingBlockInsertPosRef.current?.position ?? null;
				const chain = editor.chain().focus();
				if (insertPos === null) {
					chain
						.command(({ tr }) => prepareBlockInsert(tr))
						.insertContent(content)
						.scrollIntoView()
						.run();
				} else {
					chain.insertContentAt(insertPos, content).run();
				}
			}

			pendingBlockInsertPosRef.current = null;
			setPluginBlockModal(null);
			setPluginBlockInitialValues(undefined);
			editingBlockRef.current = null;
			return undefined;
		},
		[editor, pluginBlockModal],
	);

	React.useEffect(() => {
		if (editable || !editor || slashMenuStateRef.current.mode !== "table-size") return;
		exitSuggestion(editor.view);
		queueMicrotask(() =>
			setSlashMenuState((current) => ({
				...current,
				isOpen: false,
				mode: "commands",
			})),
		);
	}, [editable, editor, setSlashMenuState]);
	const handleSlashTableInsert = React.useCallback(
		(rows: number, columns: number, withHeaderRow: boolean) => {
			const { range } = slashMenuStateRef.current;
			if (!editor?.isEditable) return;
			const inserted = insertEditorTable(
				editor,
				rows,
				columns,
				withHeaderRow,
				range ? takeSlashRange(editor, range, false) : undefined,
			);
			if (!inserted) return;
			exitSuggestion(editor.view);
			// The picker's focused cell goes away with the menu.
			editor.view.focus();
			setSlashMenuState((current) => ({
				...current,
				isOpen: false,
				mode: "commands",
				dismissedSlashFrom: null,
			}));
			announceTable(t`Table inserted`);
		},
		[announceTable, editor, setSlashMenuState, t, takeSlashRange],
	);
	const handleSlashTableCancel = React.useCallback(() => {
		closeSlashMenu();
		editor?.view.focus();
	}, [closeSlashMenu, editor]);

	// Handle section selection - insert section content at cursor
	const handleSectionSelect = React.useCallback(
		(section: Section) => {
			if (!editor || !section.content || section.content.length === 0) return;

			// Convert Portable Text to ProseMirror format
			const ptContent = Array.isArray(section.content)
				? (section.content as PortableTextBlock[])
				: [];
			let prosemirrorContent: unknown[];
			try {
				prosemirrorContent = withoutTrailingParagraph(
					portableTextToProsemirror(ptContent, pluginBlockTypes),
				);
			} catch (error) {
				if (error instanceof UnsupportedPortableTextMarksError) {
					setSectionInsertErrorMarks(error.marks);
					setSectionInsertTableError(false);
					return;
				}
				if (error instanceof UnsafePortableTextTableError) {
					setSectionInsertErrorMarks([]);
					setSectionInsertTableError(true);
					return;
				}
				throw error;
			}
			setSectionInsertErrorMarks([]);
			setSectionInsertTableError(false);

			const insertPos = pendingBlockInsertPosRef.current?.position ?? null;
			const chain = editor.chain().focus();
			if (insertPos === null) {
				chain
					.command(({ tr }) => prepareBlockInsert(tr))
					.insertContent(prosemirrorContent)
					.scrollIntoView()
					.run();
			} else {
				chain.insertContentAt(insertPos, prosemirrorContent).run();
			}
			pendingBlockInsertPosRef.current = null;
		},
		[editor, pluginBlockTypes],
	);

	if (tableConversionError) {
		return (
			<div
				role="alert"
				className={cn(
					className,
					"rounded-lg border border-kumo-error bg-kumo-error/10 p-4 text-start",
				)}
				aria-labelledby={ariaLabelledby}
			>
				<p className="font-medium text-kumo-error">{t`This table cannot be edited safely`}</p>
				<p className="mt-1 text-sm text-kumo-subtle">
					{t`This field contains table content that the editor cannot preserve. Update it through the API before editing or saving this content.`}
				</p>
			</div>
		);
	}

	if (unsupportedMarks.length > 0) {
		const markList = unsupportedMarks.join(", ");
		return (
			<div
				role="alert"
				className={cn(
					className,
					"rounded-lg border border-kumo-error bg-kumo-error/10 p-4 text-start",
				)}
				aria-labelledby={ariaLabelledby}
			>
				<p className="font-medium text-kumo-error">{t`This content cannot be edited safely`}</p>
				<p className="mt-1 text-sm text-kumo-subtle">
					<Trans>
						This field contains unsupported Portable Text marks: <code dir="auto">{markList}</code>.
						Remove them through the API before editing or saving this content.
					</Trans>
				</p>
			</div>
		);
	}

	if (!editor) {
		return (
			<div className={cn("border rounded-lg", className)}>
				<div className="p-4 text-kumo-subtle">{t`Loading editor...`}</div>
			</div>
		);
	}

	const tablePasteErrorMessage =
		tablePasteError?.reason === "too-large"
			? t`This paste is too large. Paste fewer cells or less text at a time.`
			: tablePasteError?.reason === "invalid-tsv"
				? t`This spreadsheet data has invalid quoted cells. Fix the quotes or remove the tab separators and try again.`
				: tablePasteError?.reason === "table-must-be-top-level"
					? t`Tables cannot be pasted inside lists or quotes. Paste the table into its own paragraph and try again.`
					: tablePasteError?.reason === "invalid-table"
						? t`This table has unsupported cell formatting, merged cells, or column widths. Paste it as plain text or simplify the table and try again.`
						: t`Table cells accept text, links, and formatting only.`;

	return (
		<div
			ref={floatingRootRef}
			className="group/editor relative min-w-0"
			data-emdash-editor-floating-root
		>
			<div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
				{tableAnnouncement && <span key={tableAnnouncement.id}>{tableAnnouncement.text}</span>}
			</div>
			{tablePasteError && (
				<div
					key={tablePasteError.id}
					role="alert"
					className="mb-3 flex items-start justify-between gap-4 rounded-lg border border-kumo-error bg-kumo-error/10 p-4 text-start"
				>
					<p className="text-sm font-medium text-kumo-error">{tablePasteErrorMessage}</p>
					<Button
						type="button"
						variant="ghost"
						shape="square"
						onClick={() => setTablePasteError(null)}
						aria-label={t`Dismiss table paste error`}
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			)}
			{(sectionInsertErrorMarks.length > 0 || sectionInsertTableError) && (
				<div
					role="alert"
					className="mb-3 flex items-start justify-between gap-4 rounded-lg border border-kumo-error bg-kumo-error/10 p-4 text-start"
				>
					<div className="min-w-0">
						<p className="font-medium text-kumo-error">{t`Could not insert section`}</p>
						<p className="mt-1 text-sm text-kumo-subtle">
							{sectionInsertTableError ? (
								t`This section contains table content that the editor cannot preserve. Update the section before inserting it.`
							) : (
								<Trans>
									This section contains unsupported Portable Text marks:{" "}
									<code dir="auto">{sectionInsertErrorMarks.join(", ")}</code>. Update the section
									before inserting it.
								</Trans>
							)}
						</p>
					</div>
					<Button
						type="button"
						variant="ghost"
						shape="square"
						onClick={() => {
							setSectionInsertErrorMarks([]);
							setSectionInsertTableError(false);
						}}
						aria-label={t`Dismiss section error`}
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			)}
			<EditorBubbleMenu
				editor={editor}
				appendTo={appendBubbleMenu}
				getCollisionOptions={getBubbleMenuCollisionOptions}
			/>
			<ImageBubbleMenu
				editor={editor}
				appendTo={appendBubbleMenu}
				getCollisionOptions={getBubbleMenuCollisionOptions}
				canOpenSettings={Boolean(onBlockSidebarOpen)}
			/>
			{!minimal && (
				<TableBubbleMenu
					editor={editor}
					editable={editable}
					appendTo={appendBubbleMenu}
					getCollisionOptions={getBubbleMenuCollisionOptions}
					onRun={announceTable}
				/>
			)}
			<TableSelectionAnnouncer editor={editor} onChange={announceTable} />
			<div
				className={cn(
					isDocument ? "relative" : "border rounded-lg overflow-clip",
					!minimal && !isDocument && "bg-kumo-base",
					minimal && "border-0 rounded-none",
					focusMode === "spotlight" && "spotlight-mode",
					className,
				)}
				aria-labelledby={ariaLabelledby}
				data-emdash-editor-surface
				data-emdash-editor-variant={variant}
			>
				{!minimal && (
					<EditorToolbar
						toolbarRef={toolbarRef}
						editor={editor}
						editable={editable}
						onInsertBlock={handleTouchInsertBlock}
						onInsertImage={openToolbarImagePicker}
						onTableAction={announceTable}
						variant={variant}
					/>
				)}
				<div
					className="relative overflow-visible"
					// CSS `content` takes the slash menu's hint as a quoted string.
					style={
						{ "--emdash-slash-hint": JSON.stringify(t`Type to search`) } as React.CSSProperties
					}
				>
					<EditorContent editor={editor} />
					{dragHandleMounted && (
						<DragHandleWrapper
							editor={editor}
							onInsertBlock={openBlockInsertMenuAt}
							editable={editable}
						/>
					)}
				</div>
				{isDocument ? (
					<DocumentEnd editor={editor} editable={editable}>
						{!minimal && <EditorFooter editor={editor} variant={variant} />}
					</DocumentEnd>
				) : (
					!minimal && <EditorFooter editor={editor} variant={variant} />
				)}

				{/* Slash command menu */}
				{editable && (
					<SlashCommandMenu
						state={slashMenuState}
						contextElement={editor.isInitialized ? editor.view.dom : undefined}
						getToolbarBottom={getToolbarBottom}
						onCommand={executeSlashCommand}
						onClose={closeSlashMenu}
						onTableInsert={handleSlashTableInsert}
						onTableCancel={handleSlashTableCancel}
						setSelectedIndex={(index) =>
							setSlashMenuState((prev) => ({ ...prev, selectedIndex: index }))
						}
					/>
				)}

				{/* Media picker for image insertion */}
				<MediaPickerModal
					open={mediaPickerOpen}
					onOpenChange={(open) => {
						setMediaPickerOpen(open);
						if (!open) pendingBlockInsertPosRef.current = null;
					}}
					onSelect={handleImageSelect}
					mimeTypeFilter="image/"
					title={t`Select image`}
					confirmLabel={t`Insert image`}
				/>

				<MediaPickerModal
					open={videoPickerOpen}
					onOpenChange={(open) => {
						setVideoPickerOpen(open);
						if (!open) pendingBlockInsertPosRef.current = null;
					}}
					onSelect={handleVideoSelect}
					mimeTypeFilter="video/"
					mediaKind="video"
					localOnly
					title={t`Select video`}
					confirmLabel={t`Insert video`}
				/>

				{/* Multi-select media picker for gallery insertion */}
				<MediaPickerModal
					open={galleryPickerOpen}
					onOpenChange={(open) => {
						setGalleryPickerOpen(open);
						if (!open) pendingBlockInsertPosRef.current = null;
					}}
					multiple
					onSelect={() => {}}
					onSelectMany={handleGallerySelect}
					mimeTypeFilter="image/"
					title={t`Select gallery images`}
				/>

				{/* Plugin block insertion/editing modal */}
				<PluginBlockModal
					block={pluginBlockModal}
					initialValues={pluginBlockInitialValues}
					onClose={() => {
						pendingBlockInsertPosRef.current = null;
						setPluginBlockModal(null);
						setPluginBlockInitialValues(undefined);
						editingBlockRef.current = null;
					}}
					onInsert={handlePluginBlockInsert}
				/>

				{/* Section picker modal */}
				<SectionPickerModal
					open={sectionPickerOpen}
					onOpenChange={(open) => {
						setSectionPickerOpen(open);
						if (!open) pendingBlockInsertPosRef.current = null;
					}}
					onSelect={handleSectionSelect}
				/>
			</div>
		</div>
	);
}

/** The editor's floating toolbars, which are only in the page while they show. */
const BUBBLE_MENU_SELECTOR = [
	"[data-emdash-inline-bubble-menu]",
	"[data-emdash-link-bubble-menu]",
	"[data-emdash-table-bubble-menu]",
	"[data-emdash-image-bubble-menu]",
].join(", ");

/** Popups opened from the selection toolbar keep it visible while they have focus. */
const BUBBLE_POPUP_ATTR = "data-emdash-bubble-popup";

/** A boundary no selection falls outside of. */
const UNBOUNDED_RECT = { x: -1e6, y: -1e6, width: 2e6, height: 2e6 };

/**
 * Options for floating-ui's hide check: a floating toolbar hides while its
 * selection is under the sticky toolbar, and stays while it, or a menu or
 * field opened from it, has focus, so typing there isn't lost. No padding,
 * so a caret near the screen's edge doesn't count as hidden.
 */
function hideUnderToolbar(getCollisionOptions: BubbleMenuCollisionOptions) {
	return () => ({
		rootBoundary: document.activeElement?.closest(
			`${BUBBLE_MENU_SELECTOR}, [role="menu"], [${BUBBLE_POPUP_ATTR}]`,
		)
			? UNBOUNDED_RECT
			: getCollisionOptions().rootBoundary,
		padding: 0,
	});
}

const INLINE_MARKS = [
	{ mark: "bold", label: msg`Bold`, icon: TextB },
	{ mark: "italic", label: msg`Italic`, icon: TextItalic },
	{ mark: "underline", label: msg`Underline`, icon: TextUnderline },
	{ mark: "strike", label: msg`Strikethrough`, icon: TextStrikethrough },
	{ mark: "code", label: msg`Inline Code`, icon: Code },
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

function playBubbleEntrance(surface: HTMLElement | null) {
	if (!(surface instanceof HTMLElement) || typeof surface.animate !== "function") return;
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	surface.animate(
		reduceMotion
			? [{ opacity: 0 }, { opacity: 1 }]
			: [
					{ opacity: 0, transform: "translateY(2px) scale(0.98)" },
					{ opacity: 1, transform: "none" },
				],
		{ duration: 120, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
	);
}

/**
 * Bubble Menu - appears when text is selected.
 * Turn into, link, inline marks, and a menu for less common formatting.
 */
function EditorBubbleMenu({
	editor,
	appendTo,
	getCollisionOptions,
}: {
	editor: Editor;
	appendTo: () => HTMLElement;
	getCollisionOptions: BubbleMenuCollisionOptions;
}) {
	const [showLinkInput, setShowLinkInput] = React.useState(false);
	const [linkUrl, setLinkUrl] = React.useState("");
	const [linkInvalid, setLinkInvalid] = React.useState(false);
	const [openMenu, setOpenMenu] = React.useState<"turnInto" | "more" | null>(null);
	// Opening one menu closes the other, whose close then mustn't undo the open.
	const toggleMenu = (menu: "turnInto" | "more", open: boolean) =>
		setOpenMenu((current) => (open ? menu : current === menu ? null : current));
	const menuRef = React.useRef<HTMLDivElement>(null);
	const surfaceRef = React.useRef<HTMLDivElement>(null);
	const { t } = useLingui();
	const state = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => ({
			bold: activeEditor.isActive("bold"),
			italic: activeEditor.isActive("italic"),
			underline: activeEditor.isActive("underline"),
			strike: activeEditor.isActive("strike"),
			subscript: activeEditor.isActive("subscript"),
			superscript: activeEditor.isActive("superscript"),
			code: activeEditor.isActive("code"),
			link: activeEditor.isActive("link"),
			canTurnInto: canTurnInto(activeEditor),
			blockType: activeTextBlockType(activeEditor)?.id,
		}),
	});
	// When bubble menu opens with link input, populate the URL
	React.useEffect(() => {
		if (showLinkInput) {
			setLinkUrl(editor.getAttributes("link").href || "");
		}
	}, [showLinkInput, editor]);

	const closeLinkInput = () => {
		setShowLinkInput(false);
		setLinkUrl("");
		setLinkInvalid(false);
	};
	// The error makes the toolbar taller, so it moves to keep the selection in view.
	React.useEffect(() => {
		if (editor.isDestroyed) return;
		editor.view.dispatch(editor.state.tr.setMeta(INLINE_BUBBLE_MENU_KEY, "updatePosition"));
	}, [editor, linkInvalid]);
	const showLinkInputRef = React.useRef(showLinkInput);
	showLinkInputRef.current = showLinkInput;
	const closeLinkInputRef = React.useRef(closeLinkInput);
	closeLinkInputRef.current = closeLinkInput;

	// A URL the editor won't link keeps the field open, saying why.
	const handleSetLink = () => {
		if (linkUrl.trim() === "") {
			editor
				.chain()
				.focus()
				.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
				.unsetLink()
				.run();
		} else if (!setSelectedTextLink(editor, linkUrl)) {
			setLinkInvalid(true);
			return;
		}
		closeLinkInput();
	};

	const applyLinkHref = (href: string) => {
		if (setSelectedTextLink(editor, href)) closeLinkInput();
		else setLinkInvalid(true);
	};

	const handleRemoveLink = () => {
		editor
			.chain()
			.focus()
			.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
			.unsetLink()
			.run();
		closeLinkInput();
	};

	const options = React.useMemo(
		() => ({
			strategy: "absolute" as const,
			placement: "top-start" as const,
			offset: 8,
			flip: getCollisionOptions,
			shift: getCollisionOptions,
			hide: hideUnderToolbar(getCollisionOptions),
			size: () => ({
				...getCollisionOptions(),
				apply: ({
					availableWidth,
					elements,
				}: {
					availableWidth: number;
					elements: { floating: HTMLElement };
				}) => {
					elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
					// The surface scrolls itself, so no wrapper clips its rounded ring.
					const surface = surfaceRef.current;
					if (surface instanceof HTMLElement) {
						surface.style.maxWidth = "100%";
						surface.style.overflowX = "auto";
					}
				},
			}),
			onShow: () => {
				playBubbleEntrance(surfaceRef.current);
				// Edit link opens the field while this menu is still hidden, too early to focus it.
				if (showLinkInputRef.current) menuRef.current?.querySelector("input")?.focus();
			},
			// A link edit left open doesn't carry over to the next selection.
			onHide: () => {
				if (showLinkInputRef.current) closeLinkInputRef.current();
			},
		}),
		[getCollisionOptions],
	);

	return (
		<>
			<LinkBubbleMenu
				editor={editor}
				appendTo={appendTo}
				getCollisionOptions={getCollisionOptions}
				onEdit={() => {
					editor.chain().focus().extendMarkRange("link", linkAtCaret(editor.state)?.attrs).run();
					setShowLinkInput(true);
				}}
			/>
			<BubbleMenu
				ref={menuRef}
				editor={editor}
				pluginKey={INLINE_BUBBLE_MENU_KEY}
				appendTo={appendTo}
				updateDelay={120}
				options={options}
				shouldShow={({ editor: activeEditor, element, state: editorState, view }) => {
					const { selection } = editorState;
					const activeElement = document.activeElement;
					const hasMenuFocus =
						element.contains(activeElement) ||
						Boolean(activeElement?.closest(`[${BUBBLE_POPUP_ATTR}]`));
					return (
						activeEditor.isEditable &&
						(selection instanceof TextSelection || selection instanceof AllSelection) &&
						// A selection of only line breaks or spaces has nothing to format.
						NON_WHITESPACE_REGEX.test(
							editorState.doc.textBetween(selection.from, selection.to, " "),
						) &&
						!activeEditor.isActive("codeBlock") &&
						(view.hasFocus() || hasMenuFocus)
					);
				}}
			>
				<div
					ref={surfaceRef}
					data-emdash-inline-bubble-menu
					role="toolbar"
					aria-label={t`Format selection`}
					className={bubbleMenuClassName}
					onKeyDown={(event) => moveToolbarFocus(event, false)}
				>
					<TooltipProvider delay={400}>
						{showLinkInput ? (
							<div className="flex min-w-0 items-start gap-1">
								<LinkDestinationInput
									className="w-72 min-w-0 shrink"
									value={linkUrl}
									onValueChange={(value) => {
										setLinkUrl(value);
										setLinkInvalid(false);
									}}
									invalid={linkInvalid}
									onSubmit={handleSetLink}
									onPick={applyLinkHref}
									onEscape={() => {
										closeLinkInput();
										editor.commands.focus();
									}}
								/>
								<BubbleButton onClick={handleSetLink} title={t`Apply link`}>
									<Check className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
								{state.link && (
									<BubbleButton onClick={handleRemoveLink} title={t`Remove link`}>
										<LinkBreak className="h-4 w-4" aria-hidden="true" />
									</BubbleButton>
								)}
							</div>
						) : (
							// Scrolls with the fixed toolbar's edge fade when a narrow screen cuts it off.
							<div className="emdash-editor-toolbar -m-1 flex min-w-0 scroll-px-1 items-center gap-0.5 overflow-x-auto rounded-[inherit] p-1">
								{state.canTurnInto && (
									<>
										<TurnIntoMenu
											editor={editor}
											activeId={state.blockType}
											open={openMenu === "turnInto"}
											onOpenChange={(open) => toggleMenu("turnInto", open)}
										/>
										<BubbleSeparator />
									</>
								)}
								<BubbleButton
									onClick={() => setShowLinkInput(true)}
									active={state.link}
									title={state.link ? t`Edit link` : t`Add link`}
								>
									<LinkIcon className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
								<BubbleSeparator />
								{INLINE_MARKS.map(({ mark, label, icon: MarkIcon }) => (
									<BubbleButton
										key={mark}
										onClick={() => editor.chain().focus().toggleMark(mark).run()}
										active={state[mark]}
										title={t(label)}
									>
										<MarkIcon className="h-4 w-4" aria-hidden="true" />
									</BubbleButton>
								))}
								<BubbleSeparator />
								<MoreFormattingMenu
									editor={editor}
									subscript={state.subscript}
									superscript={state.superscript}
									open={openMenu === "more"}
									onOpenChange={(open) => toggleMenu("more", open)}
								/>
							</div>
						)}
					</TooltipProvider>
				</div>
			</BubbleMenu>
		</>
	);
}

const SAFE_LINK_HREF_REGEX = /^(?:https?:|mailto:|tel:|\/|#)/i;
const LINK_DISPLAY_PREFIX_REGEX = /^https?:\/\/(?:www\.)?/i;

/** Shows where a link goes, with edit and remove, whenever the caret sits inside it. */
function LinkBubbleMenu({
	editor,
	appendTo,
	getCollisionOptions,
	onEdit,
}: {
	editor: Editor;
	appendTo: () => HTMLElement;
	getCollisionOptions: BubbleMenuCollisionOptions;
	onEdit: () => void;
}) {
	const { t } = useLingui();
	const href = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => {
			const value: unknown = linkAtCaret(activeEditor.state)?.attrs.href;
			return typeof value === "string" ? value : "";
		},
	});
	const options = React.useMemo(
		() => ({
			strategy: "absolute" as const,
			placement: "bottom-start" as const,
			offset: 6,
			flip: getCollisionOptions,
			shift: getCollisionOptions,
			hide: hideUnderToolbar(getCollisionOptions),
		}),
		[getCollisionOptions],
	);
	const openable = SAFE_LINK_HREF_REGEX.test(href);
	return (
		<BubbleMenu
			editor={editor}
			pluginKey={LINK_BUBBLE_MENU_KEY}
			appendTo={appendTo}
			updateDelay={0}
			options={options}
			shouldShow={({ editor: activeEditor, element, state: editorState, oldState, view }) =>
				activeEditor.isEditable &&
				editorState.selection instanceof TextSelection &&
				editorState.selection.empty &&
				linkAtCaret(editorState) !== undefined &&
				// At a link's edge, typing goes beside the link, so the preview gets out of the way.
				(activeEditor.isActive("link") || !oldState || oldState.doc.eq(editorState.doc)) &&
				(view.hasFocus() || element.contains(document.activeElement))
			}
		>
			<div
				data-emdash-link-bubble-menu
				role="toolbar"
				aria-label={t`Link options`}
				className={cn(bubbleMenuClassName, "max-w-[min(28rem,calc(100vw-1rem))]")}
				onKeyDown={(event) => moveToolbarFocus(event, false)}
			>
				<TooltipProvider delay={400}>
					<Globe className="ms-1.5 size-4 flex-none text-kumo-subtle" aria-hidden="true" />
					{openable ? (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							dir="auto"
							className="min-w-0 truncate px-1.5 text-base text-kumo-link hover:underline"
						>
							{href.replace(LINK_DISPLAY_PREFIX_REGEX, "")}
						</a>
					) : (
						<span dir="auto" className="min-w-0 truncate px-1.5 text-base text-kumo-subtle">
							{href}
						</span>
					)}
					<BubbleSeparator />
					<BubbleButton onClick={onEdit} title={t`Edit link`}>
						<PencilSimple className="h-4 w-4" aria-hidden="true" />
					</BubbleButton>
					<BubbleButton
						onClick={() =>
							editor
								.chain()
								.focus()
								.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
								.unsetLink()
								.run()
						}
						title={t`Remove link`}
					>
						<LinkBreak className="h-4 w-4" aria-hidden="true" />
					</BubbleButton>
				</TooltipProvider>
			</div>
		</BubbleMenu>
	);
}

function BubbleSeparator() {
	return <div aria-hidden="true" className="mx-0.5 h-5 w-px flex-none bg-kumo-hairline" />;
}

const bubbleTriggerClassName = cn(
	"flex h-8 flex-none items-center gap-1 rounded-md px-2 text-base text-kumo-default outline-none",
	"hover:bg-kumo-tint data-popup-open:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-focus/50",
	"pointer-coarse:h-11",
);

interface BubbleMenuControl {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Escape from a selection-toolbar menu goes back to the editor. The menu's
 * own focus return can miss once the page has scrolled while it was open.
 */
function closeToEditor(editor: Editor, onOpenChange: (open: boolean) => void) {
	return (open: boolean, details: { reason: string }) => {
		onOpenChange(open);
		if (!open && details.reason === "escape-key" && !editor.isDestroyed) editor.view.focus();
	};
}

/** `activeId` is unset when the selection mixes block types, so nothing is checked. */
function TurnIntoMenu({
	editor,
	activeId,
	open,
	onOpenChange,
}: { editor: Editor; activeId?: TextBlockTypeId } & BubbleMenuControl) {
	const { t } = useLingui();
	const active = textBlockTypes.find((type) => type.id === activeId);
	return (
		<Menu.Root modal={false} open={open} onOpenChange={closeToEditor(editor, onOpenChange)}>
			<Menu.Trigger
				className={bubbleTriggerClassName}
				onMouseDown={(event) => event.preventDefault()}
				aria-label={t`Turn into`}
			>
				<span className="max-w-32 truncate">{active ? t(active.label) : t`Turn into`}</span>
				<CaretDown className="size-3 flex-none text-kumo-subtle" aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[110]">
					<Menu.Popup
						{...{ [BUBBLE_POPUP_ATTR]: "" }}
						finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
						onKeyDown={tabToEditor(editor, () => onOpenChange(false))}
						className={editorMenuPopupClassName}
					>
						<Menu.RadioGroup
							value={activeId ?? null}
							onValueChange={(id) =>
								textBlockTypes.find((type) => type.id === id)?.transform(editor)
							}
						>
							<EditorMenuLabel>{t`Turn into`}</EditorMenuLabel>
							{turnIntoMenuTypes(activeId).map((type) => (
								<EditorMenuRadioItem
									key={type.id}
									value={type.id}
									icon={type.icon}
									label={t(type.label)}
								/>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function MoreFormattingMenu({
	editor,
	subscript,
	superscript,
	open,
	onOpenChange,
}: {
	editor: Editor;
	subscript: boolean;
	superscript: boolean;
} & BubbleMenuControl) {
	const { t } = useLingui();
	const alignment = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => {
			const { alignments, isAlignmentUnavailable } = getSelectionTextAlignments(activeEditor);
			return {
				value: !isAlignmentUnavailable && alignments.size === 1 ? [...alignments][0] : undefined,
				unavailable: isAlignmentUnavailable,
			};
		},
	});
	return (
		<Menu.Root modal={false} open={open} onOpenChange={closeToEditor(editor, onOpenChange)}>
			<Menu.Trigger
				className={cn(bubbleTriggerClassName, "w-8 justify-center px-0 pointer-coarse:w-11")}
				onMouseDown={(event) => event.preventDefault()}
				aria-label={t`More formatting`}
			>
				<DotsThree className="h-4 w-4" weight="bold" aria-hidden="true" />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner side="bottom" align="end" sideOffset={8} className="z-[110]">
					<Menu.Popup
						{...{ [BUBBLE_POPUP_ATTR]: "" }}
						finalFocus={() => (editor.isDestroyed ? false : editor.view.dom)}
						onKeyDown={tabToEditor(editor, () => onOpenChange(false))}
						className={editorMenuPopupClassName}
					>
						<EditorMenuCheckboxItem
							icon={TextSubscript}
							label={t`Subscript`}
							checked={subscript}
							onCheckedChange={() => editor.chain().focus().toggleSubscript().run()}
						/>
						<EditorMenuCheckboxItem
							icon={TextSuperscript}
							label={t`Superscript`}
							checked={superscript}
							onCheckedChange={() => editor.chain().focus().toggleSuperscript().run()}
						/>
						<EditorMenuSeparator />
						<Menu.RadioGroup
							value={alignment.value ?? null}
							disabled={alignment.unavailable}
							onValueChange={(value: TextAlignment) => setSelectionTextAlignment(editor, value)}
						>
							<EditorMenuLabel>{t`Align`}</EditorMenuLabel>
							{(
								[
									["left", msg`Left`, TextAlignLeft],
									["center", msg`Center`, TextAlignCenter],
									["right", msg`Right`, TextAlignRight],
								] as const
							).map(([value, label, AlignIcon]) => (
								<EditorMenuRadioItem key={value} value={value} icon={AlignIcon} label={t(label)} />
							))}
						</Menu.RadioGroup>
						<EditorMenuSeparator />
						<EditorMenuItem
							icon={Eraser}
							label={t`Clear formatting`}
							onClick={() => {
								const chain = editor.chain().focus();
								for (const mark of FORMATTING_MARKS) chain.unsetMark(mark);
								chain.run();
							}}
						/>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

/**
 * Table Bubble Menu - appears when cursor is in a table.
 * Shows table editing options: add/remove rows/columns, toggle header, delete table.
 */
function TableBubbleMenu({
	editor,
	editable,
	appendTo,
	getCollisionOptions,
	onRun,
}: {
	editor: Editor;
	editable: boolean;
	appendTo: () => HTMLElement;
	getCollisionOptions: BubbleMenuCollisionOptions;
	onRun: (label: string) => void;
}) {
	const { t } = useLingui();
	const controls = useTableControls(editor);
	const run = (id: "add-row-after" | "add-column-after", label: string) => {
		if (runTableAction(editor, id)) onRun(label);
	};

	return (
		<BubbleMenu
			editor={editor}
			pluginKey={TABLE_BUBBLE_MENU_KEY}
			appendTo={appendTo}
			options={{
				strategy: "absolute",
				placement: "top",
				offset: 8,
				flip: getCollisionOptions,
				shift: getCollisionOptions,
				hide: hideUnderToolbar(getCollisionOptions),
				size: () => ({
					...getCollisionOptions(),
					apply: ({ availableWidth, elements }) => {
						elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
						elements.floating.style.overflowX = "auto";
						elements.floating.style.borderRadius = "var(--radius-lg)";
					},
				}),
			}}
			shouldShow={({ editor: activeEditor, element, state, view }) => {
				const activeElement = document.activeElement;
				const triggerId = element.querySelector('[aria-expanded="true"]')?.id;
				const hasMenuFocus = Boolean(
					triggerId &&
					activeElement?.closest('[role="menu"]')?.getAttribute("aria-labelledby") === triggerId,
				);
				const hasEditorFocus = view.hasFocus() || element.contains(activeElement) || hasMenuFocus;
				// In a link, the link preview shows instead, which would otherwise cover this.
				return (
					activeEditor.isEditable &&
					hasEditorFocus &&
					activeEditor.isActive("table") &&
					((state.selection.empty && !activeEditor.isActive("link")) ||
						state.selection instanceof CellSelection)
				);
			}}
		>
			<div
				data-emdash-table-bubble-menu
				role="toolbar"
				aria-label={t`Table controls`}
				className={bubbleMenuClassName}
				onKeyDown={(event) => moveToolbarFocus(event, false)}
			>
				{controls && (controls.rows > 1 || controls.columns > 1) && (
					<span className="px-2 text-xs text-kumo-subtle">
						{t`${plural(controls.rows, { one: "# row", other: "# rows" })} × ${plural(controls.columns, { one: "# column", other: "# columns" })} selected`}
					</span>
				)}
				<BubbleButton
					onClick={() => run("add-row-after", t`Row added below`)}
					disabled={!controls?.can["add-row-after"]}
					title={t`Add row below`}
				>
					<RowsPlusBottom className="h-4 w-4" aria-hidden="true" />
				</BubbleButton>
				<BubbleButton
					onClick={() => run("add-column-after", t`Column added after`)}
					disabled={!controls?.can["add-column-after"]}
					title={t`Add column after`}
				>
					<ColumnsPlusRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
				</BubbleButton>
				<TableMoreMenu editor={editor} editable={editable} onRun={onRun} />
			</div>
		</BubbleMenu>
	);
}

const IMAGE_ALIGNMENTS: { value: string | null; label: MessageDescriptor; Icon: Icon }[] = [
	{ value: null, label: msg`None`, Icon: Rows },
	{ value: "left", label: msg`Left`, Icon: AlignLeft },
	{ value: "center", label: msg`Center`, Icon: AlignCenterHorizontal },
	{ value: "right", label: msg`Right`, Icon: AlignRight },
];

function getSelectedImage(state: EditorState): NodeSelection | null {
	const { selection } = state;
	return selection instanceof NodeSelection && selection.node.type.name === "image"
		? selection
		: null;
}

function selectedImagePosition(editor: Editor): MappablePosition | null {
	const image = getSelectedImage(editor.state);
	return image ? editor.utils.createMappablePosition(image.from) : null;
}

/**
 * Image Bubble Menu - appears above a selected image.
 * Replace, alt text, alignment, link, settings and delete.
 */
function ImageBubbleMenu({
	editor,
	appendTo,
	getCollisionOptions,
	canOpenSettings,
}: {
	editor: Editor;
	appendTo: () => HTMLElement;
	getCollisionOptions: BubbleMenuCollisionOptions;
	canOpenSettings: boolean;
}) {
	const { t } = useLingui();
	const menuRef = React.useRef<HTMLDivElement>(null);
	const surfaceRef = React.useRef<HTMLDivElement>(null);
	const altInputRef = React.useRef<HTMLInputElement>(null);
	const [mode, setMode] = React.useState<"controls" | "alt" | "link">("controls");
	const [draft, setDraft] = React.useState("");
	const [linkInvalid, setLinkInvalid] = React.useState(false);
	const [pickerOpen, setPickerOpen] = React.useState(false);
	// Remounting the controls when the toolbar hides closes any hint left open on them.
	const [controlsKey, setControlsKey] = React.useState(0);
	// Holds the toolbar in place while the Replace picker has focus and until it
	// hands focus back, so its focus return can land on the Replace button.
	const pickerRef = React.useRef<"idle" | "open" | "closing">("idle");
	// Position of the image the open alt or link draft belongs to.
	const editingPosRef = React.useRef<MappablePosition | null>(null);
	const editSessionRef = React.useRef(0);
	const image = useEditorState({
		editor,
		selector: ({ editor: activeEditor }) => {
			const attrs = getSelectedImage(activeEditor.state)?.node.attrs;
			return {
				alt: typeof attrs?.alt === "string" ? attrs.alt : "",
				alignment: (attrs?.alignment as string | null | undefined) ?? null,
				link: (attrs?.link as { href?: string } | null | undefined)?.href ?? "",
				caption: typeof attrs?.caption === "string" ? attrs.caption : "",
				mediaId:
					typeof attrs?.mediaId === "string" &&
					attrs.mediaId &&
					canonicalMediaProviderId(attrs.provider as string | undefined) === "local"
						? attrs.mediaId
						: null,
			};
		},
	});
	const queryClient = useQueryClient();
	// Reads the image node view's cached media item; the toolbar never fetches it.
	const { data: media } = useQuery({
		queryKey: ["media", image.mediaId],
		queryFn: ({ signal }) => fetchMediaItem(image.mediaId!, { signal }),
		enabled: false,
	});
	// A file name is what uploads fall back to, so it doesn't count as a description,
	// and a Media Library image can't be checked until its media item has loaded.
	const described =
		Boolean(image.alt.trim()) &&
		(image.mediaId === null || (media !== undefined && image.alt !== media.filename));

	const getSelectedCaption = React.useCallback(() => {
		const selection = getSelectedImage(editor.state);
		const node = selection && editor.view.nodeDOM(selection.from);
		return node instanceof HTMLElement ? node.querySelector("textarea") : null;
	}, [editor]);
	const showControls = React.useCallback(() => {
		editingPosRef.current = null;
		setMode("controls");
	}, []);
	const updatePosition = React.useCallback(() => {
		if (editor.isDestroyed) return;
		editor.view.dispatch(editor.state.tr.setMeta(IMAGE_BUBBLE_MENU_KEY, "updatePosition"));
	}, [editor]);
	// A quick fade and scale in, played when the toolbar appears or moves to another image.
	const playEntrance = React.useCallback(() => {
		const menu = menuRef.current;
		const toolbar = surfaceRef.current;
		if (!menu?.isConnected || menu.hidden || !(toolbar instanceof HTMLElement)) return;
		const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		for (const animation of toolbar.getAnimations()) animation.cancel();
		toolbar.animate(
			reduceMotion
				? [{ opacity: 0 }, { opacity: 1 }]
				: [
						{ opacity: 0, transform: "scale(0.97)" },
						{ opacity: 1, transform: "none" },
					],
			{ duration: 150, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
		);
	}, []);

	// Replay the entrance when the selection moves to another image, and drop a
	// draft once its image is no longer the selection.
	React.useEffect(() => {
		let selectedPos = selectedImagePosition(editor);
		const onTransaction = (event: EditorEvents["transaction"]) => {
			const current = getSelectedImage(editor.state)?.from ?? null;
			if (
				current !== null &&
				selectedPos !== null &&
				current !== positionAfter(editor, selectedPos, event).position
			) {
				playEntrance();
			}
			selectedPos = selectedImagePosition(editor);
			if (editingPosRef.current === null) return;
			editingPosRef.current = positionAfter(editor, editingPosRef.current, event);
			if (current !== editingPosRef.current.position) showControls();
		};
		editor.on("transaction", onTransaction);
		return () => {
			editor.off("transaction", onTransaction);
		};
	}, [editor, playEntrance, showControls]);

	React.useEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		const dom = editor.view.dom;
		const isInside = (target: EventTarget | null) =>
			target instanceof Node && (dom.contains(target) || menu.contains(target));
		// TipTap re-checks visibility only on editor events, so it misses focus
		// leaving the toolbar itself for another field.
		const hide = () => {
			if (menu.hidden || !menu.isConnected) return;
			menu.hidden = true;
			setControlsKey((key) => key + 1);
		};
		const onFocusIn = (event: FocusEvent) => {
			if (pickerRef.current === "open") return;
			if (!isInside(event.target)) {
				// A closing picker can park focus on its dialog before handing it back.
				const inDialog = event.target instanceof Element && event.target.closest('[role="dialog"]');
				if (pickerRef.current === "closing" && inDialog) return;
				pickerRef.current = "idle";
				hide();
				return;
			}
			pickerRef.current = "idle";
			if (!menu.hidden) return;
			menu.hidden = false;
			updatePosition();
			playEntrance();
		};
		const onFocusOut = (event: FocusEvent) => {
			if (pickerRef.current !== "idle" || isInside(event.relatedTarget)) return;
			// Switching windows returns focus to the same place afterwards.
			if (!event.relatedTarget && !document.hasFocus()) return;
			// A link search pick disables its input while it resolves.
			if (event.target instanceof HTMLInputElement && event.target.disabled) return;
			hide();
		};
		// Tab moves image -> caption -> toolbar; Shift+Tab and Escape go back.
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.key !== "Tab" && event.key !== "Escape") || event.altKey || event.metaKey) return;
			if (event.defaultPrevented || event.isComposing || !editor.isEditable) return;
			const caption = getSelectedCaption();
			const forward = event.key === "Tab" && !event.shiftKey;
			let next: HTMLElement | null = null;
			if (event.target === dom && forward) {
				next = caption;
			} else if (event.target === caption && forward) {
				if (menu.isConnected && !menu.hidden) next = menu.querySelector("button, input");
			} else if (event.target === caption) {
				next = dom;
				event.stopPropagation();
			}
			if (!next) return;
			event.preventDefault();
			if (next === dom) editor.view.focus();
			else next.focus();
		};
		document.addEventListener("focusin", onFocusIn);
		document.addEventListener("focusout", onFocusOut);
		dom.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("focusin", onFocusIn);
			document.removeEventListener("focusout", onFocusOut);
			dom.removeEventListener("keydown", onKeyDown);
		};
	}, [editor, getSelectedCaption, playEntrance, updatePosition]);

	// A new row or label changes the toolbar's width, so center it over the image again.
	React.useEffect(updatePosition, [mode, updatePosition]);
	React.useEffect(() => {
		if (mode !== "alt") return;
		altInputRef.current?.focus();
		altInputRef.current?.select();
	}, [mode]);

	const startEditing = (next: "alt" | "link") => {
		editingPosRef.current = selectedImagePosition(editor);
		if (editingPosRef.current === null) return;
		// Hold focus in the toolbar while the focused button unmounts, or the focus gate hides it.
		if (menuRef.current?.contains(document.activeElement)) {
			surfaceRef.current?.focus({ preventScroll: true });
		}
		editSessionRef.current += 1;
		setDraft(next === "alt" ? image.alt : image.link);
		setLinkInvalid(false);
		setMode(next);
	};
	// Focus the editor before the edit row unmounts, so focus never drops to the page.
	const returnToEditor = () => {
		editor.view.focus();
		showControls();
	};
	const saveAlt = () => {
		if (editingPosRef.current !== null && draft.trim() !== image.alt) {
			editor.chain().updateAttributes("image", { alt: draft.trim() }).run();
		}
		returnToEditor();
	};
	// A link search pick can resolve after its row closed, or once another edit began.
	const applyLink = (href: string | null, session = editSessionRef.current) => {
		if (editingPosRef.current === null || session !== editSessionRef.current) return;
		if (!setSelectedImageLink(editor, href)) {
			setLinkInvalid(true);
			return;
		}
		showControls();
	};
	const toggleSettings = () => {
		const storage = (editor.storage as unknown as Record<string, Record<string, unknown>>).image;
		const position = getSelectedImage(editor.state)?.from;
		for (const handle of (storage?.settingsHandles as Set<ImageSettingsHandle> | undefined) ?? []) {
			if (handle.getPos() === position) handle.toggle();
		}
	};

	const editSession = editSessionRef.current;
	const separator = <div className="w-px h-6 bg-kumo-line mx-1" />;
	// On phones the controls wrap onto two rows, breaking here.
	const rowBreak = (
		<div className="w-px h-6 bg-kumo-line mx-1 max-[30rem]:mx-0 max-[30rem]:h-0 max-[30rem]:basis-full" />
	);
	// Below the sm breakpoint these buttons show only their icons.
	const textButtonClass =
		"h-8 gap-1.5 rounded-md px-2 text-sm pointer-coarse:h-11 max-sm:w-8 max-sm:justify-center max-sm:px-0 max-sm:pointer-coarse:w-11";

	return (
		<>
			<BubbleMenu
				ref={menuRef}
				editor={editor}
				pluginKey={IMAGE_BUBBLE_MENU_KEY}
				appendTo={appendTo}
				updateDelay={0}
				options={{
					strategy: "absolute",
					placement: "top",
					// Clears the selected image's edge, 6px outside it.
					offset: 14,
					flip: getCollisionOptions,
					shift: getCollisionOptions,

					size: () => ({
						...getCollisionOptions(),
						apply: ({ availableWidth, elements, placement }) => {
							elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
							elements.floating.style.setProperty(
								"--transform-origin",
								placement.startsWith("bottom") ? "top" : "bottom",
							);
						},
					}),
					onShow: playEntrance,
					onHide: () => {
						showControls();
						setControlsKey((key) => key + 1);
					},
				}}
				shouldShow={({ editor: activeEditor, element, state, view }) => {
					const selection = getSelectedImage(state);
					return (
						activeEditor.isEditable &&
						selection !== null &&
						(pickerRef.current !== "idle" ||
							view.hasFocus() ||
							element.contains(document.activeElement) ||
							Boolean(view.nodeDOM(selection.from)?.contains(document.activeElement)))
					);
				}}
			>
				<div
					ref={surfaceRef}
					tabIndex={-1}
					data-emdash-image-bubble-menu
					role="toolbar"
					aria-label={t`Image controls`}
					className={cn(
						bubbleMenuClassName,
						"origin-[var(--transform-origin)]",
						mode === "controls" && "flex-wrap justify-center",
					)}
					onMouseDown={(event) => {
						if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
					}}
					// Capture, so an open hint can't stop Escape before the toolbar sees it.
					onKeyDownCapture={(event) => {
						if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
						event.stopPropagation();
						returnToEditor();
					}}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						if (
							event.key === "Tab" &&
							event.shiftKey &&
							event.target === menuRef.current?.querySelector("button, input")
						) {
							event.preventDefault();
							(getSelectedCaption() ?? editor.view).focus();
							return;
						}
						moveToolbarFocus(event, false);
					}}
				>
					<TooltipProvider key={controlsKey} delay={200}>
						{mode === "alt" ? (
							<>
								<Input
									ref={altInputRef}
									aria-label={t`Alt text`}
									placeholder={t`Describe the image`}
									value={draft}
									onChange={(event) => setDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
										if (event.keyCode === 229) return;
										event.preventDefault();
										saveAlt();
									}}
									className="h-8 w-72 min-w-0 text-sm"
								/>
								<BubbleButton onClick={returnToEditor} title={t`Cancel`}>
									<X className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
								<BubbleButton onClick={saveAlt} title={t`Save alt text`}>
									<Check className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
							</>
						) : mode === "link" ? (
							<div className="flex min-w-0 items-start gap-0.5">
								<LinkDestinationInput
									className="w-72 min-w-0"
									value={draft}
									onValueChange={(value) => {
										setDraft(value);
										setLinkInvalid(false);
									}}
									invalid={linkInvalid}
									onSubmit={() => applyLink(draft)}
									onPick={(href) => applyLink(href, editSession)}
									onEscape={returnToEditor}
								/>
								{image.link && (
									<BubbleButton onClick={() => applyLink(null)} title={t`Remove link`}>
										<LinkBreak className="h-4 w-4" aria-hidden="true" />
									</BubbleButton>
								)}
								<BubbleButton onClick={returnToEditor} title={t`Cancel`}>
									<X className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
								<BubbleButton onClick={() => applyLink(draft)} title={t`Apply link`}>
									<Check className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
							</div>
						) : (
							<>
								<Button
									variant="ghost"
									className={textButtonClass}
									icon={<ImageSquare className="h-4 w-4" aria-hidden="true" />}
									onClick={() => {
										pickerRef.current = "open";
										setPickerOpen(true);
									}}
								>
									<span className="max-sm:sr-only">{t`Replace`}</span>
								</Button>
								<Button
									variant="ghost"
									className={cn(textButtonClass, described && "bg-kumo-tint text-kumo-link")}
									icon={<TextAa className="h-4 w-4" aria-hidden="true" />}
									title={described ? image.alt : t`No description yet`}
									aria-pressed={described}
									onClick={() => startEditing("alt")}
								>
									<span className="max-sm:sr-only">{t`Alt text`}</span>
								</Button>
								{separator}
								<div role="group" aria-label={t`Alignment`} className="flex items-center gap-0.5">
									{IMAGE_ALIGNMENTS.map(({ value, label, Icon }) => (
										<BubbleButton
											key={value ?? "none"}
											active={image.alignment === value}
											title={t(label)}
											onClick={() => {
												if (image.alignment === value) return;
												editor.chain().updateAttributes("image", { alignment: value }).run();
											}}
										>
											<Icon className="h-4 w-4" aria-hidden="true" />
										</BubbleButton>
									))}
								</div>
								{rowBreak}
								<BubbleButton
									onClick={() => startEditing("link")}
									active={Boolean(image.link)}
									title={image.link ? t`Edit link` : t`Add link`}
								>
									<LinkIcon className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
								<BubbleButton
									onClick={() => getSelectedCaption()?.focus()}
									active={Boolean(image.caption)}
									title={image.caption ? t`Edit caption` : t`Add caption`}
								>
									<Subtitles className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
								{canOpenSettings && (
									<BubbleButton onClick={toggleSettings} title={t`Image settings`}>
										<SlidersHorizontal className="h-4 w-4" aria-hidden="true" />
									</BubbleButton>
								)}
								{separator}
								<BubbleButton
									onClick={() => editor.chain().focus().deleteSelection().run()}
									title={t`Delete image`}
								>
									<Trash className="h-4 w-4" aria-hidden="true" />
								</BubbleButton>
							</>
						)}
					</TooltipProvider>
				</div>
			</BubbleMenu>
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={(open) => {
					pickerRef.current = open ? "open" : "closing";
					setPickerOpen(open);
				}}
				onSelect={(item) => {
					const selected = getSelectedImage(editor.state);
					if (!selected) return;
					if (canonicalMediaProviderId(item.provider) === "local") {
						queryClient.setQueryData(["media", item.id], item);
					}
					const attrs = {
						...mediaItemToImageAttrs(item),
						caption: undefined,
						title: undefined,
						...(dropsDisplayHeight(selected.node.attrs, item) ? { displayHeight: undefined } : {}),
					};
					editor.chain().updateAttributes("image", attrs).run();
				}}
				mimeTypeFilter="image/"
				title={t`Replace image`}
				confirmLabel={t`Replace`}
			/>
		</>
	);
}

function BubbleButton({
	onClick,
	active,
	disabled,
	danger,
	title,
	children,
}: {
	onClick: () => void;
	active?: boolean;
	disabled?: boolean;
	danger?: boolean;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Tooltip
			side="top"
			content={title}
			render={
				<Button
					type="button"
					variant="ghost"
					shape="square"
					className={cn(
						"h-8 w-8 rounded-md pointer-coarse:h-11 pointer-coarse:w-11",
						active && "bg-kumo-tint text-kumo-link",
						danger && "text-kumo-danger",
					)}
					onMouseDown={(event) => event.preventDefault()}
					onClick={onClick}
					disabled={disabled}
					aria-label={title}
					aria-pressed={active === undefined ? undefined : active}
				>
					{children}
				</Button>
			}
		/>
	);
}

type TextAlignment = "left" | "center" | "right" | "justify";
type AlignmentButtonState = boolean | "mixed";

function getSelectedTableCells(editor: Editor): ProseMirrorNode[] {
	const { selection } = editor.state;
	const cells: ProseMirrorNode[] = [];
	if (selection instanceof CellSelection) {
		selection.forEachCell((cell) => cells.push(cell));
		return cells;
	}
	for (let depth = selection.$from.depth; depth > 0; depth--) {
		const node = selection.$from.node(depth);
		if (node.type.name === "tableCell" || node.type.name === "tableHeader") {
			cells.push(node);
			break;
		}
	}
	return cells;
}

function getSelectionTextAlignments(editor: Editor): {
	alignments: Set<TextAlignment>;
	isCellSelection: boolean;
	isAlignmentUnavailable: boolean;
} {
	const tableCells = getSelectedTableCells(editor);
	if (selectionTouchesTable(editor.state) && !selectionIsContainedInTableCells(editor.state)) {
		return {
			alignments: new Set(),
			isCellSelection: false,
			isAlignmentUnavailable: true,
		};
	}
	const ownerWindow = editor.view.dom.ownerDocument.defaultView;
	const defaultAlignment: TextAlignment =
		ownerWindow?.getComputedStyle(editor.view.dom).direction === "rtl" ? "right" : "left";
	const alignments = new Set<TextAlignment>();
	if (tableCells.length > 0) {
		for (const cell of tableCells) {
			const textAlign = cell.attrs.textAlign;
			alignments.add(
				textAlign === "left" ||
					textAlign === "center" ||
					textAlign === "right" ||
					textAlign === "justify"
					? textAlign
					: defaultAlignment,
			);
		}
		return {
			alignments,
			isCellSelection: editor.state.selection instanceof CellSelection,
			isAlignmentUnavailable: false,
		};
	}

	let nested = false;
	const collectAlignment = (node: ProseMirrorNode, parent: ProseMirrorNode | null) => {
		if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
		if (parent?.type.name !== "doc") nested = true;
		const textAlign = node.attrs.textAlign;
		alignments.add(
			textAlign === "left" ||
				textAlign === "center" ||
				textAlign === "right" ||
				textAlign === "justify"
				? textAlign
				: defaultAlignment,
		);
	};

	for (const { $from, $to } of editor.state.selection.ranges) {
		if ($from.pos === $to.pos) {
			for (let depth = $from.depth; depth >= 0; depth -= 1) {
				const node = $from.node(depth);
				if (node.type.name === "paragraph" || node.type.name === "heading") {
					collectAlignment(node, depth > 0 ? $from.node(depth - 1) : null);
					break;
				}
			}
			continue;
		}

		editor.state.doc.nodesBetween($from.pos, $to.pos, (node, _pos, parent) => {
			collectAlignment(node, parent);
			return node.type.name !== "paragraph" && node.type.name !== "heading";
		});
	}

	// List items and quotes can't keep an alignment, and code and media have none.
	return {
		alignments,
		isCellSelection: false,
		isAlignmentUnavailable: nested || alignments.size === 0,
	};
}

function alignmentButtonState(
	alignments: Set<TextAlignment>,
	isCellSelection: boolean,
	alignment: TextAlignment,
): AlignmentButtonState {
	if (alignments.size === 1) return alignments.has(alignment);
	return isCellSelection && alignments.has(alignment) ? "mixed" : false;
}

function setSelectionTextAlignment(editor: Editor, alignment: TextAlignment): boolean {
	if (getSelectionTextAlignments(editor).isAlignmentUnavailable) return false;
	if (!(editor.state.selection instanceof CellSelection)) {
		const chain = editor.chain().focus();
		return editor.isActive("table")
			? chain.setCellAttribute("textAlign", alignment).run()
			: chain.setTextAlign(alignment).run();
	}

	editor.commands.focus();
	const selection = editor.state.selection;
	if (!(selection instanceof CellSelection)) return false;
	const transaction = editor.state.tr;
	selection.forEachCell((_cell, position) => {
		const cell = transaction.doc.nodeAt(position);
		if (cell && cell.attrs.textAlign !== alignment) {
			transaction.setNodeMarkup(position, undefined, { ...cell.attrs, textAlign: alignment });
		}
	});
	if (!transaction.docChanged) return false;
	editor.view.dispatch(transaction);
	return true;
}

/**
 * Takes over TipTap's own block and alignment shortcuts, so they convert and
 * align the way the toolbar does, and do nothing where the toolbar's buttons
 * are disabled, such as in a table.
 */
const STYLED_TEXT_BLOCKS = new Set(["heading", "codeBlock"]);

const BlockFormatShortcuts = Extension.create({
	name: "emdashBlockFormatShortcuts",
	priority: 1_200,
	addKeyboardShortcuts() {
		const convert = (id: TextBlockTypeId) => () => {
			if (canTurnInto(this.editor)) toggleTextBlockType(this.editor, id);
			return true;
		};
		const setAlignment = (alignment: TextAlignment) => {
			setSelectionTextAlignment(this.editor, alignment);
			return true;
		};
		// Backspace at the start of a heading or code block turns it into text first, the way it
		// lifts a list item or quote out, rather than joining it to the block above.
		const backspaceToText = () => {
			const { selection } = this.editor.state;
			const { $from } = selection;
			if (!selection.empty || $from.parentOffset !== 0) return false;
			if (!STYLED_TEXT_BLOCKS.has($from.parent.type.name)) return false;
			if (!this.editor.commands.undoInputRule()) turnInto(this.editor, "paragraph");
			return true;
		};
		return {
			Backspace: backspaceToText,
			"Shift-Backspace": backspaceToText,
			"Mod-Backspace": backspaceToText,
			"Alt-Backspace": backspaceToText,
			"Mod-Alt-1": convert("heading1"),
			"Mod-Alt-2": convert("heading2"),
			"Mod-Alt-3": convert("heading3"),
			"Mod-Alt-4": convert("heading4"),
			"Mod-Alt-5": convert("heading5"),
			"Mod-Alt-6": convert("heading6"),
			"Mod-Shift-7": convert("orderedList"),
			"Mod-Shift-8": convert("bulletList"),
			"Mod-Shift-b": convert("blockquote"),
			"Mod-Alt-c": convert("codeBlock"),
			"Mod-Shift-l": () => setAlignment("left"),
			"Mod-Shift-e": () => setAlignment("center"),
			"Mod-Shift-r": () => setAlignment("right"),
			"Mod-Shift-j": () => setAlignment("justify"),
		};
	},
});

const toolbarButtonClassName =
	"size-8 rounded-lg text-kumo-subtle hover:bg-kumo-interact/50 hover:text-kumo-default pointer-coarse:size-11";
const toolbarActiveClassName = "bg-kumo-interact/50 text-kumo-link hover:text-kumo-link";

/**
 * Editor Toolbar
 *
 * Implements WAI-ARIA toolbar pattern with proper keyboard navigation.
 * Arrow keys move focus between buttons, Home/End jump to first/last.
 */
function EditorToolbar({
	toolbarRef,
	editor,
	editable,
	onInsertBlock,
	onInsertImage,
	onTableAction,
	variant,
}: {
	toolbarRef: React.RefObject<HTMLDivElement | null>;
	editor: Editor;
	editable: boolean;
	onInsertBlock: () => void;
	onInsertImage: () => void;
	onTableAction: (label: string) => void;
	variant: NonNullable<PortableTextEditorProps["variant"]>;
}) {
	const { t } = useLingui();
	const [showLinkPopover, setShowLinkPopover] = React.useState(false);
	const [linkUrl, setLinkUrl] = React.useState("");
	const [linkInvalid, setLinkInvalid] = React.useState(false);

	// The document toolbar is stuck once the point it scrolls from leaves the view.
	const stuckSentinelRef = React.useRef<HTMLDivElement>(null);
	const [stuck, setStuck] = React.useState(false);
	React.useEffect(() => {
		const sentinel = stuckSentinelRef.current;
		if (!sentinel) return;
		const observer = new IntersectionObserver((entries) =>
			setStuck(entries.at(-1)?.isIntersecting === false),
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, []);

	// Subscribe to editor state changes for reactive button states
	const editorState = useEditorState({
		editor,
		selector: (ctx) => {
			const { alignments, isCellSelection, isAlignmentUnavailable } = getSelectionTextAlignments(
				ctx.editor,
			);
			const activeType = activeTextBlockType(ctx.editor)?.id;
			const isOrderedList = activeType === "orderedList";
			const touchesTable = selectionTouchesTable(ctx.editor.state);
			const can = ctx.editor.can();
			return {
				isInTable: touchesTable,
				isBold: ctx.editor.isActive("bold"),
				isItalic: ctx.editor.isActive("italic"),
				isUnderline: ctx.editor.isActive("underline"),
				isStrike: ctx.editor.isActive("strike"),
				isCode: ctx.editor.isActive("code"),
				canFormat: {
					bold: can.toggleBold(),
					italic: can.toggleItalic(),
					underline: can.toggleUnderline(),
					strike: can.toggleStrike(),
					code: can.toggleCode(),
				},
				canTurnInto: canTurnInto(ctx.editor),
				isBulletList: activeType === "bulletList",
				isOrderedList,
				canContinueOrderedList: isOrderedList && can.continueOrderedList(),
				canRestartOrderedList: isOrderedList && can.restartOrderedList(),
				isBlockquote: activeType === "blockquote",
				isCodeBlock: activeType === "codeBlock",
				alignLeftState:
					!isAlignmentUnavailable && alignmentButtonState(alignments, isCellSelection, "left"),
				alignCenterState:
					!isAlignmentUnavailable && alignmentButtonState(alignments, isCellSelection, "center"),
				alignRightState:
					!isAlignmentUnavailable && alignmentButtonState(alignments, isCellSelection, "right"),
				isAlignmentUnavailable,
				isLink: ctx.editor.isActive("link") || linkAtCaret(ctx.editor.state) !== undefined,
				isImage: ctx.editor.isActive("image"),
				canLink: ctx.editor.isActive("image") || can.setLink({ href: "https://example.com" }),
				imageHasLink:
					ctx.editor.isActive("image") && Boolean(ctx.editor.getAttributes("image").link),
				canUndo: can.undo(),
				canRedo: can.redo(),
			};
		},
	});

	// Populate link URL when opening popover
	React.useEffect(() => {
		setLinkInvalid(false);
		if (showLinkPopover) {
			const existingUrl = editor.isActive("image")
				? ((editor.getAttributes("image").link as { href?: string } | null)?.href ?? "")
				: ((linkAtCaret(editor.state)?.attrs.href as string | undefined) ??
					(editor.getAttributes("link").href || ""));
			setLinkUrl(existingUrl);
		}
	}, [showLinkPopover, editor]);

	// A URL the editor won't link keeps the popover open, saying why.
	const applyLinkHref = (href: string) => {
		const applied = editor.isActive("image")
			? setSelectedImageLink(editor, href)
			: setSelectedTextLink(editor, href);
		if (!applied) {
			setLinkInvalid(true);
			return;
		}
		setShowLinkPopover(false);
		setLinkUrl("");
	};

	const handleSetLink = () => {
		if (editor.isActive("image")) {
			if (!setSelectedImageLink(editor, linkUrl)) {
				setLinkInvalid(true);
				return;
			}
		} else if (linkUrl.trim() === "") {
			editor
				.chain()
				.focus()
				.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
				.unsetLink()
				.run();
		} else if (!setSelectedTextLink(editor, linkUrl)) {
			setLinkInvalid(true);
			return;
		}
		setShowLinkPopover(false);
		setLinkUrl("");
	};

	const handleRemoveLink = () => {
		if (editor.isActive("image")) {
			setSelectedImageLink(editor, null);
		} else {
			editor
				.chain()
				.focus()
				.extendMarkRange("link", linkAtCaret(editor.state)?.attrs)
				.unsetLink()
				.run();
		}
		setShowLinkPopover(false);
		setLinkUrl("");
	};

	const closeLinkPopover = () => {
		setShowLinkPopover(false);
		setLinkUrl("");
		editor.commands.focus();
	};

	// Keyboard navigation for toolbar (WAI-ARIA toolbar pattern)

	const isDocument = variant === "document";
	const linkLabel = editorState.isImage
		? t`Image link`
		: editorState.isLink
			? t`Edit link`
			: t`Add link`;

	const controls = (
		<div
			className={cn(
				"emdash-editor-toolbar flex flex-nowrap scroll-px-1 items-center gap-0.5 overflow-x-auto rounded-[inherit] p-1",
				isDocument && "justify-between",
			)}
			style={isDocument ? undefined : { justifyContent: "safe center" }}
		>
			{/* Text formatting */}
			<ToolbarGroup>
				<Tooltip
					content={t`Insert block after current block`}
					side="bottom"
					render={
						<Button
							type="button"
							variant="ghost"
							shape="square"
							className={cn(toolbarButtonClassName, "hidden pointer-coarse:flex")}
							onMouseDown={(event) => event.preventDefault()}
							onClick={onInsertBlock}
							aria-label={t`Insert block after current block`}
							data-touch-block-insert
						>
							<Plus className="h-4 w-4" aria-hidden="true" />
						</Button>
					}
				/>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleBold().run()}
					active={editorState.isBold}
					disabled={!editorState.canFormat.bold}
					title={t`Bold`}
				>
					<TextB className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleItalic().run()}
					active={editorState.isItalic}
					disabled={!editorState.canFormat.italic}
					title={t`Italic`}
				>
					<TextItalic className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleUnderline().run()}
					active={editorState.isUnderline}
					disabled={!editorState.canFormat.underline}
					title={t`Underline`}
				>
					<TextUnderline className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleStrike().run()}
					active={editorState.isStrike}
					disabled={!editorState.canFormat.strike}
					title={t`Strikethrough`}
				>
					<TextStrikethrough className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().toggleCode().run()}
					active={editorState.isCode}
					disabled={!editorState.canFormat.code}
					title={t`Inline Code`}
				>
					<Code className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Headings */}
			<ToolbarGroup>
				<HeadingDropdownMenu
					editor={editor}
					className={toolbarButtonClassName}
					activeClassName={toolbarActiveClassName}
				/>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Lists and blocks */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => toggleTextBlockType(editor, "bulletList")}
					active={editorState.isBulletList}
					disabled={!editorState.canTurnInto}
					title={t`Bullet List`}
				>
					<List className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => toggleTextBlockType(editor, "orderedList")}
					active={editorState.isOrderedList}
					disabled={!editorState.canTurnInto}
					title={t`Numbered List`}
				>
					<ListNumbers className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				{editorState.isOrderedList && (
					<>
						<ToolbarButton
							onClick={() => editor.chain().focus().continueOrderedList().run()}
							disabled={!editorState.canContinueOrderedList}
							title={t`Continue numbering`}
						>
							<ArrowUUpRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
						</ToolbarButton>
						<ToolbarButton
							onClick={() => editor.chain().focus().restartOrderedList().run()}
							disabled={!editorState.canRestartOrderedList}
							title={t`Restart numbering`}
						>
							<ArrowUUpLeft className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
						</ToolbarButton>
					</>
				)}
				<ToolbarButton
					onClick={() => toggleTextBlockType(editor, "blockquote")}
					active={editorState.isBlockquote}
					disabled={!editorState.canTurnInto}
					title={t`Quote`}
				>
					<Quotes className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => toggleTextBlockType(editor, "codeBlock")}
					active={editorState.isCodeBlock}
					disabled={!editorState.canTurnInto}
					title={t`Code Block`}
				>
					<CodeBlock className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={onInsertImage}
					disabled={editorState.isInTable}
					title={t`Insert image`}
				>
					<ImageIcon className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => insertHtmlBlock(editor)}
					disabled={editorState.isInTable}
					title={t`Insert HTML`}
				>
					<BracketsAngle className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator />
			<ToolbarGroup>
				<TableToolbarControl editor={editor} editable={editable} onRun={onTableAction} />
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Text alignment */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => setSelectionTextAlignment(editor, "left")}
					active={editorState.alignLeftState}
					disabled={editorState.isAlignmentUnavailable}
					title={t`Align left`}
				>
					<TextAlignLeft className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => setSelectionTextAlignment(editor, "center")}
					active={editorState.alignCenterState}
					disabled={editorState.isAlignmentUnavailable}
					title={t`Align center`}
				>
					<TextAlignCenter className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => setSelectionTextAlignment(editor, "right")}
					active={editorState.alignRightState}
					disabled={editorState.isAlignmentUnavailable}
					title={t`Align right`}
				>
					<TextAlignRight className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* Link */}
			<ToolbarGroup>
				<Popover
					open={showLinkPopover}
					onOpenChange={(open) => {
						setShowLinkPopover(open);
						if (!open) setLinkUrl("");
					}}
				>
					<Tooltip
						content={linkLabel}
						side="bottom"
						render={
							<Popover.Trigger
								render={
									<Button
										type="button"
										variant="ghost"
										shape="square"
										className={cn(
											toolbarButtonClassName,
											(editorState.isLink || editorState.imageHasLink) && toolbarActiveClassName,
										)}
										disabled={!editorState.canLink}
										onMouseDown={(event) => event.preventDefault()}
										aria-label={linkLabel}
										aria-pressed={editorState.isLink || editorState.imageHasLink}
									>
										<LinkIcon className="h-4 w-4" aria-hidden="true" />
									</Button>
								}
							/>
						}
					/>
					<Popover.Content side="bottom" align="start" className="w-auto p-3">
						<div className="flex flex-col gap-2">
							<label className="text-xs font-medium text-kumo-subtle">{t`Link`}</label>
							<LinkDestinationInput
								className="w-80 max-w-full min-w-0"
								value={linkUrl}
								onValueChange={(value) => {
									setLinkUrl(value);
									setLinkInvalid(false);
								}}
								invalid={linkInvalid}
								onSubmit={handleSetLink}
								onPick={applyLinkHref}
								onEscape={closeLinkPopover}
							/>
							<div className="flex justify-between">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										setShowLinkPopover(false);
										setLinkUrl("");
									}}
								>
									{t`Cancel`}
								</Button>
								<div className="flex gap-1">
									{(editorState.isLink || editorState.imageHasLink) && (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											className="text-kumo-danger"
											onClick={handleRemoveLink}
											icon={<LinkBreak />}
										>
											{t`Remove`}
										</Button>
									)}
									<Button type="button" variant="primary" size="sm" onClick={handleSetLink}>
										{t`Apply`}
									</Button>
								</div>
							</div>
						</div>
					</Popover.Content>
				</Popover>
			</ToolbarGroup>

			<ToolbarSeparator />

			{/* History */}
			<ToolbarGroup>
				<ToolbarButton
					onClick={() => editor.chain().focus().undo().run()}
					disabled={!editorState.canUndo}
					title={t`Undo`}
				>
					<ArrowUUpLeft className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
				<ToolbarButton
					onClick={() => editor.chain().focus().redo().run()}
					disabled={!editorState.canRedo}
					title={t`Redo`}
				>
					<ArrowUUpRight className="h-4 w-4" aria-hidden="true" />
				</ToolbarButton>
			</ToolbarGroup>
		</div>
	);

	return (
		<TooltipProvider>
			{isDocument && <div ref={stuckSentinelRef} aria-hidden="true" />}
			<div
				ref={toolbarRef}
				role="toolbar"
				aria-label={t`Text formatting`}
				data-emdash-editor-toolbar={variant}
				data-stuck={stuck || undefined}
				className={cn(
					"sticky z-20",
					// The band of page colour above the card hides text scrolling under the stuck toolbar.
					// The boxed toolbar sticks 1.5rem above its scroll container's top, past the padding
					// most hosts give it; a host without that padding sets --emdash-editor-sticky-top.
					isDocument
						? "top-0 -mt-2 mb-4 bg-(--emdash-editor-surface) pt-2"
						: "top-[var(--emdash-editor-sticky-top,-1.5rem)] border-b bg-kumo-tint",
				)}
				onKeyDown={(event) => moveToolbarFocus(event, true)}
			>
				{isDocument ? (
					<div className="rounded-xl bg-kumo-base shadow-xs ring ring-kumo-line">{controls}</div>
				) : (
					controls
				)}
			</div>
		</TooltipProvider>
	);
}

/**
 * Left and Right move focus between a toolbar's enabled buttons and links,
 * flipped for right-to-left text, and Home and End go to the first and last.
 * Up and Down do the same when `vertical`; otherwise the menus and selects in
 * the toolbar keep them.
 */
function moveToolbarFocus(event: React.KeyboardEvent<HTMLElement>, vertical: boolean) {
	if (event.nativeEvent.isComposing) return;
	const toolbar = event.currentTarget;
	const items = [
		...toolbar.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [role="button"]:not([disabled]), a[href]',
		),
	].filter((item) => item.getClientRects().length > 0);
	const currentIndex = items.findIndex((item) => item === document.activeElement);
	if (currentIndex === -1) return;
	const forward = getComputedStyle(toolbar).direction === "rtl" ? -1 : 1;

	let nextIndex: number;
	switch (event.key) {
		case "ArrowRight":
			nextIndex = currentIndex + forward;
			break;
		case "ArrowLeft":
			nextIndex = currentIndex - forward;
			break;
		case "ArrowDown":
			if (!vertical) return;
			nextIndex = currentIndex + 1;
			break;
		case "ArrowUp":
			if (!vertical) return;
			nextIndex = currentIndex - 1;
			break;
		case "Home":
			nextIndex = 0;
			break;
		case "End":
			nextIndex = items.length - 1;
			break;
		default:
			return;
	}
	event.preventDefault();
	items[(nextIndex + items.length) % items.length]?.focus();
}

function ToolbarGroup({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-none gap-0.5">{children}</div>;
}

function ToolbarSeparator() {
	return <div aria-hidden="true" className="mx-0.5 h-4 w-px flex-none self-center bg-kumo-line" />;
}

interface ToolbarButtonProps {
	onClick?: () => void;
	active?: AlignmentButtonState;
	disabled?: boolean;
	title: string; // Required for accessibility
	children: React.ReactNode;
}

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
	return (
		<Tooltip
			content={title}
			side="bottom"
			render={
				<Button
					type="button"
					variant="ghost"
					shape="square"
					className={cn(
						toolbarButtonClassName,
						active === true && toolbarActiveClassName,
						active === "mixed" && "bg-kumo-tint text-kumo-default ring-1 ring-inset ring-kumo-line",
					)}
					onMouseDown={(e) => e.preventDefault()}
					onClick={onClick}
					disabled={disabled}
					aria-label={title}
					aria-pressed={active}
					tabIndex={0}
				>
					{children}
				</Button>
			}
		/>
	);
}

export default PortableTextEditor;
