/**
 * Section Reference Node for TipTap
 *
 * Renders a synced section reference block in the editor. Unlike inserting a
 * section as a copy, a section reference stores only the section ID. The
 * section's current content is resolved at render time on the front-end,
 * meaning updates to the section propagate everywhere it is referenced.
 */

import { DotsSixVertical, Trash, ArrowSquareOut, Link } from "@phosphor-icons/react";
import { Node, mergeAttributes } from "@tiptap/core";
import type { NodeViewProps } from "@tiptap/react";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * React component for the section reference node view
 */
function SectionRefNodeView({ node, selected, deleteNode }: NodeViewProps) {
	const sectionId = typeof node.attrs.sectionId === "string" ? node.attrs.sectionId : "";
	const sectionTitle =
		typeof node.attrs.sectionTitle === "string" ? node.attrs.sectionTitle : sectionId;

	return (
		<NodeViewWrapper
			className={cn(
				"section-ref-block relative my-3",
				selected && "ring-2 ring-kumo-brand ring-offset-2 rounded-lg",
			)}
			contentEditable={false}
			data-drag-handle
		>
			<div className="relative group">
				{/* Drag handle */}
				<div
					className={cn(
						"absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing",
						selected && "opacity-100",
					)}
					data-drag-handle
				>
					<DotsSixVertical className="h-5 w-5 text-kumo-subtle/50" />
				</div>

				{/* Block */}
				<div
					className={cn(
						"rounded-lg border bg-kumo-base transition-colors",
						selected ? "border-kumo-brand/50 bg-kumo-tint/30" : "hover:border-kumo-line",
					)}
				>
					<div className="flex items-center gap-3 px-4 py-3">
						{/* Icon */}
						<div className="flex-shrink-0 w-10 h-10 rounded-lg bg-kumo-tint flex items-center justify-center text-kumo-brand">
							<Link className="h-5 w-5" />
						</div>

						{/* Label */}
						<div className="flex-1 min-w-0">
							<div className="text-sm font-medium truncate">{sectionTitle}</div>
							<div className="flex items-center gap-1 mt-0.5">
								<span className="inline-flex items-center rounded-full bg-kumo-brand/10 px-2 py-0.5 text-xs font-medium text-kumo-brand">
									Synced section
								</span>
							</div>
						</div>

						{/* Actions */}
						<div
							className={cn(
								"flex items-center gap-1 transition-opacity",
								selected ? "opacity-100" : "opacity-0 group-hover:opacity-100",
							)}
						>
							<a
								href={`/_emdash/admin/sections`}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center justify-center h-8 w-8 rounded hover:bg-kumo-tint text-kumo-subtle hover:text-kumo-text transition-colors"
								title="Open Sections library"
								aria-label="Open Sections library"
								onClick={(e) => e.stopPropagation()}
							>
								<ArrowSquareOut className="h-4 w-4" />
							</a>
							<button
								type="button"
								className="inline-flex items-center justify-center h-8 w-8 rounded hover:bg-kumo-danger/10 text-kumo-subtle hover:text-kumo-danger transition-colors"
								onClick={() => deleteNode()}
								title="Remove reference"
								aria-label="Remove section reference"
							>
								<Trash className="h-4 w-4" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</NodeViewWrapper>
	);
}

/**
 * TipTap Node extension for section references
 */
export const SectionRefExtension = Node.create({
	name: "sectionRef",
	group: "block",
	atom: true,
	draggable: true,
	selectable: true,

	addAttributes() {
		return {
			sectionId: {
				default: "",
			},
			sectionTitle: {
				default: "",
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "div[data-section-ref]",
				getAttrs: (el: HTMLElement) => ({
					sectionId: el.getAttribute("data-section-id") ?? "",
					sectionTitle: el.getAttribute("data-section-title") ?? "",
				}),
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-section-ref": "",
				"data-section-id": HTMLAttributes.sectionId,
				"data-section-title": HTMLAttributes.sectionTitle,
			}),
		];
	},

	addNodeView() {
		return ReactNodeViewRenderer(SectionRefNodeView);
	},

	addKeyboardShortcuts() {
		return {
			Backspace: () => {
				const { selection } = this.editor.state;
				const node = this.editor.state.doc.nodeAt(selection.from);
				if (node?.type.name === "sectionRef") {
					this.editor.commands.deleteSelection();
					return true;
				}
				return false;
			},
			Delete: () => {
				const { selection } = this.editor.state;
				const node = this.editor.state.doc.nodeAt(selection.from);
				if (node?.type.name === "sectionRef") {
					this.editor.commands.deleteSelection();
					return true;
				}
				return false;
			},
		};
	},
});
