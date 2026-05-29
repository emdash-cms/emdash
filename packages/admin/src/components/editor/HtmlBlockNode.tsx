/**
 * HTML block node for the admin editor.
 *
 * Renders a first-class `htmlBlock` in the Portable Text editor with:
 * - A textarea for editing raw HTML source
 * - A "Preview" toggle that sanitizes and renders the HTML
 * - Selection ring, drag handle, and delete action
 *
 * Modeled on `PluginBlockNode.tsx` (atom node with React node view) and
 * the existing `{ _type: "htmlBlock", _key, html }` Portable Text shape
 * used by the WordPress and Contentful importers.
 *
 * The preview runs through DOMPurify so authors see what will actually
 * render, matching the server-side `sanitizeContent` in core.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { BracketsAngle, DotsSixVertical, Eye, PencilSimple, Trash } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import DOMPurify from "dompurify";
import * as React from "react";

import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Node View
// ---------------------------------------------------------------------------

function HtmlBlockNodeView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
	const { t } = useLingui();
	const html = typeof node.attrs.html === "string" ? node.attrs.html : "";
	const [showPreview, setShowPreview] = React.useState(false);
	const [draft, setDraft] = React.useState(html);
	const textareaRef = React.useRef<HTMLTextAreaElement>(null);

	// Sync draft when the stored html changes from outside the node view.
	React.useEffect(() => {
		if (!showPreview) {
			setDraft(html);
		}
	}, [html, showPreview]);

	// Auto-resize textarea to fit content.
	React.useEffect(() => {
		const el = textareaRef.current;
		if (el && !showPreview) {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, [draft, showPreview]);

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

	const sanitizedHtml = React.useMemo(() => DOMPurify.sanitize(html), [html]);

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
							<div className="text-xs text-kumo-subtle truncate font-mono">
								{html ? `${html.length} ${t`characters`}` : t`Empty`}
							</div>
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
								variant={showPreview ? "primary" : "ghost"}
								shape="square"
								className="h-8 w-8"
								onClick={() => setShowPreview((v) => !v)}
								title={showPreview ? t`Edit source` : t`Preview`}
								aria-label={showPreview ? t`Edit source` : t`Preview`}
							>
								{showPreview ? <PencilSimple className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
							</Button>
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
						{showPreview ? (
							html ? (
								<div
									className="prose prose-sm dark:prose-invert max-w-none rounded-md border bg-kumo-overlay p-4"
									// eslint-disable-next-line react/no-danger
									dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
								/>
							) : (
								<div className="rounded-md border bg-kumo-overlay p-4 text-sm text-kumo-subtle italic">
									{t`No HTML content to preview`}
								</div>
							)
						) : (
							<textarea
								ref={textareaRef}
								value={draft}
								onChange={handleChange}
								placeholder={t`Enter HTML...`}
								className="w-full min-h-[100px] resize-y rounded-md border bg-kumo-overlay p-3 font-mono text-sm text-kumo-strong placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-brand"
								spellCheck={false}
								aria-label={t`HTML source`}
							/>
						)}
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
		return {
			Backspace: () => {
				const { selection } = this.editor.state;
				const node = this.editor.state.doc.nodeAt(selection.from);
				if (node?.type.name === "htmlBlock") {
					this.editor.commands.deleteSelection();
					return true;
				}
				return false;
			},
			Delete: () => {
				const { selection } = this.editor.state;
				const node = this.editor.state.doc.nodeAt(selection.from);
				if (node?.type.name === "htmlBlock") {
					this.editor.commands.deleteSelection();
					return true;
				}
				return false;
			},
		};
	},
});
