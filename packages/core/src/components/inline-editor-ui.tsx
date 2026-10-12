/**
 * Building blocks for the inline (visual editing) editor's floating UI: its
 * selection toolbars, their menus and tooltips, and the slash menu. They
 * look like the admin editor's, drawn with plain CSS from the admin's
 * colours, since sites don't load the admin's stylesheet. Each editor keeps
 * them in its own root at the end of `document.body`, outside the page's
 * content and the styles aimed at it.
 */

import {
	FloatingFocusManager,
	FloatingPortal,
	NextFloatingDelayGroup,
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
	useMergeRefs,
	useNextDelayGroup,
	useRole,
	useTransitionStatus,
	useTypeahead,
	type Middleware,
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

/**
 * The editor's floating UI root, created once and attached to the page while
 * the editor is. A server render has no page, so it gets none.
 */
export function useInlineUiRoot(): HTMLElement | null {
	const [root] = React.useState(() => {
		if (typeof document === "undefined") return null;
		const element = document.createElement("div");
		element.className = "emdash-inline-ui";
		return element;
	});
	React.useLayoutEffect(() => {
		if (!root) return;
		document.body.append(root);
		return () => root.remove();
	}, [root]);
	return root;
}

/**
 * TipTap positions a hidden toolbar before it puts the toolbar on the page,
 * where floating-ui can't tell that the page reads right to left. A toolbar
 * about to show waits on the page, still hidden, so it lines up with the
 * selection on the side the page reads from.
 */
export function attachBeforePositioning(toolbar: HTMLElement, root: HTMLElement) {
	if (toolbar.isConnected) return;
	root.append(toolbar);
	// TipTap shows it straight away. A toolbar left hidden on the page could
	// be shown again by TipTap's scroll handling, so if that didn't happen it goes.
	queueMicrotask(() => {
		if (toolbar.style.visibility === "hidden") toolbar.remove();
	});
}

/**
 * Puts a floating element's transform origin on the middle of the edge of
 * its anchor that it opens from, so it grows out of the control that opened
 * it. Must come last, once the position is final. The elements this is for
 * open above or below their anchor and are positioned without a transform,
 * which their scale would otherwise move too.
 *
 * `getAnchor` defaults to the positioning reference. floating-ui keeps the
 * first copy of a middleware whose source is unchanged, so it must read refs
 * rather than values from a render.
 */
export function transformOrigin(getAnchor?: () => DOMRect): Middleware {
	return {
		name: "transformOrigin",
		fn: ({ x, y, placement, rects, elements }) => {
			// Measured on screen, then placed from the reference, which floating-ui
			// measures in the same coordinates as the floating element's position.
			const reference = elements.reference.getBoundingClientRect();
			const anchor = getAnchor?.() ?? reference;
			const edge = placement.startsWith("top") ? anchor.top : anchor.bottom;
			return {
				data: {
					x: rects.reference.x + anchor.left + anchor.width / 2 - reference.left - x,
					y: rects.reference.y + edge - reference.top - y,
				},
			};
		},
	};
}

export function originStyle(origin: { x: number; y: number } | undefined): React.CSSProperties {
	return origin ? { transformOrigin: `${origin.x}px ${origin.y}px` } : {};
}

/**
 * floating-ui positions an element when it mounts or its anchor moves, and
 * forgets it did once the element closes. One reopened while it fades out
 * would stay hidden until something moved, so it's positioned again.
 */
function useRepositionOnOpen(open: boolean, update: () => void) {
	React.useLayoutEffect(() => {
		if (open) update();
	}, [open, update]);
}

const TOOLTIP_DELAY = { open: 400, close: 0 };

/**
 * Once one tooltip in a toolbar shows, its neighbours' show at once while
 * the pointer moves along the toolbar, as in the admin editor.
 */
export function ToolbarTooltipGroup({ children }: { children: React.ReactNode }) {
	return (
		<NextFloatingDelayGroup delay={TOOLTIP_DELAY} timeoutMs={400}>
			{children}
		</NextFloatingDelayGroup>
	);
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
	const { refs, floatingStyles, context, placement, middlewareData, isPositioned, update } =
		useFloating({
			open,
			onOpenChange: setOpen,
			placement: "top",
			strategy: "fixed",
			transform: false,
			middleware: [
				offset(10),
				flip({ padding: 8 }),
				shift({ padding: 8 }),
				arrow({ element: arrowRef }),
				transformOrigin(),
			],
			whileElementsMounted: autoUpdate,
		});
	useRepositionOnOpen(open, update);
	const { delayRef, isInstantPhase, hasProvider } = useNextDelayGroup(context);
	const hover = useHover(context, {
		delay: () => (hasProvider ? delayRef.current : TOOLTIP_DELAY),
		mouseOnly: true,
	});
	const focus = useFocus(context, { visibleOnly: true });
	const dismiss = useDismiss(context, { referencePress: true });
	const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss]);
	const { isMounted, status } = useTransitionStatus(context, {
		// A hidden toolbar takes its buttons off the page, so their tooltips go with it.
		duration: isInstantPhase || !shown ? 0 : 150,
	});
	// The button names or describes itself already, so the tooltip is for sight only.
	const tooltip = isMounted ? (
		<FloatingPortal root={root}>
			<div
				ref={refs.setFloating}
				style={{
					...floatingStyles,
					...originStyle(middlewareData.transformOrigin),
					visibility: isPositioned || status === "close" ? undefined : "hidden",
				}}
				className="emdash-inline-ui-tooltip"
				data-status={status}
				data-instant={isInstantPhase ? "" : undefined}
				dir="auto"
				aria-hidden="true"
				{...getFloatingProps()}
			>
				{label}
				<svg
					ref={arrowRef}
					width="20"
					height="10"
					viewBox="0 0 20 10"
					className="emdash-inline-ui-tooltip-arrow"
					data-side={placement.startsWith("bottom") ? "bottom" : "top"}
					style={{ left: middlewareData.arrow?.x }}
				>
					<path
						className="emdash-inline-ui-tooltip-arrow-fill"
						d="M9.66437 2.60207L4.80758 6.97318C4.07308 7.63423 3.11989 8 2.13172 8H0V10H20V8H18.5349C17.5468 8 16.5936 7.63423 15.8591 6.97318L11.0023 2.60207C10.622 2.2598 10.0447 2.25979 9.66437 2.60207Z"
					/>
					<path
						className="emdash-inline-ui-tooltip-arrow-shadow"
						d="M8.99542 1.85876C9.75604 1.17425 10.9106 1.17422 11.6713 1.85878L16.5281 6.22989C17.0789 6.72568 17.7938 7.00001 18.5349 7.00001L15.89 7L11.0023 2.60207C10.622 2.2598 10.0447 2.2598 9.66436 2.60207L4.77734 7L2.13171 7.00001C2.87284 7.00001 3.58774 6.72568 4.13861 6.22989L8.99542 1.85876Z"
					/>
					<path
						className="emdash-inline-ui-tooltip-arrow-stroke"
						d="M10.3333 3.34539L5.47654 7.71648C4.55842 8.54279 3.36693 9 2.13172 9H0V8H2.13172C3.11989 8 4.07308 7.63423 4.80758 6.97318L9.66437 2.60207C10.0447 2.25979 10.622 2.2598 11.0023 2.60207L15.8591 6.97318C16.5936 7.63423 17.5468 8 18.5349 8H20V9H18.5349C17.2998 9 16.1083 8.54278 15.1901 7.71648L10.3333 3.34539Z"
					/>
				</svg>
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

/**
 * A toolbar button named beside its icon, or by its icon alone on a narrow
 * screen. A tooltip, when given, tells more than the name does.
 */
export function ToolbarTextButton({
	label,
	icon,
	tooltip,
	pressed,
	expanded,
	buttonRef,
	onClick,
}: {
	label: string;
	icon: React.ReactNode;
	tooltip?: string;
	pressed?: boolean;
	/** Whether the popup it opens is open; unset for a button that opens none. */
	expanded?: boolean;
	buttonRef?: React.Ref<HTMLButtonElement>;
	onClick: () => void;
}) {
	const { setReference, getReferenceProps, tooltip: tooltipElement } = useTooltip(tooltip ?? label);
	const ref = useMergeRefs([setReference, buttonRef]);
	const descriptionId = React.useId();
	return (
		<>
			<button
				ref={ref}
				type="button"
				className="emdash-inline-ui-trigger emdash-inline-ui-text-button"
				aria-pressed={pressed}
				aria-haspopup={expanded === undefined ? undefined : "dialog"}
				aria-expanded={expanded}
				aria-describedby={tooltip === undefined ? undefined : descriptionId}
				data-open={expanded ? "" : undefined}
				{...getReferenceProps({
					onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
					onClick,
				})}
			>
				{icon}
				<span className="emdash-inline-ui-text-button-label">{label}</span>
				{/* Out of the button's name, and out of sight whatever the page's styles. */}
				{tooltip !== undefined && (
					<span id={descriptionId} aria-hidden="true" className="emdash-inline-ui-sr-only">
						{tooltip}
					</span>
				)}
			</button>
			{tooltip === undefined ? null : tooltipElement}
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
 * A toolbar button that opens a menu below the toolbar, lined up with the
 * toolbar's start edge, or its end edge for `bottom-end`. Choosing an item
 * or pressing Escape or Tab returns to the editor, so typing carries on there.
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
	const triggerRef = React.useRef<HTMLButtonElement | null>(null);
	const focusEditor = () => {
		if (!editor.isDestroyed) editor.view.focus();
	};
	const { refs, floatingStyles, context, middlewareData, isPositioned, update } = useFloating({
		open,
		onOpenChange: (next, _event, reason) => {
			onOpenChange(next);
			if (!next && reason === "escape-key") focusEditor();
		},
		placement,
		strategy: "fixed",
		transform: false,
		middleware: [
			offset(4),
			flip({ padding: 8 }),
			shift({ padding: 8 }),
			size({
				padding: 8,
				apply: ({ availableHeight, elements }) => {
					elements.floating.style.maxHeight = `${Math.min(416, Math.max(0, availableHeight))}px`;
				},
			}),
			transformOrigin(() => triggerRef.current?.getBoundingClientRect() ?? new DOMRect()),
		],
		whileElementsMounted: autoUpdate,
	});
	React.useLayoutEffect(() => {
		// The element TipTap positions, around the toolbar, which plays its entrance as a transform.
		const toolbar = triggerRef.current?.closest('[role="toolbar"]')?.parentElement;
		if (!toolbar) return;
		let rect = new DOMRect();
		refs.setPositionReference({
			contextElement: toolbar,
			getBoundingClientRect: () => {
				// A toolbar that hides as the menu closes leaves the page, so the menu fades out where it was.
				if (toolbar.isConnected) rect = toolbar.getBoundingClientRect();
				return rect;
			},
		});
	}, [refs]);
	useRepositionOnOpen(open, update);
	const triggerRefs = useMergeRefs([refs.setReference, triggerRef]);
	const { isMounted, status } = useTransitionStatus(context, {
		duration: { open: 100, close: 75 },
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
				ref={triggerRefs}
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
			{isMounted && (
				<FloatingPortal root={root}>
					<FloatingFocusManager
						context={context}
						modal={false}
						returnFocus={false}
						disabled={status === "close"}
					>
						<div
							ref={refs.setFloating}
							style={{
								...floatingStyles,
								...originStyle(middlewareData.transformOrigin),
								visibility: isPositioned || status === "close" ? undefined : "hidden",
							}}
							className="emdash-inline-ui-menu"
							data-status={status}
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
	@keyframes emdash-inline-ui-menu-in {
		from { opacity: 0; scale: 0.97; }
	}
	@keyframes emdash-inline-ui-tooltip-in {
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
		--emdash-ui-brand: light-dark(oklch(57.72% 0.2324 260), oklch(51.948% 0.2324 260));
		--emdash-ui-tip-shadow: light-dark(oklch(92.8% 0.006 264.531), transparent);
		--emdash-ui-tip-stroke: light-dark(transparent, oklch(26.9% 0 0));
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
		cursor: default;
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
	.emdash-inline-ui-button[aria-pressed="true"],
	.emdash-inline-ui-trigger[aria-pressed="true"] {
		background: var(--emdash-ui-tint);
		color: var(--emdash-ui-link);
	}
	.emdash-inline-ui-text-button {
		gap: 6px;
		cursor: pointer;
	}
	.emdash-inline-ui-text-button > svg {
		width: 16px;
		height: 16px;
	}
	.emdash-inline-ui-button:focus-visible {
		box-shadow: 0 0 0 2px var(--emdash-ui-brand);
	}
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
	.emdash-inline-ui-field-row {
		display: flex;
		min-width: 0;
		align-items: center;
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
	}
	/*
	 * Entrances are animations: floating-ui leaves its opening status before
	 * the first paint, so a transition from it would never run. Exits are
	 * transitions, as the closing status keeps the element on the page.
	 */
	.emdash-inline-ui-menu,
	.emdash-inline-ui .emdash-slash-menu {
		animation: emdash-inline-ui-menu-in 100ms cubic-bezier(0, 0, 0.2, 1);
		transition: opacity 75ms cubic-bezier(0, 0, 0.2, 1);
	}
	.emdash-inline-ui-menu[data-status="close"],
	.emdash-inline-ui .emdash-slash-menu[data-status="close"] {
		opacity: 0;
		pointer-events: none;
	}
	.emdash-inline-ui-menu-label {
		padding: 6px 8px 2px;
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
		line-height: calc(1 / 0.85);
		outline: 1px solid var(--emdash-ui-fill);
		pointer-events: none;
		width: max-content;
		max-width: min(288px, calc(100vw - 16px));
		overflow-wrap: break-word;
		animation: emdash-inline-ui-tooltip-in 150ms cubic-bezier(0.4, 0, 0.2, 1);
		transition-property: scale, opacity;
		transition-duration: 150ms;
		transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
	}
	.emdash-inline-ui-tooltip[data-status="close"] {
		scale: 0.9;
		opacity: 0;
	}
	.emdash-inline-ui-tooltip[data-instant] {
		animation: none;
		transition-duration: 0ms;
	}
	.emdash-inline-ui-tooltip-arrow {
		position: absolute;
		display: block;
	}
	.emdash-inline-ui-tooltip-arrow[data-side="top"] {
		bottom: -8px;
		rotate: 180deg;
	}
	.emdash-inline-ui-tooltip-arrow[data-side="bottom"] {
		top: -8px;
	}
	.emdash-inline-ui-tooltip-arrow-fill {
		fill: var(--emdash-ui-raised);
	}
	.emdash-inline-ui-tooltip-arrow-shadow {
		fill: var(--emdash-ui-tip-shadow);
	}
	.emdash-inline-ui-tooltip-arrow-stroke {
		fill: var(--emdash-ui-tip-stroke);
	}
	.emdash-inline-ui .emdash-slash-menu {
		display: flex;
		width: 320px;
		max-width: calc(100vw - 16px);
		flex-direction: column;
		overflow: hidden;
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
		padding: 6px 8px 2px;
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		font-weight: 500;
		line-height: 16px;
		user-select: none;
	}
	[role="group"] + [role="group"] > .emdash-slash-menu-group-label {
		padding-block-start: 12px;
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
	@media (max-width: 639px) {
		.emdash-inline-ui-text-button {
			width: 32px;
			padding-inline: 0;
		}
		.emdash-inline-ui-text-button-label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}
	}
	@media (pointer: coarse) {
		.emdash-inline-ui-button,
		.emdash-inline-ui-trigger,
		.emdash-inline-ui-input {
			height: 44px;
		}
		/* iOS zooms the page into a field with smaller text. */
		.emdash-inline-ui-input {
			font-size: 16px;
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
	@media (max-width: 639px) and (pointer: coarse) {
		.emdash-inline-ui-text-button {
			width: 44px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.emdash-inline-ui-menu,
		.emdash-inline-ui-tooltip,
		.emdash-inline-ui .emdash-slash-menu {
			animation: none;
			transition: none;
		}
	}
`;
