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
import { useFloating, offset, flip, shift, autoUpdate } from "@floating-ui/react";
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

function isStyleActive(editor: Editor, item: ResolvedStyleItem): boolean {
	if (item.scope === "inline") {
		return editor.isActive("cssClass", { classes: item.classes });
	}
	const { $from } = editor.state.selection;
	return $from.parent.attrs.cssClasses === item.classes;
}

function isNodeMatch(editor: Editor, nodes?: string[]): boolean {
	if (!nodes || nodes.length === 0) return true;
	const { $from } = editor.state.selection;
	return nodes.includes($from.parent.type.name);
}

function toggleStyle(editor: Editor, item: ResolvedStyleItem) {
	if (item.scope === "inline") {
		if (editor.isActive("cssClass", { classes: item.classes })) {
			editor.chain().focus().unsetCssClass(item.classes).run();
		} else {
			editor.chain().focus().setMark("cssClass", { classes: item.classes }).run();
		}
	} else {
		editor.chain().focus().toggleBlockCssClasses(item.classes).run();
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
 */
export function EditorStyleToolbar({ editor, styles }: EditorStyleToolbarProps) {
	if (styles.length === 0) return null;

	return (
		<>
			{styles.map((entry, i) => {
				if (entry.type === "button") {
					return <StyleToggleButton key={`btn-${i}`} editor={editor} entry={entry} />;
				}
				if (entry.type === "dropdown") {
					return <StyleDropdownMenu key={`dd-${i}`} editor={editor} entry={entry} />;
				}
				return null;
			})}
		</>
	);
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

	// Floating UI for portal-based positioning (escapes overflow: hidden)
	const { refs, floatingStyles } = useFloating({
		open,
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
			const activeSet = new Set<string>();
			const disabledSet = new Set<string>();
			for (const item of resolvedItems) {
				if (!item) continue;
				if (isStyleActive(ctx.editor, item)) {
					activeSet.add(item.classes);
				}
				if (item.scope === "block" && !isNodeMatch(ctx.editor, item.nodes)) {
					disabledSet.add(item.classes);
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
				aria-haspopup="menu"
				tabIndex={0}
			>
				<IconComponent className="h-4 w-4" aria-hidden="true" />
			</Button>

			{open &&
				createPortal(
					<div
						ref={(node) => {
							floatingRef.current = node;
							refs.setFloating(node);
						}}
						style={floatingStyles}
						role="menu"
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
												role="separator"
												className="border-t border-kumo-line my-1"
											/>
										);
									}
									return null;
								}

								const active = editorState.activeSet.has(resolved.classes);
								const disabled = editorState.disabledSet.has(resolved.classes);

								return (
									<button
										key={resolved.classes}
										type="button"
										role="menuitem"
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
					</div>,
					document.body,
				)}
		</>
	);
}
