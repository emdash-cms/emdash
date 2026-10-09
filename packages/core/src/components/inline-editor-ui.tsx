/**
 * Building blocks for the inline (visual editing) editor's floating UI: its
 * selection toolbars, their menus and tooltips, and the slash menu. They
 * look like the admin editor's, drawn with plain CSS from the admin's
 * colours, since sites don't load the admin's stylesheet. Each editor keeps
 * them in its own root at the end of `document.body`, outside the page's
 * content and the styles aimed at it.
 */

import {
	FloatingArrow,
	FloatingFocusManager,
	FloatingPortal,
	arrow,
	autoUpdate,
	flip,
	offset,
	shift,
	size,
	useClick,
	useDismiss,
	useFloating,
	useFocus,
	useHover,
	useInteractions,
	useListNavigation,
	useRole,
	useTypeahead,
	type Placement,
} from "@floating-ui/react";
import { Check, type Icon } from "@phosphor-icons/react";
import type { Editor } from "@tiptap/core";
import * as React from "react";

/** Marks a menu opened from a selection toolbar, so the toolbar stays while it has focus. */
export const TOOLBAR_POPUP_ATTR = "data-emdash-bubble-popup";

export const InlineUiRootContext = React.createContext<HTMLElement | null>(null);

/**
 * Whether the toolbar around a control is showing. The toolbar hides by
 * leaving the page, which ends no hover, so its tooltips close on this.
 */
export const ToolbarShownContext = React.createContext(true);

/** The editor's floating UI root, created once and attached to the page while the editor is. */
export function useInlineUiRoot(): HTMLElement {
	const [root] = React.useState(() => {
		const element = document.createElement("div");
		element.className = "emdash-inline-ui";
		return element;
	});
	React.useLayoutEffect(() => {
		document.body.append(root);
		return () => root.remove();
	}, [root]);
	return root;
}

function useTooltip(label: string) {
	const root = React.useContext(InlineUiRootContext);
	const shown = React.useContext(ToolbarShownContext);
	const [hovered, setOpen] = React.useState(false);
	const open = hovered && shown;
	React.useEffect(() => {
		if (!shown) setOpen(false);
	}, [shown]);
	const arrowRef = React.useRef<SVGSVGElement>(null);
	const { refs, floatingStyles, context } = useFloating({
		open,
		onOpenChange: setOpen,
		placement: "top",
		strategy: "fixed",
		middleware: [
			offset(8),
			flip({ padding: 8 }),
			shift({ padding: 8 }),
			arrow({ element: arrowRef }),
		],
		whileElementsMounted: autoUpdate,
	});
	const hover = useHover(context, { delay: { open: 400 }, mouseOnly: true });
	const focus = useFocus(context, { visibleOnly: true });
	const dismiss = useDismiss(context, { referencePress: true });
	const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss]);
	// The button's label already names it, so the tooltip is for sight only.
	const tooltip = open ? (
		<FloatingPortal root={root}>
			<div
				ref={refs.setFloating}
				style={floatingStyles}
				className="emdash-inline-ui-tooltip"
				aria-hidden="true"
				{...getFloatingProps()}
			>
				{label}
				<FloatingArrow
					ref={arrowRef}
					context={context}
					width={12}
					height={6}
					strokeWidth={1}
					className="emdash-inline-ui-tooltip-arrow"
				/>
			</div>
		</FloatingPortal>
	) : null;
	return { setReference: refs.setReference, getReferenceProps, tooltip };
}

/** An icon button in a selection toolbar, named by its tooltip. */
export function ToolbarButton({
	label,
	active,
	onClick,
	children,
}: {
	label: string;
	/** Whether the formatting it applies is on; unset for actions. */
	active?: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	const { setReference, getReferenceProps, tooltip } = useTooltip(label);
	return (
		<>
			<button
				ref={setReference}
				type="button"
				className="emdash-inline-ui-button"
				aria-label={label}
				aria-pressed={active}
				{...getReferenceProps({
					// Keeps the editor's selection, which a focused button would clear.
					onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
					onClick,
				})}
			>
				{children}
			</button>
			{tooltip}
		</>
	);
}

export function ToolbarSeparator() {
	return <div aria-hidden="true" className="emdash-inline-ui-separator" />;
}

export interface ToolbarMenuItem {
	label: string;
	icon: Icon;
	/** A radio or checkbox item shows a check mark while `checked`. */
	role?: "menuitemradio" | "menuitemcheckbox";
	checked?: boolean;
	disabled?: boolean;
	onSelect: () => void;
}

export interface ToolbarMenuGroup {
	label?: string;
	items: ToolbarMenuItem[];
}

/**
 * A toolbar button that opens a menu below it. Choosing an item or pressing
 * Escape or Tab returns to the editor, so typing carries on there.
 */
export function ToolbarMenu({
	editor,
	label,
	open,
	onOpenChange,
	placement,
	iconOnly,
	trigger,
	groups,
}: {
	editor: Editor;
	label: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	placement: Placement;
	iconOnly?: boolean;
	trigger: React.ReactNode;
	groups: ToolbarMenuGroup[];
}) {
	const root = React.useContext(InlineUiRootContext);
	const listRef = React.useRef<Array<HTMLElement | null>>([]);
	const labelsRef = React.useRef<Array<string | null>>([]);
	const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
	const focusEditor = () => {
		if (!editor.isDestroyed) editor.view.focus();
	};
	const { refs, floatingStyles, context } = useFloating({
		open,
		onOpenChange: (next, _event, reason) => {
			onOpenChange(next);
			if (!next && reason === "escape-key") focusEditor();
		},
		placement,
		strategy: "fixed",
		middleware: [
			offset(8),
			flip({ padding: 8 }),
			shift({ padding: 8 }),
			size({
				padding: 8,
				apply: ({ availableHeight, elements }) => {
					elements.floating.style.maxHeight = `${Math.min(416, Math.max(0, availableHeight))}px`;
				},
			}),
		],
		whileElementsMounted: autoUpdate,
	});
	const click = useClick(context);
	const dismiss = useDismiss(context);
	const role = useRole(context, { role: "menu" });
	const listNavigation = useListNavigation(context, {
		listRef,
		activeIndex,
		onNavigate: setActiveIndex,
		loop: true,
	});
	const typeahead = useTypeahead(context, {
		listRef: labelsRef,
		activeIndex,
		onMatch: open ? setActiveIndex : undefined,
	});
	const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
		click,
		dismiss,
		role,
		listNavigation,
		typeahead,
	]);

	let index = 0;
	return (
		<>
			<button
				ref={refs.setReference}
				type="button"
				className="emdash-inline-ui-trigger"
				aria-label={label}
				data-icon-only={iconOnly ? "" : undefined}
				data-open={open ? "" : undefined}
				{...getReferenceProps({
					onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
				})}
			>
				{trigger}
			</button>
			{open && (
				<FloatingPortal root={root}>
					<FloatingFocusManager context={context} modal={false} returnFocus={false}>
						<div
							ref={refs.setFloating}
							style={floatingStyles}
							className="emdash-inline-ui-menu"
							{...{ [TOOLBAR_POPUP_ATTR]: "" }}
							{...getFloatingProps({
								onKeyDown: (event: React.KeyboardEvent) => {
									if (event.key !== "Tab") return;
									event.preventDefault();
									onOpenChange(false);
									focusEditor();
								},
							})}
						>
							{groups.map((group, groupIndex) => (
								<React.Fragment key={group.label ?? groupIndex}>
									{groupIndex > 0 && (
										<div role="separator" className="emdash-inline-ui-menu-separator" />
									)}
									<div role="group" aria-label={group.label}>
										{group.label && (
											<div aria-hidden="true" className="emdash-inline-ui-menu-label">
												{group.label}
											</div>
										)}
										{group.items.map((item) => {
											const itemIndex = index++;
											return (
												<button
													key={item.label}
													ref={(node) => {
														listRef.current[itemIndex] = node;
														labelsRef.current[itemIndex] = item.label;
													}}
													type="button"
													role={item.role ?? "menuitem"}
													aria-checked={item.role ? item.checked === true : undefined}
													disabled={item.disabled}
													tabIndex={activeIndex === itemIndex ? 0 : -1}
													className="emdash-inline-ui-menu-item"
													data-highlighted={activeIndex === itemIndex ? "" : undefined}
													{...getItemProps({
														onClick: () => {
															onOpenChange(false);
															item.onSelect();
														},
													})}
												>
													<item.icon className="emdash-inline-ui-menu-icon" aria-hidden="true" />
													<span className="emdash-inline-ui-menu-text">{item.label}</span>
													{item.checked && (
														<Check className="emdash-inline-ui-menu-check" aria-hidden="true" />
													)}
												</button>
											);
										})}
									</div>
								</React.Fragment>
							))}
						</div>
					</FloatingFocusManager>
				</FloatingPortal>
			)}
		</>
	);
}

const TOOLBAR_CONTROL_SELECTOR = "button:not([disabled]), a[href], input";

/**
 * Tab from a selection moves into its toolbar. The toolbars sit at the end
 * of the page, so the browser would otherwise move focus past them.
 */
export function useTabIntoToolbar(editor: Editor, root: HTMLElement) {
	React.useEffect(() => {
		const dom = editor.view.dom;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
				return;
			}
			// Lists and code blocks use Tab themselves.
			if (event.defaultPrevented || event.isComposing) return;
			// A hidden toolbar isn't on the page, so this finds only the one showing.
			const control = root
				.querySelector('[role="toolbar"]')
				?.querySelector<HTMLElement>(TOOLBAR_CONTROL_SELECTOR);
			if (!control) return;
			event.preventDefault();
			control.focus();
		};
		dom.addEventListener("keydown", onKeyDown);
		return () => dom.removeEventListener("keydown", onKeyDown);
	}, [editor, root]);
}

const FOCUSABLE_SELECTOR =
	'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** Focuses the first control after the editor on the page, where Tab from it would go. */
function focusAfterEditor(editor: Editor): boolean {
	const dom = editor.view.dom;
	for (const element of document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
		if (element.tabIndex < 0 || dom.contains(element) || element.closest(".emdash-inline-ui")) {
			continue;
		}
		if (!(dom.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
		element.focus();
		// Hidden and disabled controls ignore focus().
		if (document.activeElement === element) return true;
	}
	return false;
}

/**
 * Keys in a selection toolbar, which sits at the end of the page but acts as
 * if it followed the editor: Escape, or Shift+Tab from its first control,
 * goes back to the editor, and Tab from its last goes on to what follows
 * the editor. Left and Right move between its buttons and links, flipped for
 * right-to-left text; Home and End go to the first and last.
 */
export function handleToolbarKeyDown(event: React.KeyboardEvent<HTMLElement>, editor: Editor) {
	if (event.nativeEvent.isComposing || event.defaultPrevented) return;
	const toolbar = event.currentTarget;
	const controls = [...toolbar.querySelectorAll(TOOLBAR_CONTROL_SELECTOR)];
	const backToEditor =
		event.key === "Escape" ||
		(event.key === "Tab" && event.shiftKey && document.activeElement === controls[0]);
	if (backToEditor) {
		event.preventDefault();
		if (!editor.isDestroyed) editor.view.focus();
		return;
	}
	if (
		event.key === "Tab" &&
		!event.shiftKey &&
		document.activeElement === controls.at(-1) &&
		focusAfterEditor(editor)
	) {
		event.preventDefault();
		return;
	}
	const items = [
		...toolbar.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"),
	].filter((item) => item.getClientRects().length > 0);
	const currentIndex = items.findIndex((item) => item === document.activeElement);
	if (currentIndex === -1) return;
	const forward = getComputedStyle(toolbar).direction === "rtl" ? -1 : 1;
	let nextIndex: number;
	switch (event.key) {
		case "ArrowRight":
			nextIndex = currentIndex + forward;
			break;
		case "ArrowLeft":
			nextIndex = currentIndex - forward;
			break;
		case "Home":
			nextIndex = 0;
			break;
		case "End":
			nextIndex = items.length - 1;
			break;
		default:
			return;
	}
	event.preventDefault();
	items[(nextIndex + items.length) % items.length]?.focus();
}

/** A toolbar's short rise into place as it appears, like the admin editor's. */
export function playToolbarEntrance(surface: Element | null | undefined) {
	if (!(surface instanceof HTMLElement) || typeof surface.animate !== "function") return;
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	surface.animate(
		reduceMotion
			? [{ opacity: 0 }, { opacity: 1 }]
			: [
					{ opacity: 0, transform: "translateY(2px) scale(0.98)" },
					{ opacity: 1, transform: "none" },
				],
		{ duration: 120, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
	);
}

/**
 * Colours and sizes follow the admin editor's Kumo tokens, in pixels so a
 * site's root font size doesn't scale them. `light-dark()` follows the
 * reader's system theme, as the admin does by default.
 */
export const INLINE_EDITOR_UI_STYLES = `
	@property --emdash-inline-ui-fade-start {
		syntax: "<length>";
		inherits: false;
		initial-value: 0px;
	}
	@property --emdash-inline-ui-fade-end {
		syntax: "<length>";
		inherits: false;
		initial-value: 0px;
	}
	@keyframes emdash-inline-ui-scroll-fade {
		0% { --emdash-inline-ui-fade-start: 0px; }
		10%, 100% { --emdash-inline-ui-fade-start: 24px; }
		0%, 90% { --emdash-inline-ui-fade-end: 24px; }
		100% { --emdash-inline-ui-fade-end: 0px; }
	}
	@keyframes emdash-inline-ui-pop {
		from { opacity: 0; scale: 0.97; }
	}
	@keyframes emdash-inline-ui-tooltip-pop {
		from { opacity: 0; scale: 0.9; }
	}
	.emdash-inline-ui {
		position: absolute;
		inset-block-start: 0;
		inset-inline-start: 0;
		z-index: 1000000;
		color-scheme: light dark;
		--emdash-ui-surface: light-dark(#fff, oklch(20.5% 0 0));
		--emdash-ui-raised: light-dark(#fff, oklch(17% 0 0));
		--emdash-ui-text: light-dark(#1d2327, oklch(97% 0 0));
		--emdash-ui-subtle: light-dark(#646970, oklch(70.8% 0 0));
		--emdash-ui-placeholder: light-dark(oklch(70.8% 0 0), oklch(55.6% 0 0));
		--emdash-ui-tint: light-dark(#f0f0f1, oklch(26.9% 0 0));
		--emdash-ui-line: light-dark(oklch(14.5% 0 0 / 0.1), oklch(32% 0 0));
		--emdash-ui-hairline: light-dark(oklch(93.5% 0 0), oklch(26.9% 0 0));
		--emdash-ui-fill: light-dark(#dcdcde, oklch(26.9% 0 0));
		--emdash-ui-link: light-dark(oklch(42.4% 0.199 265.638), oklch(70.7% 0.165 254.624));
		--emdash-ui-danger: light-dark(oklch(50.5% 0.213 27.518), oklch(70.4% 0.191 22.216));
		--emdash-ui-danger-ring: light-dark(oklch(63.7% 0.237 25.331), oklch(57.7% 0.245 27.325));
		--emdash-ui-focus: light-dark(oklch(15% 0 0), oklch(93.5% 0 0));
		--emdash-ui-tip-shadow: light-dark(oklch(92.8% 0.006 264.531), transparent);
		--emdash-ui-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
		color: var(--emdash-ui-text);
		font-family: ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji",
			"Segoe UI Symbol", "Noto Color Emoji";
		font-size: 14px;
		font-style: normal;
		font-weight: 400;
		line-height: 20px;
		letter-spacing: normal;
		text-align: start;
		text-transform: none;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}
	.emdash-inline-ui :where(*, *::before, *::after) {
		box-sizing: border-box;
	}
	.emdash-inline-ui :where(button, input, a) {
		min-width: 0;
		min-height: 0;
		margin: 0;
		font: inherit;
		color: inherit;
		letter-spacing: inherit;
		text-decoration: none;
		text-shadow: none;
		text-transform: none;
	}
	.emdash-inline-ui :where(svg) {
		display: block;
		flex: none;
	}
	.emdash-inline-ui-bar,
	.emdash-inline-ui-menu,
	.emdash-inline-ui .emdash-slash-menu {
		border-radius: 10px;
		background: var(--emdash-ui-surface);
		box-shadow: 0 0 0 1px var(--emdash-ui-line), var(--emdash-ui-shadow);
	}
	.emdash-inline-ui-bar {
		display: flex;
		max-width: 100%;
		align-items: center;
		gap: 2px;
		padding: 4px;
	}
	.emdash-inline-ui-toolbar {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 2px;
		margin: -4px;
		padding: 4px;
		overflow-x: auto;
		scroll-padding-inline: 4px;
		border-radius: inherit;
		scrollbar-width: none;
		animation: emdash-inline-ui-scroll-fade linear;
		animation-timeline: scroll(self inline);
		mask-image: linear-gradient(
			to var(--emdash-inline-ui-fade-direction, right),
			transparent,
			black var(--emdash-inline-ui-fade-start),
			black calc(100% - var(--emdash-inline-ui-fade-end)),
			transparent
		);
	}
	.emdash-inline-ui-toolbar:dir(rtl) {
		--emdash-inline-ui-fade-direction: left;
	}
	.emdash-inline-ui-toolbar::-webkit-scrollbar {
		display: none;
	}
	.emdash-inline-ui-button,
	.emdash-inline-ui-trigger {
		display: inline-flex;
		flex: none;
		height: 32px;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: 0;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--emdash-ui-text);
		cursor: pointer;
		outline: none;
		box-shadow: none;
		font-size: 14px;
		line-height: 20px;
		-webkit-tap-highlight-color: transparent;
	}
	.emdash-inline-ui-button {
		width: 32px;
	}
	.emdash-inline-ui-trigger {
		padding-inline: 8px;
	}
	.emdash-inline-ui-trigger[data-icon-only] {
		width: 32px;
		padding-inline: 0;
	}
	.emdash-inline-ui-button:hover,
	.emdash-inline-ui-trigger:hover,
	.emdash-inline-ui-trigger[data-open] {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-button[aria-pressed="true"] {
		background: var(--emdash-ui-tint);
		color: var(--emdash-ui-link);
	}
	.emdash-inline-ui-button:focus-visible,
	.emdash-inline-ui-trigger:focus-visible,
	.emdash-inline-ui-link-url:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in oklch, var(--emdash-ui-focus) 50%, transparent);
	}
	.emdash-inline-ui-button svg,
	.emdash-inline-ui-trigger > svg:only-child {
		width: 16px;
		height: 16px;
	}
	.emdash-inline-ui-trigger-label {
		max-width: 128px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-inline-ui-caret {
		width: 12px;
		height: 12px;
		color: var(--emdash-ui-subtle);
	}
	.emdash-inline-ui-separator {
		flex: none;
		width: 1px;
		height: 20px;
		margin-inline: 2px;
		background: var(--emdash-ui-hairline);
	}
	.emdash-inline-ui-link-edit {
		display: flex;
		min-width: 0;
		align-items: flex-start;
		gap: 4px;
	}
	.emdash-inline-ui-field {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 4px;
	}
	.emdash-inline-ui-input {
		width: 288px;
		min-width: 0;
		max-width: 100%;
		height: 32px;
		padding: 0 12px;
		border: 0;
		border-radius: 8px;
		background: var(--emdash-ui-surface);
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
		color: var(--emdash-ui-text);
		font-size: 14px;
		line-height: 20px;
		outline: none;
	}
	.emdash-inline-ui-input::placeholder {
		color: var(--emdash-ui-placeholder);
		opacity: 1;
	}
	.emdash-inline-ui-input:focus {
		box-shadow: 0 0 0 1.5px color-mix(in oklch, var(--emdash-ui-focus) 50%, transparent);
	}
	.emdash-inline-ui-input[aria-invalid="true"] {
		box-shadow: 0 0 0 1px var(--emdash-ui-danger-ring);
	}
	.emdash-inline-ui-input[aria-invalid="true"]:focus {
		box-shadow: 0 0 0 1.5px color-mix(in oklch, var(--emdash-ui-danger-ring) 50%, transparent);
	}
	.emdash-inline-ui-field-error {
		max-width: 288px;
		margin: 0;
		padding: 4px 8px;
		color: var(--emdash-ui-danger);
		font-size: 12px;
		line-height: 16px;
	}
	.emdash-inline-ui-link-preview {
		max-width: min(448px, calc(100vw - 16px));
	}
	.emdash-inline-ui-link-globe {
		width: 16px;
		height: 16px;
		margin-inline-start: 6px;
		color: var(--emdash-ui-subtle);
	}
	.emdash-inline-ui-link-url {
		min-width: 0;
		overflow: hidden;
		padding-inline: 6px;
		border-radius: 4px;
		color: var(--emdash-ui-link);
		font-size: 14px;
		outline: none;
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-inline-ui-link-url:hover {
		text-decoration: underline;
	}
	span.emdash-inline-ui-link-url {
		color: var(--emdash-ui-subtle);
	}
	.emdash-inline-ui-menu {
		min-width: 224px;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 4px;
		outline: none;
		transform-origin: top;
		animation: emdash-inline-ui-pop 100ms ease-out;
	}
	.emdash-inline-ui-menu-label {
		padding: 6px 8px 4px;
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
		user-select: none;
	}
	.emdash-inline-ui-menu-separator {
		height: 1px;
		margin: 4px -4px;
		background: var(--emdash-ui-hairline);
	}
	.emdash-inline-ui-menu-item {
		display: flex;
		width: 100%;
		height: 32px;
		align-items: center;
		gap: 8px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--emdash-ui-text);
		cursor: default;
		outline: none;
		text-align: start;
		user-select: none;
	}
	.emdash-inline-ui-menu-item[data-highlighted] {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-menu-item:disabled {
		opacity: 0.5;
		pointer-events: none;
	}
	.emdash-inline-ui-menu-icon {
		width: 16px;
		height: 16px;
		color: var(--emdash-ui-subtle);
	}
	.emdash-inline-ui-menu-check {
		width: 16px;
		height: 16px;
	}
	.emdash-inline-ui-menu-text {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-inline-ui-tooltip {
		padding: 6px 10px;
		border-radius: 6px;
		background: var(--emdash-ui-raised);
		box-shadow: 0 10px 15px -3px var(--emdash-ui-tip-shadow), 0 4px 6px -4px var(--emdash-ui-tip-shadow);
		color: var(--emdash-ui-text);
		font-size: 13px;
		line-height: 15px;
		outline: 1px solid var(--emdash-ui-fill);
		pointer-events: none;
		white-space: nowrap;
		animation: emdash-inline-ui-tooltip-pop 150ms ease-out;
	}
	.emdash-inline-ui-tooltip-arrow {
		fill: var(--emdash-ui-raised);
	}
	.emdash-inline-ui-tooltip-arrow path[clip-path] {
		stroke: var(--emdash-ui-fill);
	}
	.emdash-inline-ui-tooltip-arrow path:not([clip-path]) {
		stroke: var(--emdash-ui-raised);
	}
	.emdash-inline-ui .emdash-slash-menu {
		display: flex;
		width: 320px;
		max-width: calc(100vw - 16px);
		flex-direction: column;
		overflow: hidden;
		transform-origin: top;
		animation: emdash-inline-ui-pop 100ms ease-out;
	}
	.emdash-slash-menu-viewport {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 4px;
		scroll-padding-block: 4px;
	}
	.emdash-slash-menu-group-label {
		padding: 8px 8px 4px;
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
		user-select: none;
	}
	.emdash-slash-menu-item {
		display: flex;
		width: 100%;
		height: 32px;
		align-items: center;
		gap: 10px;
		padding: 0 8px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--emdash-ui-text);
		cursor: default;
		outline: none;
		text-align: start;
	}
	.emdash-slash-menu-item[aria-current="true"] {
		background: var(--emdash-ui-tint);
	}
	.emdash-slash-menu-icon {
		width: 18px;
		height: 18px;
		color: var(--emdash-ui-subtle);
	}
	.emdash-slash-menu-title {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-slash-menu-markdown {
		flex: none;
		padding-inline-start: 12px;
		color: var(--emdash-ui-subtle);
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 12px;
		line-height: 16px;
	}
	.emdash-slash-menu-empty {
		margin: 0;
		padding: 6px 8px;
		color: var(--emdash-ui-subtle);
	}
	.emdash-slash-menu-footer {
		display: flex;
		flex: none;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		border-block-start: 1px solid var(--emdash-ui-hairline);
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		line-height: 16px;
	}
	.emdash-slash-menu-footer-text {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-inline-ui-sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.emdash-inline-ui-button,
		.emdash-inline-ui-trigger,
		.emdash-inline-ui-input {
			height: 44px;
		}
		.emdash-inline-ui-button,
		.emdash-inline-ui-trigger[data-icon-only] {
			width: 44px;
		}
		.emdash-inline-ui-menu-item,
		.emdash-slash-menu-item {
			height: 44px;
		}
		.emdash-slash-menu-esc {
			display: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.emdash-inline-ui-menu,
		.emdash-inline-ui-tooltip,
		.emdash-inline-ui .emdash-slash-menu {
			animation: none;
		}
	}
`;
