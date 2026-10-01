/**
 * HTML block node for the admin editor.
 *
 * A card with a code editor for each of the block's fields (HTML, and CSS and
 * JavaScript while the block renders in an isolated frame) and a menu that
 * switches how the site renders it. Round-trips through Portable Text as
 * `{ _type: "htmlBlock", _key, html, css?, js?, isolated? }`.
 */

import { Button, DropdownMenu, Tabs } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { DotsThreeVertical, Eye, FileCss, FileHtml, FileJs, Trash } from "@phosphor-icons/react";
import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { NodeType } from "@tiptap/pm/model";
import { NodeSelection, Selection } from "@tiptap/pm/state";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { getLocaleDir } from "../../locales/config.js";
import type { CodeEditorLanguage } from "./CodeEditor";
import { HtmlBlockPreview } from "./HtmlBlockPreview";

const CodeEditor = React.lazy(() => import("./CodeEditor"));

type Field = "html" | "css" | "js";
type Tab = Field | "preview";

const FIELDS: readonly Field[] = ["html", "css", "js"];
const PREVIEW_LABEL = msg`Preview`;
const WRITE_DELAY_MS = 250;

const TABS: Record<
	Field,
	{
		label: MessageDescriptor;
		editorLabel: MessageDescriptor;
		placeholder: MessageDescriptor;
		language: CodeEditorLanguage;
		Icon: typeof FileHtml;
	}
> = {
	html: {
		label: msg`HTML`,
		editorLabel: msg`HTML code`,
		placeholder: msg`Write HTML…`,
		language: "html",
		Icon: FileHtml,
	},
	css: {
		label: msg`CSS`,
		editorLabel: msg`CSS code`,
		placeholder: msg`Write CSS…`,
		language: "css",
		Icon: FileCss,
	},
	js: {
		label: msg`JS`,
		editorLabel: msg`JavaScript code`,
		placeholder: msg`Write JavaScript…`,
		language: "javascript",
		Icon: FileJs,
	},
};

// Isolated blocks run the HTML tab as written, so a whole snippet works there.
const ISOLATED_HTML_PLACEHOLDER = msg`Write HTML, or paste a snippet with its styles and scripts…`;

function isTab(value: string): value is Tab {
	return value === "preview" || (FIELDS as readonly string[]).includes(value);
}

function fieldValue(attrs: Record<string, unknown>, field: Field): string {
	const value = attrs[field];
	return typeof value === "string" ? value : "";
}

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

/** Focus an element inside the node-selected HTML block. */
function focusInSelectedBlock(editor: Editor, type: NodeType, selector: string): boolean {
	const { selection } = editor.state;
	if (!(selection instanceof NodeSelection) || selection.node.type !== type) return false;
	const dom = editor.view.nodeDOM(selection.from);
	const target = dom instanceof HTMLElement ? dom.querySelector<HTMLElement>(selector) : null;
	target?.focus();
	return target !== null && document.activeElement === target;
}

const SELECTED_TAB = "[role='tab'][aria-selected='true']";

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

function HtmlBlockNodeView({ editor, node, getPos, updateAttributes, selected }: NodeViewProps) {
	const { t, i18n } = useLingui();
	const editable = editor.isEditable;
	const isolated = node.attrs.isolated === true;
	const values: Record<Field, string> = {
		html: fieldValue(node.attrs, "html"),
		css: fieldValue(node.attrs, "css"),
		js: fieldValue(node.attrs, "js"),
	};

	// New blocks open on HTML and saved blocks on Preview. A saved block with
	// scripts waits for Run preview, so a broken script can't freeze the editor.
	const [tab, setTab] = React.useState<Tab>(() =>
		FIELDS.some((field) => values[field]) ? "preview" : "html",
	);
	const activeTab: Tab = isolated || tab === "html" ? tab : "preview";
	const [allowScripts, setAllowScripts] = React.useState(() =>
		FIELDS.every((field) => !values[field]),
	);
	const previewHeight = React.useRef(128);
	const [revisions, setRevisions] = React.useState<Record<Field, number>>({
		html: 0,
		css: 0,
		js: 0,
	});
	const [autoFocus, setAutoFocus] = React.useState(false);
	const cardRef = React.useRef<HTMLDivElement>(null);
	const panelRef = React.useRef<HTMLDivElement>(null);
	const pending = React.useRef<Partial<Record<Field, string>>>({});
	const known = React.useRef(values);
	const timer = React.useRef<number | undefined>(undefined);

	// Each write replaces the node and converts the whole document, so edits
	// are held briefly and written together.
	const flush = React.useCallback(() => {
		window.clearTimeout(timer.current);
		const changes = pending.current;
		if (Object.keys(changes).length === 0) return;
		// Edits that can't be written now wait for the next flush.
		if (editor.isDestroyed || !editor.isEditable || typeof getPos() !== "number") return;
		pending.current = {};
		Object.assign(known.current, changes);
		updateAttributes(changes);
	}, [editor, getPos, updateAttributes]);

	// Toolbar buttons keep focus in the code editor, so write pending edits
	// before any press outside it runs its action.
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

	// Undo, redo and other tools change the attributes directly. Show their
	// value and drop the edit waiting to be written.
	const { html, css, js } = values;
	React.useEffect(() => {
		const current: Record<Field, string> = { html, css, js };
		const changed = FIELDS.filter((field) => current[field] !== known.current[field]);
		if (changed.length === 0) return;
		for (const field of changed) {
			known.current[field] = current[field];
			delete pending.current[field];
		}
		setRevisions((revision) => {
			const next = { ...revision };
			for (const field of changed) next[field] += 1;
			return next;
		});
	}, [html, css, js]);

	// A new block takes focus once TipTap has finished focusing the editor, so
	// the first keystroke can't replace the node-selected block.
	React.useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const pos = getPos();
			const { selection } = editor.state;
			if (!editor.isEditable || typeof pos !== "number") return;
			if (!(selection instanceof NodeSelection) || selection.from !== pos) return;
			if (FIELDS.some((field) => fieldValue(selection.node.attrs, field))) return;
			panelRef.current?.focus();
			setAutoFocus(true);
		});
		return () => cancelAnimationFrame(frame);
	}, [editor, getPos]);

	const handleChange = (field: Field, value: string) => {
		setAllowScripts(true);
		pending.current[field] = value;
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(flush, WRITE_DELAY_MS);
	};

	// Toolbar actions then insert beside the block instead of replacing it.
	// The selection goes to a gap cursor before a following atom or table,
	// since the toolbar disables inserts inside tables, or else to the start
	// of the next text.
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

	const handleFocusChange = (focused: boolean) => {
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

	const selectBlock = () => {
		const pos = getPos();
		if (typeof pos !== "number") return;
		editor.commands.setNodeSelection(pos);
		editor.view.focus();
	};

	const handleEscape = () => {
		flush();
		selectBlock();
	};

	const handleTabChange = (value: string) => {
		if (!isTab(value)) return;
		flush();
		setTab(value);
	};

	const setIsolated = (value: string) => {
		flush();
		updateAttributes({ isolated: value === "isolated" });
	};

	const deleteBlock = () => {
		flush();
		const pos = getPos();
		if (typeof pos !== "number") return;
		editor.view.focus();
		editor.chain().setNodeSelection(pos).deleteSelection().run();
	};

	const tabs: readonly Tab[] = isolated ? [...FIELDS, "preview"] : ["html", "preview"];

	return (
		<NodeViewWrapper className="html-block not-prose my-3" contentEditable={false}>
			{/* The editor's content takes its direction from the text; the card's
			    controls follow the interface, as their arrow keys already do. */}
			<div
				dir={getLocaleDir(i18n.locale)}
				ref={cardRef}
				className={cn(
					"overflow-hidden rounded-lg border border-kumo-line bg-kumo-base focus-within:border-kumo-brand",
					selected && "ring-2 ring-kumo-brand",
				)}
			>
				<div className="flex items-center gap-2 p-1.5">
					<Tabs
						variant="segmented"
						size="sm"
						activateOnFocus
						value={activeTab}
						onValueChange={handleTabChange}
						tabs={tabs.map((value) => {
							const { label, Icon } =
								value === "preview" ? { label: PREVIEW_LABEL, Icon: Eye } : TABS[value];
							return {
								value,
								label: (
									<span className="flex items-center gap-1">
										<Icon className="size-3.5" aria-hidden="true" />
										<span className="max-sm:sr-only">{t(label)}</span>
									</span>
								),
							};
						})}
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
										aria-label={t`HTML block options`}
									>
										<DotsThreeVertical className="size-4" aria-hidden="true" />
									</Button>
								}
							/>
							<DropdownMenu.Content>
								<DropdownMenu.Group>
									<DropdownMenu.Label>{t`On the site`}</DropdownMenu.Label>
									<DropdownMenu.RadioGroup
										value={isolated ? "isolated" : "inline"}
										onValueChange={setIsolated}
									>
										<DropdownMenu.RadioItem value="isolated" closeOnClick>
											<span className="flex flex-col">
												{t`Isolated frame`}
												<span className="text-xs text-kumo-subtle">
													{t`Runs HTML, CSS and JavaScript in a sandbox.`}
												</span>
											</span>
										</DropdownMenu.RadioItem>
										<DropdownMenu.RadioItem value="inline" closeOnClick>
											<span className="flex flex-col">
												{t`Inline`}
												<span className="text-xs text-kumo-subtle">
													{t`HTML only, cleaned, using your site's styles.`}
												</span>
											</span>
										</DropdownMenu.RadioItem>
									</DropdownMenu.RadioGroup>
								</DropdownMenu.Group>
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									variant="danger"
									icon={<Trash className="size-4" aria-hidden="true" />}
									onClick={deleteBlock}
								>
									{t`Delete block`}
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu>
					)}
				</div>
				<div
					ref={panelRef}
					role="tabpanel"
					aria-label={t(activeTab === "preview" ? PREVIEW_LABEL : TABS[activeTab].label)}
					tabIndex={-1}
					className="border-t border-kumo-line outline-none"
					onBlur={(event) => {
						if (!event.currentTarget.contains(event.relatedTarget)) setAutoFocus(false);
					}}
				>
					{activeTab === "preview" ? (
						<HtmlBlockPreview
							{...values}
							isolated={isolated}
							allowScripts={allowScripts}
							onRun={() => {
								setAllowScripts(true);
								panelRef.current?.focus();
							}}
							lastHeight={previewHeight}
						/>
					) : (
						<CodeEditorBoundary fallback={<CodeEditorLoadError />}>
							<React.Suspense fallback={<div className="h-40" />}>
								<CodeEditor
									// The HTML tab's placeholder depends on the mode.
									key={`${activeTab}-${isolated}-${revisions[activeTab]}`}
									language={TABS[activeTab].language}
									value={values[activeTab]}
									onChange={(value) => handleChange(activeTab, value)}
									onFocusChange={handleFocusChange}
									onEscape={handleEscape}
									editable={editable}
									autoFocus={autoFocus}
									ariaLabel={t(TABS[activeTab].editorLabel)}
									placeholder={t(
										activeTab === "html" && isolated
											? ISOLATED_HTML_PLACEHOLDER
											: TABS[activeTab].placeholder,
									)}
								/>
							</React.Suspense>
						</CodeEditorBoundary>
					)}
				</div>
			</div>
		</NodeViewWrapper>
	);
}

// Other pages and tabs can't know this, so blocks pasted from them render inline and
// their scripts don't run on the site.
const CLIPBOARD_TOKEN = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
	n.toString(36),
).join("");

/**
 * TipTap extension: first-class HTML block.
 *
 * A top-level atom. The editor's global drag handle moves it.
 */
export const HtmlBlockExtension = Node.create({
	name: "htmlBlock",
	group: "topBlock",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			html: {
				default: "",
				// Store the raw markup in a semantic `data-html-content` attribute
				// rather than leaking it as a bare `html="..."` attribute on every
				// DOM/clipboard serialization (drag, copy, paste).
				parseHTML: (element) => element.getAttribute("data-html-content") ?? "",
				renderHTML: (attributes) => {
					const html = typeof attributes.html === "string" ? attributes.html : "";
					if (!html) return {};
					return { "data-html-content": html };
				},
			},
			css: {
				default: "",
				parseHTML: (element) => element.getAttribute("data-html-css") ?? "",
				renderHTML: (attributes) =>
					typeof attributes.css === "string" && attributes.css
						? { "data-html-css": attributes.css }
						: {},
			},
			js: {
				default: "",
				parseHTML: (element) => element.getAttribute("data-html-js") ?? "",
				renderHTML: (attributes) =>
					typeof attributes.js === "string" && attributes.js
						? { "data-html-js": attributes.js }
						: {},
			},
			isolated: {
				default: false,
				parseHTML: (element) => element.getAttribute("data-html-isolated") === CLIPBOARD_TOKEN,
				renderHTML: (attributes) =>
					attributes.isolated === true ? { "data-html-isolated": CLIPBOARD_TOKEN } : {},
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "div[data-html-block]",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-html-block": "" })];
	},

	addNodeView() {
		const { editor } = this;
		return ReactNodeViewRenderer(HtmlBlockNodeView, {
			stopEvent: ({ event }) => stopEvent(event, editor.view.dragging !== null),
		});
	},

	addKeyboardShortcuts() {
		return {
			// Enter goes back into the selected block's code editor, and Tab to
			// its tabs, so keyboard users can reach any block's controls.
			Enter: ({ editor }) =>
				focusInSelectedBlock(editor, this.type, ".cm-content") ||
				focusInSelectedBlock(editor, this.type, SELECTED_TAB),
			Tab: ({ editor }) => focusInSelectedBlock(editor, this.type, SELECTED_TAB),
		};
	},
});
