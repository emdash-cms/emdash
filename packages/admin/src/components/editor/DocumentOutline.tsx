/**
 * Document Outline
 *
 * Displays a tree structure of headings from the TipTap editor.
 * - Shows H1 at root, H2 indented, H3 further indented
 * - Click-to-navigate to heading position
 * - Highlights the current section based on cursor position
 */

import { Button, Collapsible, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";

function getIndentClass(level: number) {
	switch (level) {
		case 1:
			return "ps-2";
		case 2:
			return "ps-6";
		case 3:
			return "ps-10";
		default:
			return "ps-2";
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
		<Collapsible.Root className={className} open={isExpanded} onOpenChange={setIsExpanded}>
			<Collapsible.Trigger
				render={
					<Button
						variant="ghost"
						className="relative justify-between"
						style={{ width: "calc(100% + 1.5rem)", insetInlineStart: "-0.75rem" }}
					/>
				}
			>
				<Text bold as="span">
					{t`Outline`}
				</Text>
				<CaretDown
					className={cn(
						"h-4 w-4 text-kumo-subtle transition-transform duration-150 ease-out motion-reduce:transition-none",
						isExpanded && "rotate-180",
					)}
				/>
			</Collapsible.Trigger>

			<Collapsible.Panel
				className="-mx-2 overflow-hidden duration-150 ease-out [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none"
				style={({ transitionStatus }) => ({
					height:
						transitionStatus === "starting" || transitionStatus === "ending"
							? 0
							: "var(--collapsible-panel-height)",
					transitionProperty: "height",
				})}
			>
				<div className="space-y-0.5 pt-2">
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
										"w-full text-start px-2 py-1 text-sm rounded-md transition-colors",
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
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
