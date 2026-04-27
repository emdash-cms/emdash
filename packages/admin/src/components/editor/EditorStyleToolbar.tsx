/**
 * Editor Style Toolbar
 *
 * Generic renderer for plugin-declared editor styles. Handles both
 * standalone toggle buttons and dropdown menus with mixed inline/block items.
 *
 * Plugins declare styles via `admin.editorStyles` in `definePlugin()`.
 * This component renders them as toolbar primitives without knowing
 * what the specific styles are — it just maps config to TipTap commands.
 */
import { Button } from "@cloudflare/kumo";
import {
	useFloating,
	offset,
	flip,
	shift,
	autoUpdate,
	FloatingFocusManager,
} from "@floating-ui/react";
import {
	HighlighterCircle,
	Palette,
	PaintBrush,
	Sparkle,
	TextAa,
	Swatches,
} from "@phosphor-icons/react";
import { useEditorState, type Editor } from "@tiptap/react";
import * as React from "react";
import { createPortal } from "react-dom";

import type {
	EditorStyleEntry,
	EditorStyleItem,
	EditorStyleSeparator,
} from "../../lib/api/client.js";
import { cn } from "../../lib/utils";
import { resolveStyledBlock } from "./BlockStyleExtension.js";

/** Narrowed style item with required fields for toggle logic */
interface ResolvedStyleItem {
	label: string;
	scope: "inline" | "block";
	classes: string;
	nodes?: string[];
}

// ---------------------------------------------------------------------------
// Icon resolution
// ---------------------------------------------------------------------------

const STYLE_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
	textAa: TextAa,
	highlighter: HighlighterCircle,
	palette: Palette,
	paintBrush: PaintBrush,
	sparkle: Sparkle,
	swatches: Swatches,
};

function resolveStyleIcon(key?: string): React.ComponentType<{ className?: string }> {
	if (key && STYLE_ICON_MAP[key]) {
		return STYLE_ICON_MAP[key];
	}
	return Swatches;
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

function isSeparator(item: EditorStyleItem | EditorStyleSeparator): item is EditorStyleSeparator {
	return (item as EditorStyleSeparator).type === "separator";
}

function resolveItem(item: EditorStyleItem | EditorStyleSeparator): ResolvedStyleItem | null {
	if (isSeparator(item)) return null;
	return { label: item.label, scope: item.scope, classes: item.classes, nodes: item.nodes };
}

/**
 * An entry is image-only iff it's block-scoped, has a non-empty `nodes` filter,
 * and every node in the filter is "image". These entries are routed to the
 * per-image detail panel exclusively (see ImageDetailPanel) and filtered out
 * of the document toolbar to keep it uncluttered.
 *
 * Mixed entries (e.g. nodes: ["paragraph", "image"]) are NOT image-only and
 * remain in the toolbar; the image detail panel will also surface them.
 */
function isImageOnly(item: EditorStyleItem | EditorStyleSeparator): boolean {
	if (isSeparator(item)) return false;
	if (item.scope !== "block") return false;
	const nodes = item.nodes;
	if (!nodes || nodes.length === 0) return false;
	return nodes.every((n) => n === "image");
}

/** Trim leading/trailing/consecutive separators left over after filtering. */
function tidySeparators(
	items: Array<EditorStyleItem | EditorStyleSeparator>,
): Array<EditorStyleItem | EditorStyleSeparator> {
	const out: Array<EditorStyleItem | EditorStyleSeparator> = [];
	let prevWasSep = true; // suppresses leading separators
	for (const item of items) {
		const sep = isSeparator(item);
		if (sep && prevWasSep) continue;
		out.push(item);
		prevWasSep = sep;
	}
	// Trim trailing separator
	while (out.length > 0) {
		const last = out.at(-1);
		if (!last || !isSeparator(last)) break;
		out.pop();
	}
	return out;
}

function isStyleActive(editor: Editor, item: ResolvedStyleItem): boolean {
	if (item.scope === "inline") {
		return editor.isActive("cssClass", { classes: item.classes });
	}
	const target = resolveStyledBlock(editor.state, item.nodes);
	return target?.node.attrs.cssClasses === item.classes;
}

function isNodeMatch(editor: Editor, nodes?: string[]): boolean {
	// For block styles, "matches" iff there is a styled-block ancestor whose
	// type is in the allowed list (or any styled block if no list is given).
	return resolveStyledBlock(editor.state, nodes) !== null;
}

function toggleStyle(editor: Editor, item: ResolvedStyleItem) {
	if (item.scope === "inline") {
		if (editor.isActive("cssClass", { classes: item.classes })) {
			editor.chain().focus().unsetCssClass(item.classes).run();
		} else {
			editor.chain().focus().setMark("cssClass", { classes: item.classes }).run();
		}
	} else {
		editor.chain().focus().toggleBlockCssClasses(item.classes, item.nodes).run();
	}
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface EditorStyleToolbarProps {
	editor: Editor;
	styles: EditorStyleEntry[];
}

/**
 * Renders plugin-declared editor styles as toolbar buttons and dropdowns.
 * Returns a fragment — intended to be placed inside a toolbar group.
 *
 * Image-only entries (block-scope with `nodes: ["image"]`) are filtered out
 * here — they're surfaced exclusively via the per-image detail panel.
 */
export function EditorStyleToolbar({ editor, styles }: EditorStyleToolbarProps) {
	const toolbarStyles = React.useMemo(() => filterToolbarStyles(styles), [styles]);
	if (toolbarStyles.length === 0) return null;

	return (
		<>
			{toolbarStyles.map((entry, i) => {
				const stableKey = `${entry.type}-${entry.label}-${entry.icon ?? ""}-${i}`;
				if (entry.type === "button") {
					return <StyleToggleButton key={stableKey} editor={editor} entry={entry} />;
				}
				if (entry.type === "dropdown") {
					return <StyleDropdownMenu key={stableKey} editor={editor} entry={entry} />;
				}
				return null;
			})}
		</>
	);
}

/**
 * Drop image-only entries from the top level and from inside dropdowns.
 * Suppress dropdowns that become empty after filtering.
 */
function filterToolbarStyles(styles: EditorStyleEntry[]): EditorStyleEntry[] {
	const out: EditorStyleEntry[] = [];
	for (const entry of styles) {
		if (entry.type === "button") {
			if (!isImageOnly(entry)) out.push(entry);
			continue;
		}
		if (entry.type === "dropdown") {
			const filtered = (entry.items ?? []).filter((it) => !isImageOnly(it));
			const tidy = tidySeparators(filtered);
			const hasReal = tidy.some((it) => !isSeparator(it));
			if (hasReal) {
				out.push({ ...entry, items: tidy });
			}
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// StyleToggleButton — standalone toolbar button
// ---------------------------------------------------------------------------

function StyleToggleButton({
	editor,
	entry,
}: {
	editor: Editor;
	entry: import("../../lib/api/client.js").EditorStyleButton;
}) {
	const IconComponent = resolveStyleIcon(entry.icon);
	const resolved: ResolvedStyleItem = {
		label: entry.label,
		scope: entry.scope,
		classes: entry.classes,
		nodes: entry.nodes,
	};

	const editorState = useEditorState({
		editor,
		selector: (ctx) => ({
			active: isStyleActive(ctx.editor, resolved),
			enabled: resolved.scope === "inline" || isNodeMatch(ctx.editor, resolved.nodes),
		}),
	});

	return (
		<Button
			type="button"
			variant="ghost"
			shape="square"
			className={cn("h-8 w-8", editorState.active && "bg-kumo-tint text-kumo-default")}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => toggleStyle(editor, resolved)}
			disabled={!editorState.enabled}
			aria-label={entry.label}
			aria-pressed={editorState.active}
			tabIndex={0}
		>
			<IconComponent className="h-4 w-4" aria-hidden="true" />
		</Button>
	);
}

// ---------------------------------------------------------------------------
// StyleDropdownMenu — dropdown with multiple items
// ---------------------------------------------------------------------------

function StyleDropdownMenu({
	editor,
	entry,
}: {
	editor: Editor;
	entry: import("../../lib/api/client.js").EditorStyleDropdown;
}) {
	const [open, setOpen] = React.useState(false);
	const triggerRef = React.useRef<HTMLButtonElement>(null);
	const floatingRef = React.useRef<HTMLDivElement>(null);
	const IconComponent = resolveStyleIcon(entry.icon);

	const closeAndFocusTrigger = React.useCallback(() => {
		setOpen(false);
		triggerRef.current?.focus();
	}, []);

	// Floating UI for portal-based positioning (escapes overflow: hidden).
	// `context` is needed by FloatingFocusManager below to manage focus
	// transitions when the popover opens/closes — without it, keyboard
	// users can't tab into the portaled buttons because they're appended
	// at the end of <body>, far from the trigger in DOM order.
	const { refs, floatingStyles, context } = useFloating({
		open,
		onOpenChange: setOpen,
		placement: "bottom-start",
		middleware: [offset(4), flip(), shift({ padding: 8 })],
		whileElementsMounted: autoUpdate,
	});

	// Merge refs for the trigger button
	const setTriggerRef = React.useCallback(
		(node: HTMLButtonElement | null) => {
			triggerRef.current = node;
			refs.setReference(node);
		},
		[refs],
	);

	// Close on click outside (checks both trigger and floating)
	React.useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (triggerRef.current?.contains(target) || floatingRef.current?.contains(target)) {
				return;
			}
			setOpen(false);
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	// Close on Escape and return focus to the trigger
	React.useEffect(() => {
		if (!open) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				closeAndFocusTrigger();
			}
		};
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [open, closeAndFocusTrigger]);

	// Resolve items to get only valid style items (not separators)
	const items: Array<EditorStyleItem | EditorStyleSeparator> = entry.items || [];
	const resolvedItems = items.map(resolveItem);

	const editorState = useEditorState({
		editor,
		selector: (ctx) => {
			// Sets keyed by item index — NOT by item.classes — so that two items
			// in the same dropdown sharing the same `classes` string (e.g., one
			// scoped to paragraph, one to heading) don't toggle each other's
			// active/disabled state.
			const activeSet = new Set<string>();
			const disabledSet = new Set<string>();
			for (let i = 0; i < resolvedItems.length; i++) {
				const item = resolvedItems[i];
				if (!item) continue;
				const indexKey = String(i);
				if (isStyleActive(ctx.editor, item)) {
					activeSet.add(indexKey);
				}
				if (item.scope === "block" && !isNodeMatch(ctx.editor, item.nodes)) {
					disabledSet.add(indexKey);
				}
			}
			return { activeSet, disabledSet, hasAny: activeSet.size > 0 };
		},
	});

	return (
		<>
			<Button
				ref={setTriggerRef}
				type="button"
				variant="ghost"
				shape="square"
				className={cn("h-8 w-8", editorState.hasAny && "bg-kumo-tint text-kumo-default")}
				onMouseDown={(e) => e.preventDefault()}
				onClick={() => setOpen(!open)}
				aria-label={entry.label}
				aria-expanded={open}
				aria-haspopup="true"
				tabIndex={0}
			>
				<IconComponent className="h-4 w-4" aria-hidden="true" />
			</Button>

			{open &&
				createPortal(
					// FloatingFocusManager moves focus into the popover when it
					// opens (so keyboard users can reach the items even though
					// the portal lives at the end of <body>) and returns focus
					// to the trigger on close. `modal={false}` keeps Tab able
					// to escape outside the popover naturally rather than
					// trapping the user inside.
					//
					// Plain popover container — intentionally NOT role="menu"
					// because we don't implement the full ARIA menu keyboard
					// model (arrow nav, roving tabindex). Items are native
					// buttons with `aria-pressed`, which AT handles cleanly
					// without promising behaviors we don't deliver.
					<FloatingFocusManager context={context} modal={false} initialFocus={0} returnFocus>
						<div
							ref={(node) => {
								floatingRef.current = node;
								refs.setFloating(node);
							}}
							style={floatingStyles}
							aria-label={entry.label}
							className="z-50 rounded-md border bg-kumo-overlay shadow-lg w-56 max-h-80 overflow-y-auto"
						>
							<div className="p-1.5 flex flex-col gap-0.5">
								{items.map((rawItem, i) => {
									const resolved = resolvedItems[i];
									if (!resolved) {
										if (isSeparator(rawItem)) {
											return (
												<div
													key={`sep-${i}`}
													aria-hidden="true"
													className="border-t border-kumo-line my-1"
												/>
											);
										}
										return null;
									}

									const indexKey = String(i);
									const active = editorState.activeSet.has(indexKey);
									const disabled = editorState.disabledSet.has(indexKey);

									return (
										<button
											key={`${i}-${resolved.scope}-${resolved.label}-${resolved.classes}`}
											type="button"
											aria-pressed={active}
											className={cn(
												"flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded text-left",
												disabled ? "text-kumo-subtle/40 cursor-not-allowed" : "hover:bg-kumo-tint",
												active && !disabled && "bg-kumo-tint font-medium",
											)}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => {
												if (disabled) return;
												toggleStyle(editor, resolved);
												closeAndFocusTrigger();
											}}
											disabled={disabled}
										>
											<span
												className={cn(
													"w-3.5 h-3.5 rounded-sm border flex items-center justify-center text-[10px] shrink-0",
													active && !disabled
														? "bg-kumo-brand border-kumo-brand text-white"
														: "border-kumo-line",
												)}
											>
												{active && !disabled && "✓"}
											</span>
											<span className="truncate">{resolved.label}</span>
											{resolved.nodes && resolved.nodes.length > 0 && (
												<span className="text-[10px] text-kumo-subtle ml-auto shrink-0">
													{resolved.nodes.join(", ")}
												</span>
											)}
										</button>
									);
								})}
							</div>
						</div>
					</FloatingFocusManager>,
					document.body,
				)}
		</>
	);
}
