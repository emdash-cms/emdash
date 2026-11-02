/**
 * Document Outline
 *
 * Lists the TipTap editor's headings as a nested outline.
 * - Nesting follows the document's heading structure, so skipped levels don't leave gaps
 * - Clicking a heading moves the caret into it and scrolls it to the top of the editor
 * - The heading of the section at the top of the editor is marked as current
 */

import { Button, Collapsible, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/react";
import * as React from "react";

import { cn } from "../../lib/utils";
import { useSidebar } from "../Sidebar";

/**
 * Heading item extracted from editor document
 */
export interface HeadingItem {
	/** Heading level (1-6) */
	level: number;
	/** Number of enclosing headings, which sets the outline indent */
	depth: number;
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
	const openLevels: number[] = [];

	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "heading") {
			const rawLevel = node.attrs.level;
			const level = typeof rawLevel === "number" ? rawLevel : 1;
			const text = node.textContent || "";
			if (text.trim()) {
				while ((openLevels.at(-1) ?? 0) >= level) openLevels.pop();
				headings.push({
					level,
					depth: openLevels.length,
					text,
					pos,
					key: `heading-${headings.length}`,
				});
				openLevels.push(level);
			}
		}
		return !node.isTextblock;
	});

	return headings;
}

/**
 * Index of the last heading whose top has reached the reading line, or -1 above the first one
 */
export function findCurrentHeadingIndex(headingTops: number[], readingLine: number): number {
	let current = -1;
	for (const [index, top] of headingTops.entries()) {
		if (top > readingLine) break;
		current = index;
	}
	return current;
}

function getScrollParent(element: HTMLElement): HTMLElement {
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const { overflowY } = getComputedStyle(parent);
		if (overflowY === "auto" || overflowY === "scroll") return parent;
	}
	return document.documentElement;
}

function getViewportTop(scroller: HTMLElement): number {
	return scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top;
}

/** The space the editor keeps clear above the caret for its sticky toolbar. */
function getScrollMarginTop(editor: Editor): number {
	const margin = editor.view.someProp("scrollMargin");
	return typeof margin === "number" ? margin : (margin?.top ?? 0);
}

function getHeadingElement(editor: Editor, heading: HeadingItem): HTMLElement | null {
	const dom = editor.view.nodeDOM(heading.pos);
	return dom instanceof HTMLElement ? dom : null;
}

interface ScrollPin {
	element: HTMLElement;
	scroller: HTMLElement;
	scrollTop: number;
}

/**
 * A clicked heading stays current until the editor scrolls away from it, even when it sits
 * too close to the end of the document to reach the reading line.
 */
function findPinnedHeadingKey(
	editor: Editor,
	headings: HeadingItem[],
	pin: ScrollPin,
): string | null {
	if (Math.abs(pin.scroller.scrollTop - pin.scrollTop) >= 1) return null;
	return (
		headings.find((heading) => getHeadingElement(editor, heading) === pin.element)?.key ?? null
	);
}

function findCurrentHeadingKey(editor: Editor, headings: HeadingItem[]): string | null {
	if (headings.length === 0) return null;
	const readingLine =
		getViewportTop(getScrollParent(editor.view.dom)) + getScrollMarginTop(editor) + 1;
	const tops = headings.map(
		(heading) => getHeadingElement(editor, heading)?.getBoundingClientRect().top ?? Infinity,
	);
	return headings[findCurrentHeadingIndex(tops, readingLine)]?.key ?? null;
}

export interface DocumentOutlineProps {
	/** TipTap editor instance */
	editor: Editor | null;
	/** Additional CSS classes */
	className?: string;
	/** Reserve the inline end of the disclosure header for an external control. */
	reserveHeaderEnd?: boolean;
}

/**
 * Document outline component showing heading tree structure
 */
export function DocumentOutline({
	editor,
	className,
	reserveHeaderEnd = false,
}: DocumentOutlineProps) {
	const { t } = useLingui();
	const { isMobile, setOpenMobile } = useSidebar();
	const [isExpanded, setIsExpanded] = React.useState(true);
	const [headings, setHeadings] = React.useState<HeadingItem[]>([]);
	const [currentKey, setCurrentKey] = React.useState<string | null>(null);
	const headingsRef = React.useRef<HeadingItem[]>([]);
	const pinRef = React.useRef<ScrollPin | null>(null);
	const pointerTypeRef = React.useRef<string | null>(null);

	React.useEffect(() => {
		pinRef.current = null;
		headingsRef.current = [];
		if (!editor) return;

		let frame = 0;
		const updateCurrent = () => {
			frame = 0;
			if (editor.isDestroyed) return;
			const pin = pinRef.current;
			const pinnedKey = pin && findPinnedHeadingKey(editor, headingsRef.current, pin);
			if (!pinnedKey) pinRef.current = null;
			setCurrentKey(pinnedKey ?? findCurrentHeadingKey(editor, headingsRef.current));
		};
		const scheduleCurrent = () => {
			if (!frame) frame = requestAnimationFrame(updateCurrent);
		};
		const updateHeadings = () => {
			const next = extractHeadings(editor);
			headingsRef.current = next;
			setHeadings(next);
			scheduleCurrent();
		};

		updateHeadings();
		editor.on("update", updateHeadings);
		// Scroll events don't bubble; capturing them on the document catches the editor's
		// scroll container wherever it is.
		document.addEventListener("scroll", scheduleCurrent, { capture: true, passive: true });
		window.addEventListener("resize", scheduleCurrent);
		// Headings also move without scrolling, as images load or the settings panel is resized.
		const resizeObserver = new ResizeObserver(scheduleCurrent);
		resizeObserver.observe(editor.view.dom);

		return () => {
			cancelAnimationFrame(frame);
			editor.off("update", updateHeadings);
			document.removeEventListener("scroll", scheduleCurrent, { capture: true });
			window.removeEventListener("resize", scheduleCurrent);
			resizeObserver.disconnect();
		};
	}, [editor]);

	const currentIndex = headings.findIndex((heading) => heading.key === currentKey);
	// The indicator slides between headings, but appears in place after being hidden.
	const [indicator, setIndicator] = React.useState({ index: -1, slide: false });
	const [previousIndex, setPreviousIndex] = React.useState(-1);
	if (currentIndex !== previousIndex) {
		setPreviousIndex(currentIndex);
		if (currentIndex !== -1) setIndicator({ index: currentIndex, slide: previousIndex !== -1 });
	}

	const handleHeadingClick = (heading: HeadingItem, event: React.MouseEvent) => {
		// Keyboard activation clicks with a detail of 0 and no pointer.
		const pointerType = event.detail > 0 ? pointerTypeRef.current : null;
		pointerTypeRef.current = null;
		if (!editor || editor.isDestroyed) return;

		// The heading's own position is between blocks; one step in is the start of its text.
		const chain = editor.chain().setTextSelection(heading.pos + 1);
		// Focusing the editor from a tap raises the on-screen keyboard over the heading.
		if (pointerType === "touch" || pointerType === "pen") chain.run();
		else chain.focus(undefined, { scrollIntoView: false }).run();
		if (isMobile) setOpenMobile(false);

		const element = getHeadingElement(editor, heading);
		if (!element) return;
		const scroller = getScrollParent(editor.view.dom);
		scroller.scrollTop +=
			element.getBoundingClientRect().top - getViewportTop(scroller) - getScrollMarginTop(editor);
		pinRef.current = { element, scroller, scrollTop: scroller.scrollTop };
		setCurrentKey(heading.key);
	};

	return (
		<Collapsible.Root className={className} open={isExpanded} onOpenChange={setIsExpanded}>
			<Collapsible.Trigger
				render={
					<Button
						variant="ghost"
						className="relative justify-between"
						style={{
							width: reserveHeaderEnd ? "calc(100% - 1.5rem)" : "calc(100% + 1.5rem)",
							insetInlineStart: "-0.75rem",
						}}
					/>
				}
			>
				<Text as="span" DANGEROUS_className="font-semibold">
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
				className="overflow-hidden duration-150 ease-out [&[hidden]:not([hidden='until-found'])]:hidden motion-reduce:transition-none"
				style={({ transitionStatus }) => ({
					height:
						transitionStatus === "starting" || transitionStatus === "ending"
							? 0
							: "var(--collapsible-panel-height)",
					transitionProperty: "height",
				})}
			>
				{headings.length === 0 ? (
					<p className="pt-3 pb-1 text-xs leading-4 text-kumo-subtle">{t`No headings in document`}</p>
				) : (
					<div className="relative mt-2">
						<div aria-hidden="true" className="absolute inset-y-0 start-[3px] w-px bg-kumo-line" />
						<ul>
							{headings.map((heading) => {
								const isCurrent = heading.key === currentKey;
								return (
									<li key={heading.key} className="flex">
										<button
											type="button"
											onPointerDown={(event) => {
												pointerTypeRef.current = event.pointerType;
											}}
											onClick={(event) => handleHeadingClick(heading, event)}
											aria-current={isCurrent ? "location" : undefined}
											className={cn(
												"relative flex h-8 min-w-0 flex-1 items-center rounded-md pe-2 text-base leading-5 transition-colors duration-100 motion-reduce:transition-none",
												"before:absolute before:inset-y-1.5 before:start-[2px] before:w-[3px] before:rounded-full before:transition-colors before:duration-100 motion-reduce:before:transition-none",
												"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-kumo-brand",
												isCurrent
													? "text-kumo-default"
													: "text-kumo-subtle hover:text-kumo-default hover:before:bg-current/30",
											)}
											style={{ paddingInlineStart: `${1 + heading.depth * 0.75}rem` }}
											title={heading.text}
										>
											<span dir="auto" className="min-w-0 truncate">
												{heading.text}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
						<div
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute start-0 top-0 h-8 w-[7px] ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none",
								indicator.slide
									? "transition-[transform,opacity] duration-200"
									: "transition-opacity duration-150",
								currentIndex === -1 && "opacity-0",
							)}
							style={{ transform: `translateY(${Math.max(indicator.index, 0) * 100}%)` }}
						>
							<div className="absolute inset-y-1.5 start-[2px] w-[3px] rounded-full bg-kumo-brand" />
						</div>
					</div>
				)}
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
