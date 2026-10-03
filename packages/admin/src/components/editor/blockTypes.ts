/**
 * Text block types the editor can turn a block into. Shared by the block
 * menu, the selection toolbar, and the slash menu so they agree on labels
 * and icons.
 */

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	CodeBlock,
	List,
	ListNumbers,
	Quotes,
	TextHFive,
	TextHFour,
	TextHOne,
	TextHSix,
	TextHThree,
	TextHTwo,
	TextT,
	type Icon,
} from "@phosphor-icons/react";
import type { Editor, Range } from "@tiptap/core";
import { lift, wrapIn } from "@tiptap/pm/commands";
import type { Attrs, Node as ProseMirrorNode, NodeType, ResolvedPos } from "@tiptap/pm/model";
import { liftListItem, wrapInList } from "@tiptap/pm/schema-list";
import {
	EditorState,
	NodeSelection,
	TextSelection,
	type Command,
	type Selection,
	type Transaction,
} from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";

import { blockInsertPosition, enterBlockSelection } from "./BlockCommands.js";
import { selectionTouchesTable } from "./TableExtensions.js";

export type TextBlockTypeId =
	| "paragraph"
	| "heading1"
	| "heading2"
	| "heading3"
	| "heading4"
	| "heading5"
	| "heading6"
	| "bulletList"
	| "orderedList"
	| "blockquote"
	| "codeBlock";

export interface TextBlockType {
	id: TextBlockTypeId;
	label: MessageDescriptor;
	icon: Icon;
	/** Markdown that produces this block when typed at the start of a line. */
	markdown?: string;
	isActive: (editor: Editor) => boolean;
	/** Converts the selected block(s) in one undoable step. */
	transform: (editor: Editor) => void;
}

const heading = (
	level: 1 | 2 | 3 | 4 | 5 | 6,
	label: MessageDescriptor,
	icon: Icon,
): TextBlockType => ({
	id: `heading${level}`,
	label,
	icon,
	markdown: "#".repeat(level),
	isActive: (editor) => editor.isActive("heading", { level }),
	transform: (editor) => turnInto(editor, `heading${level}`),
});

export const textBlockTypes: TextBlockType[] = [
	{
		id: "paragraph",
		label: msg`Text`,
		icon: TextT,
		isActive: (editor) => editor.isActive("paragraph"),
		transform: (editor) => turnInto(editor, "paragraph"),
	},
	heading(1, msg`Heading 1`, TextHOne),
	heading(2, msg`Heading 2`, TextHTwo),
	heading(3, msg`Heading 3`, TextHThree),
	heading(4, msg`Heading 4`, TextHFour),
	heading(5, msg`Heading 5`, TextHFive),
	heading(6, msg`Heading 6`, TextHSix),
	{
		id: "bulletList",
		label: msg`Bulleted list`,
		icon: List,
		markdown: "-",
		isActive: (editor) => editor.isActive("bulletList"),
		transform: (editor) => turnInto(editor, "bulletList"),
	},
	{
		id: "orderedList",
		label: msg`Numbered list`,
		icon: ListNumbers,
		markdown: "1.",
		isActive: (editor) => editor.isActive("orderedList"),
		transform: (editor) => turnInto(editor, "orderedList"),
	},
	{
		id: "blockquote",
		label: msg`Quote`,
		icon: Quotes,
		markdown: ">",
		isActive: (editor) => editor.isActive("blockquote"),
		transform: (editor) => turnInto(editor, "blockquote"),
	},
	{
		id: "codeBlock",
		label: msg`Code block`,
		icon: CodeBlock,
		markdown: "```",
		isActive: (editor) => editor.isActive("codeBlock"),
		transform: (editor) => turnInto(editor, "codeBlock"),
	},
];

/** Headings 4 to 6 stay out of menus unless a block already uses one; the slash menu finds them by name. */
const MENU_HIDDEN_TYPES = new Set<TextBlockTypeId>(["heading4", "heading5", "heading6"]);

/** The types a Turn into menu offers for a block of the given type. */
export function turnIntoMenuTypes(activeId?: TextBlockTypeId): TextBlockType[] {
	return textBlockTypes.filter((type) => !MENU_HIDDEN_TYPES.has(type.id) || type.id === activeId);
}

const ACTIVE_ORDER: TextBlockTypeId[] = [
	"codeBlock",
	"orderedList",
	"bulletList",
	"blockquote",
	"heading1",
	"heading2",
	"heading3",
	"heading4",
	"heading5",
	"heading6",
	"paragraph",
];

/** The innermost list holding the whole selection, so a nested list reports its own type. */
function selectedListType(editor: Editor): TextBlockTypeId | undefined {
	const { selection } = editor.state;
	if (selection instanceof NodeSelection) {
		const { name } = selection.node.type;
		if (name === "bulletList" || name === "orderedList") return name;
	}
	const { $from, $to } = selection;
	for (let depth = $from.sharedDepth($to.pos); depth > 0; depth--) {
		const { name } = $from.node(depth).type;
		if (name === "bulletList" || name === "orderedList") return name;
	}
	return undefined;
}

/** The innermost-meaningful type of the block at the selection, e.g. a list rather than its paragraph. */
export function activeTextBlockType(editor: Editor): TextBlockType | undefined {
	const listType = selectedListType(editor);
	for (const id of ACTIVE_ORDER) {
		const type = textBlockTypes.find((candidate) => candidate.id === id);
		const active =
			id === "bulletList" || id === "orderedList" ? listType === id : type?.isActive(editor);
		if (active) return type;
	}
	return undefined;
}

/** Whether the selection holds text blocks outside tables, and no media or embeds, to convert. */
export function canTurnInto(editor: Editor): boolean {
	const { state } = editor;
	if (!editor.isEditable || selectionTouchesTable(state)) return false;
	let hasText = false;
	let hasAtom = false;
	state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
		if (node.isTextblock) hasText = true;
		else if (node.isAtom) hasAtom = true;
		return !node.isTextblock;
	});
	return hasText && !hasAtom;
}

const HEADING_LEVELS: Partial<Record<TextBlockTypeId, number>> = {
	heading1: 1,
	heading2: 2,
	heading3: 3,
	heading4: 4,
	heading5: 5,
	heading6: 6,
};

/** Depth of the innermost list item or quote around a text position. */
function containerDepth($pos: ResolvedPos): number | null {
	for (let depth = $pos.depth - 1; depth > 0; depth--) {
		const { name } = $pos.node(depth).type;
		if (name === "listItem" || name === "blockquote") return depth;
	}
	return null;
}

/** Position of the innermost list holding both text positions. */
function sharedListPos(doc: ProseMirrorNode, from: number, to: number): number | null {
	const $from = doc.resolve(from);
	for (let depth = $from.sharedDepth(to); depth > 0; depth--) {
		const { name } = $from.node(depth).type;
		if (name === "bulletList" || name === "orderedList") return $from.before(depth);
	}
	return null;
}

/**
 * Runs a ProseMirror command on the transaction's current document and adds
 * its steps to the transaction, so several commands form one undo step.
 */
function runCommand(tr: Transaction, selection: Selection, command: Command): boolean {
	const state = EditorState.create({ doc: tr.doc, selection });
	return command(state, (commandTr) => {
		for (const step of commandTr.steps) tr.step(step);
	});
}

/** Sets the text blocks between two positions to `type`, keeping their alignment. */
function setTextBlockType(
	tr: Transaction,
	from: number,
	to: number,
	type: NodeType,
	attrs: Attrs = {},
) {
	tr.setBlockType(from, to, type, (node) =>
		type.spec.attrs?.textAlign && node.attrs.textAlign !== undefined
			? { ...attrs, textAlign: node.attrs.textAlign }
			: attrs,
	);
}

/**
 * Joins the list holding `pos` with lists of the same type right before and
 * after it. A numbered list after it that starts at its own number keeps it.
 */
function joinAdjacentLists(tr: Transaction, pos: number, type: NodeType) {
	const $pos = tr.doc.resolve(pos);
	for (let depth = $pos.depth; depth > 0; depth--) {
		if ($pos.node(depth).type !== type) continue;
		const after = $pos.after(depth);
		const next = tr.doc.resolve(after).nodeAfter;
		const ownStart = typeof next?.attrs.start === "number" && next.attrs.start !== 1;
		if (next?.type === type && !ownStart && canJoin(tr.doc, after)) tr.join(after);
		const before = $pos.before(depth);
		if (tr.doc.resolve(before).nodeBefore?.type === type && canJoin(tr.doc, before)) {
			tr.join(before);
		}
		return;
	}
}

/**
 * Converts every text block the selection touches. A block selected whole,
 * as from its handle, converts entirely: each item of a list and each
 * paragraph of a quote. Converted blocks leave the lists and quotes around
 * them, which split around them instead of flattening. A new list joins a
 * list of the same type right next to it.
 */
function convertTextBlocks(tr: Transaction, id: TextBlockTypeId): boolean {
	const { selection } = tr;
	const { schema } = tr.doc.type;
	const blocks: number[] = [];
	tr.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
		if (!node.isTextblock) return true;
		blocks.push(pos + 1);
		return false;
	});
	const firstBlock = blocks[0];
	const lastBlock = blocks.at(-1);
	if (firstBlock === undefined || lastBlock === undefined) return false;

	const start = tr.steps.length;
	const map = (pos: number) => tr.mapping.slice(start).map(pos);
	const blockRange = () =>
		TextSelection.create(tr.doc, map(firstBlock), tr.doc.resolve(map(lastBlock)).end());
	const listType = id === "bulletList" || id === "orderedList" ? schema.nodes[id] : undefined;
	const listPos = listType ? sharedListPos(tr.doc, firstBlock, lastBlock) : null;

	if (listType && listPos !== null) {
		// Switching list types keeps the list, nesting included.
		tr.setNodeMarkup(listPos, listType);
	} else {
		for (const block of blocks) {
			for (let lifts = 0; lifts < 32; lifts++) {
				const $pos = tr.doc.resolve(map(block));
				const depth = containerDepth($pos);
				if (depth === null) break;
				const command =
					$pos.node(depth).type.name === "listItem" ? liftListItem(schema.nodes.listItem!) : lift;
				if (!runCommand(tr, TextSelection.create(tr.doc, $pos.pos), command)) break;
			}
		}
		const from = map(firstBlock);
		const to = map(lastBlock);
		const level = HEADING_LEVELS[id];
		if (level !== undefined) {
			setTextBlockType(tr, from, to, schema.nodes.heading!, { level });
		} else if (id === "codeBlock") {
			tr.setBlockType(from, to, schema.nodes.codeBlock!);
		} else if (id === "paragraph") {
			setTextBlockType(tr, from, to, schema.nodes.paragraph!);
		} else {
			// Quotes and list items hold plain paragraphs, which can't keep an alignment.
			tr.setBlockType(from, to, schema.nodes.paragraph!);
			runCommand(
				tr,
				blockRange(),
				listType ? wrapInList(listType) : wrapIn(schema.nodes.blockquote!),
			);
		}
	}
	if (listType) joinAdjacentLists(tr, map(firstBlock), listType);

	if (selection instanceof NodeSelection) {
		// Keep a single converted block selected; several leave the caret after them.
		const $first = tr.doc.resolve(map(firstBlock));
		const $last = tr.doc.resolve(map(lastBlock));
		const top = $first.before(1);
		tr.setSelection(
			$last.before(1) === top
				? NodeSelection.create(tr.doc, top)
				: TextSelection.create(tr.doc, $last.end()),
		);
	} else {
		tr.setSelection(
			TextSelection.between(
				tr.doc.resolve(map(selection.anchor)),
				tr.doc.resolve(map(selection.head)),
			),
		);
	}
	return true;
}

/**
 * Turns the selected block(s) into `id` in one undoable step, after deleting
 * `range`, the text a slash command was typed with.
 */
export function turnInto(editor: Editor, id: TextBlockTypeId, range?: Range): void {
	if (!editor.isEditable) return;
	const { selection } = editor.state;
	const wholeBlock = selection instanceof NodeSelection && selection.$from.depth === 0;
	const unchanged = activeTextBlockType(editor)?.id === id;
	const chain = editor.chain().focus();
	if (range) chain.deleteRange(range);
	if (unchanged) {
		chain.run();
		return;
	}
	const converted = chain.command(({ tr }) => convertTextBlocks(tr, id)).run();
	if (!converted || !wholeBlock) return;
	// Ordered-list repairs can remap the selected block to a caret inside it.
	const after = editor.state.selection;
	if (after instanceof NodeSelection || after.$head.before(1) === selection.from) {
		editor.commands.setNodeSelection(selection.from);
		enterBlockSelection(editor);
	}
}

/**
 * A toolbar block button: turns the selection into `id`, or back when it
 * already is one. A list item goes up one level, as TipTap's own toggles do;
 * other blocks go back to text.
 */
export function toggleTextBlockType(editor: Editor, id: TextBlockTypeId): void {
	const isList = id === "bulletList" || id === "orderedList";
	if (activeTextBlockType(editor)?.id !== id) {
		turnInto(editor, id);
	} else if (!isList || !editor.chain().focus().liftListItem("listItem").run()) {
		// A list selected whole has no single item to lift, so all of it goes back to text.
		turnInto(editor, "paragraph");
	}
}

/**
 * Moves the caret to where an inserted block can be saved, so the block
 * replaces the empty paragraph there: after a block selected whole or one
 * holding text, or after the list or quote holding the caret. An empty line
 * in a list or quote leaves it to become that paragraph itself, so nothing
 * empty is left behind.
 */
export function prepareBlockInsert(tr: Transaction): boolean {
	const position = blockInsertPosition(tr.selection);
	if (position === null) return true;
	const { selection } = tr;
	if (selection instanceof TextSelection && selection.$from.parent.content.size === 0) {
		return convertTextBlocks(tr, "paragraph");
	}
	tr.insert(position, tr.doc.type.schema.nodes.paragraph!.create());
	tr.setSelection(TextSelection.create(tr.doc, position + 1));
	return true;
}
