/**
 * HTML block node for the admin editor.
 *
 * A card with a code editor for each of the block's fields (HTML, and CSS and
 * JavaScript while the block renders in an isolated frame) and a menu that
 * switches how the site renders it. Round-trips through Portable Text as
 * `{ _type: "htmlBlock", _key, html, css?, js?, isolated? }`.
 */

import { DropdownMenu } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Eye, FileCss, FileHtml, FileJs } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import * as React from "react";

import type { CodeEditorLanguage } from "./CodeEditor";
import {
	CLIPBOARD_TOKEN,
	EmbedBlockCard,
	EmbedCodeEditor,
	embedBlockKeyboardShortcuts,
	embedBlockNodeView,
	useEmbedBlockFocus,
	type EmbedBlockTab,
} from "./EmbedBlockShell";
import { HtmlBlockPreview } from "./HtmlBlockPreview";

export { TopBlockDocument } from "./EmbedBlockShell";

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

const PREVIEW_TAB: EmbedBlockTab = { value: "preview", label: PREVIEW_LABEL, Icon: Eye };

const isEmpty = (attrs: Record<string, unknown>) =>
	FIELDS.every((field) => !fieldValue(attrs, field));

function HtmlBlockNodeView({ editor, node, getPos, updateAttributes, selected }: NodeViewProps) {
	const { t } = useLingui();
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

	const focus = useEmbedBlockFocus({ editor, getPos, flush, isEmpty });

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

	const handleChange = (field: Field, value: string) => {
		setAllowScripts(true);
		pending.current[field] = value;
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(flush, WRITE_DELAY_MS);
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

	const tabs = [
		...(isolated ? FIELDS : (["html"] as const)).map((field) => ({ value: field, ...TABS[field] })),
		PREVIEW_TAB,
	];

	return (
		<EmbedBlockCard
			className="html-block"
			selected={selected}
			editable={editable}
			tabs={tabs}
			activeTab={activeTab}
			onTabChange={handleTabChange}
			menuLabel={t`HTML block options`}
			menu={
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
			}
			onDelete={focus.deleteBlock}
			focus={focus}
		>
			{activeTab === "preview" ? (
				<HtmlBlockPreview
					{...values}
					isolated={isolated}
					allowScripts={allowScripts}
					onRun={() => {
						setAllowScripts(true);
						focus.panelRef.current?.focus();
					}}
					lastHeight={previewHeight}
				/>
			) : (
				<EmbedCodeEditor
					// The HTML tab's placeholder depends on the mode.
					key={`${activeTab}-${isolated}-${revisions[activeTab]}`}
					language={TABS[activeTab].language}
					value={values[activeTab]}
					onChange={(value) => handleChange(activeTab, value)}
					onFocusChange={focus.onFocusChange}
					onEscape={focus.onEscape}
					editable={editable}
					autoFocus={focus.autoFocus}
					ariaLabel={t(TABS[activeTab].editorLabel)}
					placeholder={t(
						activeTab === "html" && isolated
							? ISOLATED_HTML_PLACEHOLDER
							: TABS[activeTab].placeholder,
					)}
				/>
			)}
		</EmbedBlockCard>
	);
}

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
				// Blocks pasted from other pages render inline, so their scripts don't run on the site.
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
		return embedBlockNodeView(this.editor, HtmlBlockNodeView);
	},

	addKeyboardShortcuts() {
		return embedBlockKeyboardShortcuts(this.type);
	},
});
