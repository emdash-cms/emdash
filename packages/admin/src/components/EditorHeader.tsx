/**
 * EditorHeader
 *
 * Shared header used by editor pages (Content, Content Type, Section,
 * Settings) for consistent placement of a back-link / title / actions row.
 *
 * Renders as a normal block at the top of the page. The previous sticky
 * variant had transparency/z-index/layout bugs and added permanent visual
 * chrome; we now rely on each editor rendering an additional Save button
 * at the natural end of the form (DOM order matches logical order, so
 * keyboard / screen-reader users hit a save control as the last
 * interactive element) instead.
 *
 * RTL:
 *   The component itself uses only symmetric horizontal utilities
 *   (`flex`, `gap-*`), so it's direction-agnostic. Callers passing
 *   directional content into `leading` / `actions` slots should use
 *   logical classes (`ms-*`, `me-*`, `start-*`, `end-*`) for any
 *   side-specific spacing.
 */

import * as React from "react";

import { cn } from "../lib/utils";

export interface EditorHeaderProps {
	/** Optional leading element, typically a back-link or close button. */
	leading?: React.ReactNode;
	/** Header title content. Pass a heading element so semantics are correct. */
	children: React.ReactNode;
	/** Right-aligned action area (Save, Publish, etc.). */
	actions?: React.ReactNode;
	className?: string;
}

/**
 * Editor header with consistent placement of save / primary actions.
 *
 * Usage:
 *
 *   <EditorHeader
 *       leading={<BackLink />}
 *       actions={<SaveButton ... />}
 *   >
 *       <h1 className="text-2xl font-bold">{title}</h1>
 *   </EditorHeader>
 */
export function EditorHeader({ leading, children, actions, className }: EditorHeaderProps) {
	return (
		<div
			data-editor-header
			className={cn("flex flex-wrap items-center justify-between gap-y-2 gap-x-4", className)}
		>
			<div className="flex items-center gap-4 min-w-0">
				{leading}
				<div className="min-w-0">{children}</div>
			</div>
			{actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
		</div>
	);
}

export default EditorHeader;
