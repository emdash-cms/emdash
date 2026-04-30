/**
 * EditorHeader
 *
 * Shared sticky header used by editor pages (Content, Content Type, Section,
 * Settings) so the primary save action is always visible at the top of the
 * page while users scroll through long forms.
 *
 * Why sticky:
 *   The main content area in `Shell` (`<main className="overflow-y-auto">`)
 *   is the scroll container. `position: sticky; top: 0` pins this header to
 *   the top of that container so the Save button stays in view.
 *
 * Accessibility:
 *   The sticky header is the *primary* save affordance for sighted/pointer
 *   users, but it doesn't replace a save action at the natural end of the
 *   form. Editor pages that use this header continue to render their existing
 *   bottom-of-form save button so keyboard and screen-reader users hit it as
 *   the last interactive control on the page (DOM order matches logical order).
 *
 * RTL:
 *   Avoids physical left/right Tailwind utilities. The component itself uses
 *   only symmetric horizontal utilities (`-mx-*`, `px-*`), which are
 *   direction-agnostic. Callers passing directional content into the
 *   `leading` / `actions` slots should use logical classes (`ms-*`, `me-*`,
 *   `start-*`, `end-*`) for any side-specific spacing or positioning.
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
	/**
	 * When `true`, the header sticks to the top of its scroll container.
	 * Defaults to `true`. Set to `false` to render a static header (e.g. when
	 * the parent wants to control positioning, or when the page itself is in
	 * a special mode like distraction-free).
	 */
	sticky?: boolean;
	className?: string;
}

/**
 * Sticky editor header with consistent placement of save / primary actions.
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
export function EditorHeader({
	leading,
	children,
	actions,
	sticky = true,
	className,
}: EditorHeaderProps) {
	return (
		<div
			data-editor-header
			className={cn(
				// Negative inline margins + padding cancel out the parent <main>'s
				// p-6 so the header background spans edge-to-edge of the scroll
				// container while still aligning content to the original gutter.
				sticky && "sticky top-0 z-30 -mx-6 -mt-6 px-6 pt-6",
				// Solid background so content scrolling behind doesn't bleed through.
				sticky && "bg-kumo-base/95 supports-[backdrop-filter]:bg-kumo-base/80 backdrop-blur",
				// Subtle separator + bottom padding so it visually detaches from form.
				sticky && "pb-3 mb-3 border-b border-kumo-line",
				"flex flex-wrap items-center justify-between gap-y-2 gap-x-4",
				className,
			)}
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
