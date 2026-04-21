/**
 * Document Outline
 *
 * Displays a tree structure of headings from the TipTap editor.
 * - Shows H1 at root, H2 indented, H3 further indented
 * - Click-to-navigate to heading position
 * - Highlights the current section based on cursor position
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, CaretRight, List } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

function getIndentClass(level: number) {
	switch (level) {
		case 1:
			return "pl-0";
		case 2:
			return "pl-4";
		case 3:
			return "pl-8";
		default:
			return "pl-0";
	}
}

function getTextClass(level: number) {
	switch (level) {
		case 1:
			return "font-medium";
		case 2:
			return "font-normal";
		case 3:
			return "font-normal text-kumo-subtle";
		default:
			return "font-normal";
	}
}

/**
 * Heading item extracted from editor document
 */
export interface HeadingItem {
	/** Heading level (1-3) */
	level: number;
	/** Heading text content */
	text: string;
	/** Position in document for navigation */
	pos: number;
	/** Unique key for React */
	key: string;
}

/**
 * Extract headings from the TipTap editor document
 */
export function extractHeadings(editor: Editor | null): HeadingItem[] {
	if (!editor) return [];

	const headings: HeadingItem[] = [];
	const doc = editor.state.doc;
	let key = 0;

	doc.descendants((node, pos) => {
		if (node.type.name === "heading") {
			const rawLevel = node.attrs.level;
			const level = typeof rawLevel === "number" ? rawLevel : 1;
			const text = node.textContent || "";
			if (text.trim()) {
				headings.push({
					level,
					text,
					pos,
					key: `heading-${key++}`,
				});
			}
		}
	});

	return headings;
}

/**
 * Find the current heading based on cursor position
 */
export function findCurrentHeading(headings: HeadingItem[], cursorPos: number): HeadingItem | null {
	if (headings.length === 0) return null;

	// Find the heading that contains or precedes the cursor
	let current: HeadingItem | null = null;
	for (const heading of headings) {
		if (heading.pos <= cursorPos) {
			current = heading;
		} else {
			break;
		}
	}

	return current;
}

export interface DocumentOutlineProps {
	/** TipTap editor instance */
	editor: Editor | null;
	/** Additional CSS classes */
	className?: string;
}

/**
 * Document outline component showing heading tree structure
 */
export function DocumentOutline({ editor, className }: DocumentOutlineProps) {
	const { t } = useLingui();
	const [isExpanded, setIsExpanded] = React.useState(true);
	const [headings, setHeadings] = React.useState<HeadingItem[]>([]);
	const [currentPos, setCurrentPos] = React.useState(0);

	// Extract headings when editor content changes
	React.useEffect(() => {
		if (!editor) return;

		const updateHeadings = () => {
			setHeadings(extractHeadings(editor));
		};

		// Initial extraction
		updateHeadings();

		// Update on content changes
		editor.on("update", updateHeadings);

		return () => {
			editor.off("update", updateHeadings);
		};
	}, [editor]);

	// Track cursor position for current section highlight
	React.useEffect(() => {
		if (!editor) return;

		const updatePosition = () => {
			const { from } = editor.state.selection;
			setCurrentPos(from);
		};

		// Initial position
		updatePosition();

		// Update on selection changes
		editor.on("selectionUpdate", updatePosition);

		return () => {
			editor.off("selectionUpdate", updatePosition);
		};
	}, [editor]);

	const currentHeading = findCurrentHeading(headings, currentPos);

	const handleHeadingClick = (heading: HeadingItem) => {
		if (!editor) return;

		// Navigate to heading and scroll into view
		editor.chain().focus().setTextSelection(heading.pos).scrollIntoView().run();
	};

	return (
		<div className={cn("space-y-2", className)}>
			<Button
				variant="ghost"
				size="sm"
				className="w-full justify-between px-2 h-8"
				onClick={() => setIsExpanded(!isExpanded)}
			>
				<span className="flex items-center gap-2">
					<List className="h-4 w-4" />
					<span className="font-semibold">{t`Outline`}</span>
				</span>
				{isExpanded ? <CaretDown className="h-4 w-4" /> : <CaretRight className="h-4 w-4" />}
			</Button>

			{isExpanded && (
				<div className="space-y-0.5">
					{headings.length === 0 ? (
						<p className="text-sm text-kumo-subtle px-2 py-1">{t`No headings in document`}</p>
					) : (
						headings.map((heading) => {
							const isCurrent = currentHeading?.key === heading.key;
							return (
								<button
									key={heading.key}
									type="button"
									onClick={() => handleHeadingClick(heading)}
									className={cn(
										"w-full text-left px-2 py-1 text-sm rounded transition-colors",
										"hover:bg-kumo-tint/50 cursor-pointer",
										"truncate",
										getIndentClass(heading.level),
										getTextClass(heading.level),
										isCurrent && "bg-kumo-tint text-kumo-default",
									)}
									title={heading.text}
								>
									{heading.text}
								</button>
							);
						})
					)}
				</div>
			)}
		</div>
	);
}
