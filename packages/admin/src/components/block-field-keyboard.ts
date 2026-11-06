// Keys and focus inside a blocks field: where focus can go, when it has left a control, and what
// Enter and the move keys do.

import * as React from "react";

import { revealBy, scrollerOf, scrollInstantly } from "./block-field-motion.js";

const FOCUSABLE =
	'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
// Other input types, such as number and email, throw when a script sets their selection.
export const SELECTABLE_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password"]);
const POPUP = '[role="dialog"], [role="menu"], [role="listbox"]';
/** Inputs whose Enter does something of its own. In any other, Enter submits the page's form. */
const ENTER_ACTIVATES = new Set(["button", "submit", "reset", "image", "file"]);
export const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "number"]);

export function focusableIn(element: Element | null | undefined): HTMLElement | null {
	if (!element) return null;
	const candidates = [element, ...element.querySelectorAll(FOCUSABLE)];
	return (
		candidates.find(
			(candidate): candidate is HTMLElement =>
				candidate instanceof HTMLElement &&
				candidate.matches(FOCUSABLE) &&
				candidate.tabIndex >= 0 &&
				!candidate.closest("[aria-hidden='true']") &&
				// A rich text field's toolbar comes before its text, and a hidden control can't take focus.
				!candidate.closest('[role="toolbar"]') &&
				candidate.getClientRects().length > 0,
		) ?? null
	);
}

/** How long after a pointer is let go its click can still come, as a tap's comes after the touch ends. */
const CLICK_WAIT_MS = 500;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"]);

interface PressWatch {
	/** A pointer is down, or was let go and its click hasn't come yet. */
	pressing: boolean;
	/** What waits for the press to land. */
	waiting: Set<() => void>;
	timer?: ReturnType<typeof setTimeout>;
}

const PRESS_WATCH = Symbol.for("emdash.blocks-field.press");

/** Watches the page's presses, from the first call on. */
function pressWatch(): PressWatch {
	const scope = globalThis as typeof globalThis & { [PRESS_WATCH]?: PressWatch };
	const existing = scope[PRESS_WATCH];
	if (existing) return existing;
	const watch: PressWatch = { pressing: false, waiting: new Set() };
	const land = (delay: number) => {
		clearTimeout(watch.timer);
		watch.timer = setTimeout(() => {
			watch.pressing = false;
			const waiting = [...watch.waiting];
			watch.waiting.clear();
			for (const run of waiting) run();
		}, delay);
	};
	document.addEventListener(
		"pointerdown",
		(event) => {
			// Only the primary button clicks. The others' releases can go unseen, as a native menu
			// opened by a right press takes them.
			if (event.button !== 0) return;
			clearTimeout(watch.timer);
			watch.pressing = true;
		},
		true,
	);
	document.addEventListener("pointerup", () => land(CLICK_WAIT_MS), true);
	// A press whose release the page may never see, as when a menu opens or the window goes, has
	// landed as far as anything waiting can tell.
	const landNow = () => {
		if (watch.pressing) land(0);
	};
	for (const type of ["pointercancel", "contextmenu"]) {
		document.addEventListener(type, landNow, true);
	}
	// A modifier held through a click, or repeating while held, is part of that click.
	document.addEventListener(
		"keydown",
		(event) => {
			if (event.repeat || MODIFIER_KEYS.has(event.key)) return;
			landNow();
		},
		true,
	);
	document.addEventListener("visibilitychange", landNow);
	window.addEventListener("blur", landNow);
	// Runs before the click's own handlers, so what waits runs after them.
	document.addEventListener(
		"click",
		() => {
			if (watch.pressing) land(0);
		},
		true,
	);
	scope[PRESS_WATCH] = watch;
	return watch;
}

/** Starts watching the page's presses, which a blocks field's focus handling waits on. */
export function usePressWatch() {
	React.useEffect(() => {
		pressWatch();
	}, []);
}

/**
 * Returns the function that makes a change to the layout that focus moving brings: at once, or
 * while a press is in progress, once it has landed. Only the latest change waits, and it's
 * dropped if the component goes first.
 */
export function useAfterPress() {
	const waitingRef = React.useRef<(() => void) | null>(null);
	React.useEffect(() => {
		const watch = pressWatch();
		return () => {
			if (waitingRef.current) watch.waiting.delete(waitingRef.current);
		};
	}, []);
	return React.useCallback((change: () => void) => {
		const watch = pressWatch();
		if (waitingRef.current) watch.waiting.delete(waitingRef.current);
		waitingRef.current = null;
		if (!watch.pressing) {
			change();
			return;
		}
		const run = () => {
			waitingRef.current = null;
			change();
		};
		waitingRef.current = run;
		watch.waiting.add(run);
	}, []);
}

/** The live region Kumo's toast viewport draws. Its toasts are dialogs inside it, which no control opened. */
export const TOAST_REGION = '[role="region"][aria-live]';

function leftFor(container: Element, next: Element | null): boolean {
	if (next === null || container.contains(next)) return false;
	return !next.closest(POPUP) || next.closest(TOAST_REGION) !== null;
}

/**
 * Calls `callback` when focus leaves `event.currentTarget`. Focus that moves into a popup the
 * control opened, such as a menu or the media picker, or out of the window, has not left it.
 * Focus that moves into a toast has.
 *
 * Focus moved by a press leaves once the press has landed, if focus hasn't come back by then:
 * what leaving changes would otherwise move the press's target out from under the pointer, and
 * its click would land on something else.
 */
export function whenFocusLeaves(event: React.FocusEvent<HTMLElement>, callback: () => void) {
	const container = event.currentTarget;
	const next = event.relatedTarget;
	const leave = () => {
		const watch = pressWatch();
		if (!watch.pressing) {
			callback();
			return;
		}
		// Whether focus went into a popup was settled as it left. What the press did since, such
		// as open a popup, doesn't bring it back.
		watch.waiting.add(() => {
			if (!container.contains(document.activeElement)) callback();
		});
	};
	if (next instanceof Element) {
		if (leftFor(container, next)) leave();
		return;
	}
	// Clicking something that can't take focus blurs with no relatedTarget, and so does leaving
	// the window; only the first moves focus to the page. Safari doesn't focus a clicked button
	// either, so a click that lands inside the element, still under the pointer, stays in it.
	queueMicrotask(() => {
		if (
			document.hasFocus() &&
			!container.matches(":hover") &&
			leftFor(container, document.activeElement ?? document.body)
		) {
			leave();
		}
	});
}

/** Calls `callback` when focus leaves the element, rather than moving within it. */
export function onFocusLeave(callback: () => void) {
	return (event: React.FocusEvent<HTMLElement>) => whenFocusLeaves(event, callback);
}

/** The keys that move a focused row's head or menu button one place, as `aria-keyshortcuts`. */
export const MOVE_KEYS = "Alt+Shift+ArrowUp Alt+Shift+ArrowDown";

/**
 * How many places one of `MOVE_KEYS` moves a row: -1 or 1, or 0 for any other key. The control
 * keeps a move key from doing anything else, such as a menu button opening its menu.
 */
function moveStep(event: React.KeyboardEvent): -1 | 0 | 1 {
	if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return 0;
	let step: -1 | 0 | 1 = 0;
	if (event.key === "ArrowUp") step = -1;
	if (event.key === "ArrowDown") step = 1;
	if (step === 0) return 0;
	event.preventDefault();
	// A menu button's own key handler, from Base UI, runs after this one unless told not to.
	if ("preventBaseUIHandler" in event && typeof event.preventBaseUIHandler === "function") {
		event.preventBaseUIHandler();
	}
	return step;
}

/**
 * The key handler for a row's head or menu button that moves the row one place with
 * `MOVE_KEYS`, as Move up and Move down do. Focus stays on the control, and the control stays
 * where it was on screen while the list moves past it, as far as the view allows: a row moved
 * down is taken out of the page and put back, which drops its focus. A move past either end
 * calls `onEdge` instead.
 */
export function useMoveKeys(
	index: number,
	count: number,
	onMove: (to: number) => void,
	onEdge?: (edge: "first" | "last") => void,
) {
	const keepRef = React.useRef<{ control: HTMLElement; top: number } | null>(null);
	React.useLayoutEffect(() => {
		const kept = keepRef.current;
		if (!kept) return;
		keepRef.current = null;
		const { control, top } = kept;
		if (document.activeElement !== control) control.focus({ preventScroll: true });
		const scroller = scrollerOf(control);
		if (!scroller) return;
		const box = control.getBoundingClientRect();
		const moved = box.top - top;
		const by = moved + revealBy(scroller, box.top - moved, box.bottom - moved);
		if (Math.abs(by) >= 0.5) scrollInstantly(scroller, by);
	});
	return (event: React.KeyboardEvent<HTMLElement>) => {
		const step = moveStep(event);
		if (step === 0) return;
		const to = index + step;
		if (to < 0 || to >= count) {
			onEdge?.(to < 0 ? "first" : "last");
			return;
		}
		const control = event.currentTarget;
		keepRef.current = { control, top: control.getBoundingClientRect().top };
		onMove(to);
	};
}

/** The offset in the text under a point, when that text is inside `within`. */
export function textOffsetAt(x: number, y: number, within: Element | null): number | undefined {
	if (!within) return undefined;
	if (typeof document.caretPositionFromPoint === "function") {
		const position = document.caretPositionFromPoint(x, y);
		return position && within.contains(position.offsetNode) ? position.offset : undefined;
	}
	const range = document.caretRangeFromPoint?.(x, y);
	return range && within.contains(range.startContainer) ? range.startOffset : undefined;
}

function isTextField(element: Element): element is HTMLElement {
	if (element instanceof HTMLTextAreaElement) return true;
	if (element instanceof HTMLElement && element.isContentEditable) return true;
	return (
		element instanceof HTMLInputElement &&
		TEXT_INPUT_TYPES.has(element.type) &&
		element.getAttribute("role") !== "combobox"
	);
}

/**
 * Enter in a block's one-line field moves to the next place to type in its list item or block,
 * the way it starts a new line in a list of lines, instead of saving the page. With Shift or Alt
 * it does nothing.
 */
export function keepEnterInBlocks(event: React.KeyboardEvent<HTMLElement>) {
	const input = event.target;
	if (event.key !== "Enter" || event.defaultPrevented || event.ctrlKey || event.metaKey) return;
	if (!(input instanceof HTMLInputElement) || ENTER_ACTIVATES.has(input.type)) return;
	if (event.nativeEvent.isComposing || event.keyCode === 229) return;
	// Keys from a popup the field opened, such as the block picker, reach here through its portal.
	if (!event.currentTarget.contains(input)) return;
	event.preventDefault();
	if (event.altKey || event.shiftKey || !isTextField(input)) return;
	const scope = input.closest("[data-list-item]") ?? input.closest("[data-block-body]");
	const next = [
		...(scope?.querySelectorAll('input, textarea, [contenteditable="true"]') ?? []),
	].find(
		(candidate) =>
			input.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING &&
			isTextField(candidate) &&
			focusableIn(candidate) === candidate &&
			!candidate.closest("[inert]"),
	);
	if (!(next instanceof HTMLElement)) return;
	next.focus();
	if (
		next instanceof HTMLTextAreaElement ||
		(next instanceof HTMLInputElement && SELECTABLE_INPUT_TYPES.has(next.type))
	) {
		next.setSelectionRange(next.value.length, next.value.length);
	}
}
