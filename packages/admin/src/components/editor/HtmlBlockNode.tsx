/**
 * HTML block node for the admin editor.
 *
 * Renders a first-class `htmlBlock` in the Portable Text editor with:
 * - A textarea for editing raw HTML source
 * - Selection ring, drag handle, and delete action
 *
 * Modeled on `PluginBlockNode.tsx` (atom node with React node view) and
 * the existing `{ _type: "htmlBlock", _key, html }` Portable Text shape
 * used by the WordPress and Contentful importers.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { BracketsAngle, DotsSixVertical, Trash } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when focus is inside a text input or textarea (e.g. the HTML block's
 * source <textarea>). Editor-level keyboard shortcuts must defer to native
 * field editing in that case.
 */
function isEditingFormField(): boolean {
	if (typeof document === "undefined") return false;
	const active = document.activeElement;
	if (!active) return false;
	const tag = active.tagName;
	return tag === "TEXTAREA" || tag === "INPUT";
}

// ---------------------------------------------------------------------------
// Node View
// ---------------------------------------------------------------------------

function HtmlBlockNodeView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
	const { t } = useLingui();
	const html = typeof node.attrs.html === "string" ? node.attrs.html : "";
	const [draft, setDraft] = React.useState(html);
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);

	// Sync draft when the stored html changes from outside the node view.
	React.useEffect(() => {
		setDraft(html);
	}, [html]);

	// Auto-resize textarea to fit content.
	React.useEffect(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, [draft]);

	const commitHtml = React.useCallback(
		(value: string) => {
			updateAttributes({ html: value });
		},
		[updateAttributes],
	);

	const handleChange = React.useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setDraft(e.target.value);
			commitHtml(e.target.value);
		},
		[commitHtml],
	);

	return (
		<NodeViewWrapper
			className={cn(
				"html-block relative my-3",
				selected && "ring-2 ring-kumo-brand ring-offset-2 rounded-lg",
			)}
			contentEditable={false}
			data-drag-handle
		>
			<div className="relative group">
				{/* Drag handle */}
				<div
					className={cn(
						"absolute -start-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing",
						selected && "opacity-100",
					)}
					data-drag-handle
				>
					<DotsSixVertical className="h-5 w-5 text-kumo-subtle/50" />
				</div>

				{/* Main block */}
				<div
					className={cn(
						"rounded-lg border bg-kumo-base transition-colors overflow-hidden",
						selected ? "border-kumo-brand/50 bg-kumo-tint/30" : "hover:border-kumo-line",
					)}
				>
					{/* Header */}
					<div className="flex items-center gap-3 px-4 py-3">
						<div className="flex-shrink-0 w-10 h-10 rounded-lg bg-kumo-tint flex items-center justify-center text-kumo-subtle">
							<BracketsAngle className="h-5 w-5" />
						</div>

						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium">{t`HTML`}</div>
						</div>

						{/* Actions */}
						<div
							className={cn(
								"flex items-center gap-1 transition-opacity",
								selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							<Button
								type="button"
								variant="ghost"
								shape="square"
								className="h-8 w-8 text-kumo-danger hover:text-kumo-danger hover:bg-kumo-danger/10"
								onClick={() => deleteNode()}
								title={t`Delete`}
								aria-label={t`Delete HTML block`}
							>
								<Trash className="h-4 w-4" />
							</Button>
						</div>
					</div>

					{/* Content area */}
					<div className="px-4 pb-4">
						<textarea
							ref={textareaRef}
							value={draft}
							onChange={handleChange}
							placeholder={t`Enter HTML...`}
							className="w-full min-h-[100px] resize-y rounded-md border bg-kumo-overlay p-3 font-mono text-sm text-kumo-strong placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-brand"
							spellCheck={false}
							aria-label={t`HTML source`}
						/>
					</div>
				</div>
			</div>
		</NodeViewWrapper>
	);
}

// ---------------------------------------------------------------------------
// TipTap Extension
// ---------------------------------------------------------------------------

/**
 * TipTap extension: first-class HTML block.
 *
 * An atom node that stores raw HTML in a `html` attribute. Round-trips
 * through Portable Text as `{ _type: "htmlBlock", _key, html }`.
 */
export const HtmlBlockExtension = Node.create({
	name: "htmlBlock",
	group: "block",
	atom: true,
	draggable: true,
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
		return ReactNodeViewRenderer(HtmlBlockNodeView);
	},

	addKeyboardShortcuts() {
		const deleteHtmlBlock = () => {
			// Don't hijack Backspace/Delete while the user is editing the source
			// in the nested <textarea> -- let the native field handle the keystroke.
			if (isEditingFormField()) return false;
			const { selection } = this.editor.state;
			const node = this.editor.state.doc.nodeAt(selection.from);
			if (node?.type.name === "htmlBlock") {
				this.editor.commands.deleteSelection();
				return true;
			}
			return false;
		};
		return {
			Backspace: deleteHtmlBlock,
			Delete: deleteHtmlBlock,
		};
	},
});
