/**
 * The inline editor's slash menu, laid out and ranked like the admin
 * editor's: commands grouped by kind with their markdown, the highlighted
 * command's description below them, and the best matches first as a query
 * is typed.
 */

import {
	autoUpdate,
	flip,
	hide,
	offset,
	shift,
	size,
	useFloating,
	useTransitionStatus,
} from "@floating-ui/react";
import { BracketsAngle, Image as ImageIcon, Minus, type Icon } from "@phosphor-icons/react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion from "@tiptap/suggestion";
import * as React from "react";
import { createPortal } from "react-dom";

import { blockTypes, turnInto, type BlockTypeId } from "./inline-block-types.js";
import { originStyle, transformOrigin } from "./inline-editor-ui.js";

export interface SlashCommandItem {
	id: string;
	title: string;
	description: string;
	icon: Icon;
	aliases?: string[];
	/** Markdown that creates the same block, shown as a hint beside the title. */
	markdown?: string;
	/** Only listed when the query matches, to keep the unfiltered menu short. */
	searchOnly?: boolean;
	category: string;
	command: (props: { editor: Editor; range: Range }) => void;
}

const BASIC_BLOCKS = "Basic blocks";
const WHITESPACE_REGEX = /\s+/;
const WHITESPACE_START_REGEX = /^\s/;

function blockCommand(
	blockTypeId: BlockTypeId,
	item: Pick<SlashCommandItem, "id" | "description" | "aliases" | "searchOnly">,
): SlashCommandItem {
	const type = blockTypes.find((candidate) => candidate.id === blockTypeId);
	if (!type) throw new Error(`Unknown block type: ${blockTypeId}`);
	return {
		...item,
		title: type.label,
		icon: type.icon,
		markdown: type.markdown,
		category: BASIC_BLOCKS,
		command: ({ editor, range }) => turnInto(editor, blockTypeId, range),
	};
}

export const slashCommands: SlashCommandItem[] = [
	blockCommand("paragraph", {
		id: "paragraph",
		description: "Start writing with plain text",
		aliases: ["text", "plain", "p"],
	}),
	blockCommand("heading1", {
		id: "heading1",
		description: "Large section heading",
		aliases: ["h1", "title"],
	}),
	blockCommand("heading2", {
		id: "heading2",
		description: "Medium section heading",
		aliases: ["h2", "subtitle"],
	}),
	blockCommand("heading3", {
		id: "heading3",
		description: "Small section heading",
		aliases: ["h3"],
	}),
	blockCommand("bulletList", {
		id: "bulletList",
		description: "Create a bullet list",
		aliases: ["ul", "unordered", "bulleted"],
	}),
	blockCommand("orderedList", {
		id: "numberedList",
		description: "Create a numbered list",
		aliases: ["ol", "ordered"],
	}),
	blockCommand("blockquote", {
		id: "quote",
		description: "Insert a blockquote",
		aliases: ["blockquote", "cite"],
	}),
	blockCommand("codeBlock", {
		id: "codeBlock",
		description: "Insert a code block",
		aliases: ["pre", "snippet", "```"],
	}),
	{
		id: "divider",
		title: "Divider",
		description: "Insert a horizontal rule",
		icon: Minus,
		// Typography turns a typed "--" into an em dash, so "/---" arrives as "/—-".
		aliases: ["hr", "---", "—-", "separator", "line"],
		markdown: "---",
		category: BASIC_BLOCKS,
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).setHorizontalRule().run();
		},
	},
	blockCommand("heading4", {
		id: "heading4",
		description: "Smaller section heading",
		aliases: ["h4"],
		searchOnly: true,
	}),
	blockCommand("heading5", {
		id: "heading5",
		description: "Minor section heading",
		aliases: ["h5"],
		searchOnly: true,
	}),
	blockCommand("heading6", {
		id: "heading6",
		description: "Smallest section heading",
		aliases: ["h6"],
		searchOnly: true,
	}),
	{
		id: "image",
		title: "Image",
		description: "Insert an image",
		icon: ImageIcon,
		aliases: ["img", "photo", "picture"],
		category: "Media",
		command: ({ editor, range }) => {
			editor.chain().focus().deleteRange(range).run();
			document.dispatchEvent(new CustomEvent("emdash:open-media-picker"));
		},
	},
	{
		id: "htmlBlock",
		title: "HTML",
		description: "Insert raw HTML",
		icon: BracketsAngle,
		aliases: ["html", "raw", "markup"],
		category: "Advanced",
		command: ({ editor, range }) => {
			editor
				.chain()
				.focus()
				.deleteRange(range)
				.insertContent({ type: "htmlBlock", attrs: { html: "", isolated: true } })
				.run();
		},
	},
];

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
	) {
		return 85;
	}
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

/** The commands to list for a query, best match first, or all of them by category. */
export function filterSlashCommands(query: string): SlashCommandItem[] {
	if (!query.trim()) {
		// The menu groups commands by category, so arrow keys must follow that order.
		const visible = slashCommands.filter((item) => !item.searchOnly);
		const categories = [...new Set(visible.map((item) => item.category))];
		return visible.toSorted(
			(a, b) => categories.indexOf(a.category) - categories.indexOf(b.category),
		);
	}
	return slashCommands
		.map((item, order) => ({
			item,
			order,
			score: scoreSlashCommand(query, item.title, item.description, [
				...(item.aliases ?? []),
				...(item.markdown ? [item.markdown] : []),
			]),
		}))
		.filter((entry) => entry.score > 0)
		.toSorted((a, b) => b.score - a.score || a.order - b.order)
		.map((entry) => entry.item);
}

export interface SlashMenuState {
	isOpen: boolean;
	items: SlashCommandItem[];
	selectedIndex: number;
	clientRect: (() => DOMRect | null) | null;
	range: Range | null;
	query: string;
	/** A slash whose menu was closed without a command, so it doesn't reopen. */
	dismissedSlashFrom: number | null;
}

export const initialSlashMenuState: SlashMenuState = {
	isOpen: false,
	items: [],
	selectedIndex: 0,
	clientRect: null,
	range: null,
	query: "",
	dismissedSlashFrom: null,
};

export function createSlashCommandsExtension(options: {
	onStateChange: React.Dispatch<React.SetStateAction<SlashMenuState>>;
	getState: () => SlashMenuState;
	onCommand: (item: SlashCommandItem) => void;
	/** Escape or Tab closed the menu without running a command. */
	onDismiss: () => void;
}) {
	const { onStateChange, getState, onCommand, onDismiss } = options;

	return Extension.create({
		name: "slashCommands",

		onTransaction() {
			const state = getState();
			if (state.dismissedSlashFrom === null) return;
			const to = Math.min(state.dismissedSlashFrom + 1, this.editor.state.doc.content.size);
			if (this.editor.state.doc.textBetween(state.dismissedSlashFrom, to) !== "/") {
				onStateChange((prev) => ({ ...prev, dismissedSlashFrom: null }));
			}
		},

		addProseMirrorPlugins() {
			return [
				Suggestion<SlashCommandItem, SlashCommandItem>({
					editor: this.editor,
					char: "/",
					startOfLine: true,
					decorationClass: "emdash-slash-query",
					command: ({ props }) => onCommand(props),
					items: ({ query }) => filterSlashCommands(query),
					// Titles such as "Code Block" can be typed whole; a space after no match ends the query.
					allowSpaces: true,
					allow: ({ state, range }) => {
						if (getState().dismissedSlashFrom === range.from) return false;
						const query = state.doc.textBetween(range.from + 1, range.to);
						return (
							!WHITESPACE_START_REGEX.test(query) &&
							(!WHITESPACE_REGEX.test(query) || filterSlashCommands(query).length > 0)
						);
					},
					render: () => ({
						onStart: (props) => {
							onStateChange({
								isOpen: true,
								items: props.items,
								selectedIndex: 0,
								clientRect: props.clientRect ?? null,
								range: props.range,
								query: props.query,
								dismissedSlashFrom: null,
							});
						},
						onUpdate: (props) => {
							onStateChange((prev) => ({
								...prev,
								items: props.items,
								selectedIndex: 0,
								clientRect: props.clientRect ?? null,
								range: props.range,
								query: props.query,
								dismissedSlashFrom: null,
							}));
						},
						onKeyDown: ({ event }) => {
							if (event.key === "Escape" || event.key === "Tab") {
								onDismiss();
								return event.key === "Escape";
							}
							const { items, selectedIndex } = getState();
							if (event.key === "ArrowUp" || event.key === "ArrowDown") {
								if (items.length === 0) return true;
								const step = event.key === "ArrowUp" ? -1 : 1;
								onStateChange((prev) => ({
									...prev,
									selectedIndex: (prev.selectedIndex + step + items.length) % items.length,
								}));
								return true;
							}
							if (event.key === "Enter") {
								const item = items[selectedIndex];
								if (!item) return false;
								onCommand(item);
								return true;
							}
							return false;
						},
						onExit: () => {
							onStateChange((prev) => ({ ...prev, isOpen: false }));
						},
					}),
				}),
			];
		},
	});
}

/** The slash menu, anchored below the slash being typed. */
export function InlineSlashMenu({
	editor,
	uiRoot,
	state,
	onCommand,
	onClose,
	setSelectedIndex,
}: {
	editor: Editor;
	uiRoot: HTMLElement;
	state: SlashMenuState;
	onCommand: (item: SlashCommandItem) => void;
	onClose: () => void;
	setSelectedIndex: (index: number) => void;
}) {
	const viewportRef = React.useRef<HTMLDivElement>(null);
	const popupRef = React.useRef<HTMLDivElement | null>(null);
	const { refs, floatingStyles, context, isPositioned, middlewareData } = useFloating({
		open: state.isOpen,
		placement: "bottom-start",
		strategy: "fixed",
		transform: false,
		middleware: [
			offset(6),
			flip({ padding: 8, fallbackAxisSideDirection: "none" }),
			shift({ padding: 8 }),
			size({
				padding: 8,
				apply: ({ availableHeight, elements }) => {
					elements.floating.style.maxHeight = `${Math.min(336, Math.max(0, availableHeight))}px`;
				},
			}),
			hide(),
			transformOrigin(),
		],
		whileElementsMounted: autoUpdate,
	});
	const { isMounted, status } = useTransitionStatus(context, {
		duration: { open: 100, close: 75 },
	});

	const { clientRect } = state;
	const lastRectRef = React.useRef<DOMRect | null>(null);
	React.useLayoutEffect(() => {
		refs.setPositionReference(
			clientRect
				? {
						getBoundingClientRect: () => {
							// Once the menu closes its slash may be gone, so it fades out where it was.
							lastRectRef.current = clientRect() ?? lastRectRef.current;
							return lastRectRef.current ?? new DOMRect();
						},
						contextElement: editor.view.dom,
					}
				: null,
		);
	}, [clientRect, editor, refs]);

	// The item the pointer last highlighted, which is already where the pointer is.
	const pointerIndexRef = React.useRef<number | null>(null);

	// Scroll the selected item, and the label above the first of a group,
	// into view within the menu only, never the page.
	React.useEffect(() => {
		if (!state.isOpen) return;
		const highlightedByPointer = pointerIndexRef.current === state.selectedIndex;
		pointerIndexRef.current = null;
		if (highlightedByPointer) return;
		const viewport = viewportRef.current;
		const selected = viewport?.querySelector<HTMLElement>(`[data-index="${state.selectedIndex}"]`);
		if (!viewport || !selected) return;
		if (state.selectedIndex === 0) {
			viewport.scrollTop = 0;
			return;
		}
		const label = selected.previousElementSibling;
		const top = (
			label?.classList.contains("emdash-slash-menu-group-label") ? label : selected
		).getBoundingClientRect().top;
		const { bottom } = selected.getBoundingClientRect();
		const view = viewport.getBoundingClientRect();
		const padding = Number.parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0;
		if (top < view.top + padding) {
			viewport.scrollTop -= view.top + padding - top;
		} else if (bottom > view.bottom - padding) {
			viewport.scrollTop += bottom - (view.bottom - padding);
		}
	}, [state.selectedIndex, state.isOpen]);

	// The menu opens at the caret, which may sit under a still pointer. Only a
	// real move hands the highlight to the pointer, so it doesn't take over
	// from the keyboard the moment the menu appears.
	const hasMouseMovedRef = React.useRef(false);
	React.useEffect(() => {
		if (!state.isOpen) hasMouseMovedRef.current = false;
	}, [state.isOpen]);

	React.useEffect(() => {
		if (!state.isOpen) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
			onClose();
		};
		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [onClose, state.isOpen]);

	if (!isMounted || !clientRect) return null;

	const selectedItem = state.items[state.selectedIndex];
	const groups: {
		key: string;
		label: string;
		entries: { item: SlashCommandItem; index: number }[];
	}[] = [];
	state.items.forEach((item, index) => {
		const key = state.query ? "results" : item.category;
		const group = groups.find((candidate) => candidate.key === key);
		if (group) group.entries.push({ item, index });
		else groups.push({ key, label: item.category, entries: [{ item, index }] });
	});

	return createPortal(
		<div
			ref={(node) => {
				popupRef.current = node;
				refs.setFloating(node);
			}}
			style={{
				...floatingStyles,
				...originStyle(middlewareData.transformOrigin),
				visibility:
					(isPositioned || status === "close") && !middlewareData.hide?.referenceHidden
						? "visible"
						: "hidden",
			}}
			role="dialog"
			className="emdash-slash-menu"
			data-status={status}
			aria-label="Insert block"
			onPointerMove={() => {
				hasMouseMovedRef.current = true;
			}}
		>
			{selectedItem && (
				<span className="emdash-inline-ui-sr-only" role="status">
					Selected {selectedItem.title}
				</span>
			)}
			<div ref={viewportRef} className="emdash-slash-menu-viewport">
				{state.items.length === 0 ? (
					<p className="emdash-slash-menu-empty">No results</p>
				) : (
					groups.map((group) => (
						<div key={group.key} role="group" aria-label={state.query ? undefined : group.label}>
							{!state.query && (
								<div aria-hidden="true" className="emdash-slash-menu-group-label">
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
									className="emdash-slash-menu-item"
									onPointerDown={(event) => event.preventDefault()}
									onClick={() => onCommand(item)}
									onMouseEnter={() => {
										if (!hasMouseMovedRef.current || index === state.selectedIndex) return;
										pointerIndexRef.current = index;
										setSelectedIndex(index);
									}}
								>
									<item.icon className="emdash-slash-menu-icon" aria-hidden="true" />
									<span className="emdash-slash-menu-title">{item.title}</span>
									{item.markdown && (
										<span aria-hidden="true" className="emdash-slash-menu-markdown">
											<bdi dir="ltr">{item.markdown}</bdi>
										</span>
									)}
								</button>
							))}
						</div>
					))
				)}
			</div>
			<div className="emdash-slash-menu-footer">
				<span className="emdash-slash-menu-footer-text" aria-hidden="true">
					{selectedItem ? selectedItem.description : "Type to filter"}
				</span>
				<span className="emdash-slash-menu-esc" aria-hidden="true">
					<bdi dir="ltr">esc</bdi>
				</span>
			</div>
		</div>,
		uiRoot,
	);
}
