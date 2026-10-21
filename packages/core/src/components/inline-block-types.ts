/**
 * Text block types the inline editor can turn a block into. Shared by its
 * selection toolbar and slash menu so they agree on labels and icons, and
 * named and drawn like the admin editor's.
 */

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

export type BlockTypeId =
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

export interface BlockType {
	id: BlockTypeId;
	label: string;
	icon: Icon;
	/** Markdown that produces this block when typed at the start of a line. */
	markdown?: string;
}

const HEADINGS = [
	["heading1", 1],
	["heading2", 2],
	["heading3", 3],
	["heading4", 4],
	["heading5", 5],
	["heading6", 6],
] as const;

export const blockTypes: BlockType[] = [
	{ id: "paragraph", label: "Paragraph", icon: TextT },
	{ id: "heading1", label: "Heading 1", icon: TextHOne, markdown: "#" },
	{ id: "heading2", label: "Heading 2", icon: TextHTwo, markdown: "##" },
	{ id: "heading3", label: "Heading 3", icon: TextHThree, markdown: "###" },
	{ id: "heading4", label: "Heading 4", icon: TextHFour, markdown: "####" },
	{ id: "heading5", label: "Heading 5", icon: TextHFive, markdown: "#####" },
	{ id: "heading6", label: "Heading 6", icon: TextHSix, markdown: "######" },
	{ id: "bulletList", label: "Bullet List", icon: List, markdown: "-" },
	{ id: "orderedList", label: "Numbered List", icon: ListNumbers, markdown: "1." },
	{ id: "blockquote", label: "Quote", icon: Quotes, markdown: ">" },
	{ id: "codeBlock", label: "Code Block", icon: CodeBlock, markdown: "```" },
];

/** Headings 4 to 6 stay out of the Turn into menu unless the block already uses one. */
export function turnIntoMenuTypes(activeId?: BlockTypeId): BlockType[] {
	return blockTypes.filter(
		(type) => !["heading4", "heading5", "heading6"].includes(type.id) || type.id === activeId,
	);
}

function isListId(id: BlockTypeId | undefined): id is "bulletList" | "orderedList" {
	return id === "bulletList" || id === "orderedList";
}

/** The innermost list holding the whole selection, so a nested list reports its own type. */
function selectedListType(editor: Editor): "bulletList" | "orderedList" | undefined {
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

/** The type of the block at the selection, or nothing when it mixes types. */
export function activeBlockType(editor: Editor): BlockTypeId | undefined {
	if (editor.isActive("codeBlock")) return "codeBlock";
	const listType = selectedListType(editor);
	if (listType) return listType;
	if (editor.isActive("blockquote")) return "blockquote";
	for (const [id, level] of HEADINGS) {
		if (editor.isActive("heading", { level })) return id;
	}
	return editor.isActive("paragraph") ? "paragraph" : undefined;
}

/** Whether the selection holds text blocks, and no images or other blocks, to convert. */
export function canTurnInto(editor: Editor): boolean {
	const { state } = editor;
	if (!editor.isEditable) return false;
	let hasText = false;
	let hasAtom = false;
	state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
		if (node.isTextblock) hasText = true;
		else if (node.isAtom) hasAtom = true;
		return !node.isTextblock;
	});
	return hasText && !hasAtom;
}

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
 * Converts every text block the selection touches, the way the admin
 * editor's Turn into does. Converted blocks leave the lists and quotes
 * around them, which split around them, and a new list joins a list of the
 * same type right next to it. Quotes and list items save only paragraphs,
 * so a block that can't leave one stays as it is rather than becoming a
 * heading or code block there, which saving would drop.
 */
function convertTextBlocks(tr: Transaction, id: BlockTypeId): boolean {
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
	const listType = isListId(id) ? schema.nodes[id] : undefined;
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
		const level = HEADINGS.find(([headingId]) => headingId === id)?.[1];
		const stuck = blocks.some((block) => containerDepth(tr.doc.resolve(map(block))) !== null);
		if ((level !== undefined || id === "codeBlock") && stuck) return true;
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
				TextSelection.create(tr.doc, map(firstBlock), tr.doc.resolve(map(lastBlock)).end()),
				listType ? wrapInList(listType) : wrapIn(schema.nodes.blockquote!),
			);
		}
	}
	if (listType) joinAdjacentLists(tr, map(firstBlock), listType);
	tr.setSelection(
		TextSelection.between(
			tr.doc.resolve(map(selection.anchor)),
			tr.doc.resolve(map(selection.head)),
		),
	);
	return true;
}

/**
 * Turns the selected blocks into `id` in one undoable step, after deleting
 * `range`, the text a slash command was typed with.
 */
export function turnInto(editor: Editor, id: BlockTypeId, range?: Range): void {
	if (!editor.isEditable) return;
	const unchanged = activeBlockType(editor) === id;
	const chain = editor.chain().focus();
	if (range) chain.deleteRange(range);
	if (!unchanged) chain.command(({ tr }) => convertTextBlocks(tr, id));
	chain.run();
}
