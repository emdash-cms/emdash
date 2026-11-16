// How a blocks field's rows and panels move: rows growing in, shrinking away, sliding to new
// places and settling after a drop, and panels opening and closing, all on one curve and holding
// the reader's place on the page.

import { type DragEndEvent, useDndMonitor } from "@dnd-kit/core";
import { CaretRight } from "@phosphor-icons/react";
import * as React from "react";
import { flushSync } from "react-dom";

import { useStableCallback } from "../lib/hooks.js";
import { cn } from "../lib/utils.js";
import {
	DISCLOSURE_CURVE,
	DISCLOSURE_EASE,
	DISCLOSURE_MS,
	EASE_EMDASH,
} from "./block-field-styles.js";

const OPEN_MS = DISCLOSURE_MS.open;
const CLOSE_MS = DISCLOSURE_MS.close;
/** The shortest a reversed panel takes, so its first frame doesn't snap. */
const REVERSE_MS = 120;
/** How long a dropped or moved row takes to slide into its place. */
const SLIDE_MS = 200;
/** How long a lifted row's shadow takes to fade, the same as its `after:duration-150`. */
const SHADOW_MS = 150;
/** The space kept under a row brought into view, so whatever follows it shows too. */
const REVEAL_ROOM = 48;

const noop = () => {};

export function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** One axis of a cubic Bézier from (0, 0) to (1, 1), with control points `a` and `b`, at `t`. */
function bezierAt(a: number, b: number, t: number): number {
	return 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3;
}

function bezierSlope(a: number, b: number, t: number): number {
	return 3 * a * (1 - t) ** 2 + 6 * (b - a) * t * (1 - t) + 3 * (1 - b) * t ** 2;
}

/** A CSS `cubic-bezier()` easing, as a function from time to progress, both 0–1. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (time: number) => number {
	return (time) => {
		let t = time;
		for (let step = 0; step < 8; step++) {
			const error = bezierAt(x1, x2, t) - time;
			const gradient = bezierSlope(x1, x2, t);
			if (Math.abs(error) < 1e-4 || gradient === 0) break;
			t = Math.min(1, Math.max(0, t - error / gradient));
		}
		return bezierAt(y1, y2, t);
	};
}

const disclosureProgress = cubicBezier(...DISCLOSURE_CURVE);

/** The nearest ancestor of `element` that scrolls, or the page when it scrolls. */
export function scrollerOf(element: Element): HTMLElement | null {
	for (let node = element.parentElement; node; node = node.parentElement) {
		const { overflowY } = getComputedStyle(node);
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
			return node;
		}
	}
	const page = document.scrollingElement;
	return page instanceof HTMLElement && page.scrollHeight > page.clientHeight ? page : null;
}

export function scrollInstantly(scroller: HTMLElement, by: number) {
	scroller.scrollBy({ top: by, behavior: "instant" });
}

function viewBottom(scroller: HTMLElement | null): number {
	if (!scroller || scroller === document.scrollingElement) return window.innerHeight;
	return scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
}

function viewEdge(scroller: HTMLElement | null): number {
	if (!scroller || scroller === document.scrollingElement) return 0;
	return scroller.getBoundingClientRect().top + scroller.clientTop;
}

/** How much of a box `height` tall, at `top`, shows above the scroller's bottom edge. */
function shownPart(scroller: HTMLElement | null, top: number, height: number): number {
	return Math.max(0, Math.min(height, viewBottom(scroller) - top));
}

/**
 * How far to scroll `scroller` so a box from `top` to `bottom` shows below its scroll padding,
 * which keeps clear of a pinned head, with room under it. A box taller than the view keeps its
 * top in view.
 */
export function revealBy(scroller: HTMLElement, top: number, bottom: number): number {
	const style = getComputedStyle(scroller);
	const start = viewEdge(scroller) + (Number.parseFloat(style.scrollPaddingTop) || 0);
	if (top < start) return top - start;
	const end = viewBottom(scroller) - (Number.parseFloat(style.scrollPaddingBottom) || 0);
	const past = bottom + REVEAL_ROOM - end;
	return past > 0 ? Math.min(past, top - start) : 0;
}

/**
 * Scrolls `scroller` by `by` on the disclosure curve, in step with the rows that move as it does.
 * The reader scrolling stops it.
 */
function scrollAlong(scroller: HTMLElement, by: number, duration: number) {
	if (Math.abs(by) < 1) return;
	if (prefersReducedMotion()) {
		scrollInstantly(scroller, by);
		return;
	}
	const from = scroller.scrollTop;
	let last = from;
	let start: number | undefined;
	const step = (now: number) => {
		if (Math.abs(scroller.scrollTop - last) > 1) return;
		start ??= now;
		const progress = Math.min(1, (now - start) / duration);
		scroller.scrollTop = from + by * disclosureProgress(progress);
		last = scroller.scrollTop;
		if (progress < 1) requestAnimationFrame(step);
	};
	requestAnimationFrame(step);
}

/**
 * Brings `element` into view below `scroller`'s scroll padding the shortest way, on the disclosure
 * curve, when any of it is out of view. One taller than the view keeps its top in view.
 */
export function bringIntoView(element: Element) {
	const scroller = scrollerOf(element);
	if (!scroller) return;
	const { top, bottom } = element.getBoundingClientRect();
	const style = getComputedStyle(scroller);
	const start = viewEdge(scroller) + (Number.parseFloat(style.scrollPaddingTop) || 0);
	const end = viewBottom(scroller) - (Number.parseFloat(style.scrollPaddingBottom) || 0);
	let by = 0;
	if (top < start) by = top - start;
	else if (bottom > end) by = Math.min(bottom - end, top - start);
	scrollAlong(scroller, by, OPEN_MS);
}

/**
 * Grows a row just added from nothing to its height, so the rows below glide down instead of
 * jumping, and brings it into view with room under it, unless `reveal` is false, as for a row put
 * back where it was. Only the part that will be in view grows.
 */
export function growRow(row: HTMLElement, { reveal = true }: { reveal?: boolean } = {}) {
	const scroller = scrollerOf(row);
	const { top, height } = row.getBoundingClientRect();
	const by = scroller && reveal ? revealBy(scroller, top, top + height) : 0;
	if (scroller) scrollAlong(scroller, by, OPEN_MS);
	// A row whose top is out of view appears at once, as one shrinking away there goes at once.
	if (prefersReducedMotion() || top - by < viewEdge(scroller)) return;
	const to = shownPart(scroller, top - by, height);
	if (to < 1) return;
	const grow = row.animate(
		{
			height: ["0px", `${to}px`],
			minHeight: ["0px", "0px"],
			opacity: [0, 1],
			clipPath: ["inset(0)", "inset(0)"],
		},
		{ duration: OPEN_MS, easing: DISCLOSURE_EASE },
	);
	// Mounting the row's fields can make a long frame, which would otherwise count as part of the
	// motion, so the row holds at nothing through it and starts on the next frame.
	grow.pause();
	requestAnimationFrame(() => {
		if (grow.playState === "paused") grow.play();
	});
}

/** A row shrinking away before it's deleted. */
export interface RowCollapse {
	/** Calls the deletion off: the row grows back from wherever it has got to. */
	reverse: () => void;
}

/**
 * Shrinks a row being deleted to nothing, so the rows below glide up and the page holds still,
 * then calls `remove` to take it out, and `settled` once it's out or back. Only the part in view
 * shrinks, and a row whose top is scrolled away goes at once. A row that leaves the page while it
 * shrinks, as when the whole value is replaced, isn't removed again.
 *
 * `remove` is told whether focus is still the deletion's to place. It isn't once focus has moved
 * on from the row to another control while the row shrank, as a press on another menu moves it.
 */
export function collapseRow(
	row: HTMLElement,
	remove: (placeFocus: boolean) => void,
	settled: () => void = noop,
): RowCollapse | null {
	const scroller = scrollerOf(row);
	const { top, height } = row.getBoundingClientRect();
	const from = shownPart(scroller, top, height);
	if (prefersReducedMotion() || from < 1 || top < viewEdge(scroller)) {
		remove(true);
		return null;
	}
	const release = holdScroll(scroller, row);
	const shrink = row.animate(
		{
			height: [`${from}px`, "0px"],
			minHeight: ["0px", "0px"],
			opacity: [1, 0],
			clipPath: ["inset(0)", "inset(0)"],
		},
		{ duration: CLOSE_MS, easing: DISCLOSURE_EASE, fill: "forwards" },
	);
	let reversed = false;
	shrink.addEventListener("finish", () => {
		// A reversal that came after the row had shrunk away, but before this, runs its course.
		if (shrink.playState === "running") return;
		if (!reversed && row.isConnected) {
			const focus = document.activeElement;
			const placeFocus = !focus || focus === document.body || row.contains(focus);
			flushSync(() => remove(placeFocus));
		}
		// A row that wasn't taken out after all comes back.
		if (row.isConnected) shrink.cancel();
		release();
		settled();
	});
	return {
		reverse() {
			if (reversed || (shrink.playState !== "running" && shrink.playState !== "finished")) return;
			reversed = true;
			shrink.reverse();
		},
	};
}

/**
 * Glides the element `ref` holds from its old height to its new one whenever `cause` changes, as
 * a problem coming onto a label's line can wrap it, so whatever follows moves smoothly instead of
 * in one frame. Changes from anything else, such as a resize, aren't animated.
 */
export function useHeightGlide(ref: React.RefObject<HTMLElement | null>, cause: unknown) {
	const heightRef = React.useRef<number | null>(null);
	const glideRef = React.useRef<Animation | null>(null);
	const causeRef = React.useRef(cause);

	React.useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			if (!glideRef.current) heightRef.current = element.getBoundingClientRect().height;
		};
		measure();
		const resizes = new ResizeObserver(measure);
		resizes.observe(element);
		return () => resizes.disconnect();
	}, [ref]);

	React.useLayoutEffect(() => {
		if (Object.is(causeRef.current, cause)) return;
		causeRef.current = cause;
		const element = ref.current;
		if (!element) return;
		const previous = glideRef.current;
		const from = previous ? element.getBoundingClientRect().height : heightRef.current;
		glideRef.current = null;
		previous?.cancel();
		const to = element.getBoundingClientRect().height;
		heightRef.current = to;
		if (from === null || Math.abs(to - from) < 0.5 || prefersReducedMotion()) return;
		const glide = element.animate(
			{ height: [`${from}px`, `${to}px`], clipPath: ["inset(0)", "inset(0)"] },
			{ duration: to > from ? OPEN_MS : CLOSE_MS, easing: DISCLOSURE_EASE },
		);
		glideRef.current = glide;
		glide.addEventListener("finish", () => {
			if (glideRef.current !== glide) return;
			glideRef.current = null;
			heightRef.current = element.getBoundingClientRect().height;
		});
	}, [ref, cause]);

	React.useEffect(() => () => glideRef.current?.cancel(), []);
}

/** Slides `node` back into its place from `x`, `y` away, on top of any transform it has. */
function slideFrom(node: HTMLElement, x: number, y: number): Animation {
	return node.animate(
		{ transform: [`translate(${x}px, ${y}px)`, "none"] },
		{ duration: SLIDE_MS, easing: DISCLOSURE_EASE, composite: "add" },
	);
}

/**
 * Slides the rows a menu reorders from their old places to their new ones, instead of letting
 * them jump, and brings the moved row into view. Call the returned function with the moved row's
 * key just before the move. Rows are the elements in `rootRef` that carry `attribute`.
 */
export function useReorderMotion(
	rootRef: React.RefObject<HTMLElement | null>,
	attribute: "data-block-key" | "data-item-key",
) {
	const pendingRef = React.useRef<{
		moved: string;
		order: string;
		tops: Map<string, number>;
	} | null>(null);
	const rowsIn = (root: HTMLElement) =>
		Array.from(root.querySelectorAll<HTMLElement>(`[${attribute}]`), (row) => ({
			row,
			key: row.getAttribute(attribute) ?? "",
		}));

	React.useLayoutEffect(() => {
		const pending = pendingRef.current;
		const root = rootRef.current;
		if (!pending || !root) return;
		const rows = rowsIn(root);
		// The moved value can come back from the parent a render later.
		if (rows.map(({ key }) => key).join(" ") === pending.order) return;
		pendingRef.current = null;
		const moved = rows.find(({ key }) => key === pending.moved)?.row;
		const scroller = moved ? scrollerOf(moved) : null;
		if (moved && scroller) {
			const { top, bottom } = moved.getBoundingClientRect();
			scrollAlong(scroller, revealBy(scroller, top, bottom), SLIDE_MS);
		}
		if (prefersReducedMotion()) return;
		const origin = root.getBoundingClientRect().top;
		for (const { row, key } of rows) {
			const before = pending.tops.get(key);
			if (before === undefined) continue;
			const y = before - (row.getBoundingClientRect().top - origin);
			if (Math.abs(y) >= 0.5) slideFrom(row, 0, y);
		}
	});

	return (moved: string) => {
		const root = rootRef.current;
		if (!root) return;
		const origin = root.getBoundingClientRect().top;
		const rows = rowsIn(root);
		pendingRef.current = {
			moved,
			order: rows.map(({ key }) => key).join(" "),
			tops: new Map(rows.map(({ row, key }) => [key, row.getBoundingClientRect().top - origin])),
		};
	};
}

/**
 * How far a panel `height` tall, at `top`, moves. One taller than the scroller moves only down to
 * its bottom edge: the rest of its travel would be out of sight, and would crowd the part in
 * sight into the first frames.
 */
function travel(scroller: HTMLElement | null, top: number, height: number): number {
	const bottom = viewBottom(scroller);
	if (top >= bottom) return 0;
	return height > (scroller?.clientHeight ?? window.innerHeight)
		? Math.min(height, bottom - top)
		: height;
}

interface ScrollRoom {
	/** Space added under the content. */
	room: number;
	/** The panels closing now, each by how far it still has to shrink. */
	closing: Set<() => number>;
	/** The rows whose panels made the room. */
	owners: Set<Element>;
	trim: () => void;
	set: (room: number) => void;
}

const scrollRooms = new WeakMap<HTMLElement, ScrollRoom>();

function scrollRoomOf(scroller: HTMLElement): ScrollRoom {
	const existing = scrollRooms.get(scroller);
	if (existing) return existing;
	const events: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
	const resizes = new ResizeObserver(() => state.trim());
	const swaps = new MutationObserver(() => {
		for (const child of scroller.children) resizes.observe(child);
		state.trim();
	});
	let base = { top: 0, end: 0, width: 0 };
	const state: ScrollRoom = {
		room: 0,
		closing: new Set(),
		owners: new Set(),
		set(room) {
			if (state.room === 0) {
				const style = getComputedStyle(scroller);
				base = {
					top: Number.parseFloat(style.paddingBlockStart) || 0,
					end: Number.parseFloat(style.paddingBlockEnd) || 0,
					width: scroller.clientWidth,
				};
			}
			// Padding past the scroller's own height would grow its box, not its content.
			const next = Math.max(
				0,
				Math.min(Math.ceil(room), scroller.clientHeight - base.top - base.end),
			);
			if (next > 0 && state.room === 0) {
				events.addEventListener("scroll", state.trim, { passive: true });
				for (const child of scroller.children) resizes.observe(child);
				swaps.observe(scroller, { childList: true });
			}
			state.room = next;
			if (next > 0) {
				scroller.style.setProperty("padding-block-end", `${base.end + next}px`);
				return;
			}
			scroller.style.removeProperty("padding-block-end");
			events.removeEventListener("scroll", state.trim);
			resizes.disconnect();
			swaps.disconnect();
			if (state.closing.size === 0) scrollRooms.delete(scroller);
		},
		// As the reader scrolls back up, or the content grows, the room shrinks to what keeps the
		// scroller where it is. It goes once the rows that made it are gone, or the scroller's
		// width changed, since its padding may then differ.
		trim() {
			if (state.closing.size > 0) return;
			if (
				scroller.clientWidth !== base.width ||
				![...state.owners].some((owner) => owner.isConnected)
			) {
				state.set(0);
				return;
			}
			const content = scroller.scrollHeight - state.room;
			state.set(Math.min(state.room, scroller.scrollTop + scroller.clientHeight - content));
		},
	};
	scrollRooms.set(scroller, state);
	return state;
}

/**
 * Keeps `scroller` where it is while `panel` shrinks away. When the content would end above the
 * scroller's bottom, room is added under it, so the row being closed stays under the pointer
 * instead of the page sliding down to meet the shorter content. Returns the function that ends
 * the hold, for once the panel has shrunk.
 */
function holdScroll(scroller: HTMLElement | null, panel: HTMLElement): () => void {
	const left = () => (panel.isConnected ? panel.getBoundingClientRect().height : 0);
	if (!scroller || left() <= 0) return noop;
	const state = scrollRoomOf(scroller);
	state.closing.add(left);
	if (panel.parentElement) state.owners.add(panel.parentElement);
	// The content already lacks whatever the other closing panels have shrunk so far.
	let shrink = 0;
	for (const remaining of state.closing) shrink += remaining();
	const content = scroller.scrollHeight - state.room;
	const needed = scroller.scrollTop + scroller.clientHeight - (content - shrink);
	if (needed > state.room) state.set(needed);
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		state.closing.delete(left);
		state.trim();
	};
}

/**
 * Notes where the head of the first of `rows` still in view sits, and returns the function that
 * scrolls it back there once the rows have all opened or closed at once, so the reader keeps their
 * place. A head may be pinned, so afterwards it's found where an unpinned head sits: at the top
 * of its row. With every row above the view, the end of the last one stays put instead.
 */
export function keepRowInView(
	rows: readonly HTMLElement[],
	headOf: (row: HTMLElement) => Element,
): () => void {
	const last = rows.at(-1);
	const scroller = last ? scrollerOf(last) : null;
	if (!last || !scroller) return noop;
	const top =
		scroller === document.scrollingElement
			? 0
			: scroller.getBoundingClientRect().top + scroller.clientTop;
	const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > top);
	const before = row
		? headOf(row).getBoundingClientRect().top
		: last.getBoundingClientRect().bottom;
	return () => {
		const after = row
			? row.getBoundingClientRect().top + row.clientTop
			: last.getBoundingClientRect().bottom;
		if (Math.abs(after - before) >= 0.5) scrollInstantly(scroller, after - before);
	};
}

/**
 * Turns the caret of the toggle that controls `panel` to where it's going over `duration`, in
 * place of its own transition, so a reversed panel and its caret land together.
 */
function turnCaretWith(panel: HTMLElement, duration: number) {
	if (!panel.id) return;
	const caret = document
		.querySelector(`[aria-controls="${window.CSS.escape(panel.id)}"]`)
		?.querySelector("[data-disclosure-caret]");
	if (!(caret instanceof SVGElement)) return;
	const from = getComputedStyle(caret).rotate;
	for (const animation of caret.getAnimations()) animation.cancel();
	const to = getComputedStyle(caret).rotate;
	if (from !== to) caret.animate({ rotate: [from, to] }, { duration, easing: DISCLOSURE_EASE });
}

interface PanelMotion {
	height: Animation;
	/** Holds the content drawn up by `lift` while the panel closes under its pinned head. */
	content?: Animation;
	lift: number;
	release: () => void;
	/** Puts the panel where the motion ends. */
	finish: () => void;
}

function liftContent(panel: HTMLElement, lift: number, duration: number): Animation | undefined {
	const content = panel.firstElementChild;
	if (lift <= 0 || !content) return undefined;
	const transform = `translateY(${-lift}px)`;
	return content.animate({ transform: [transform, transform] }, { duration, fill: "forwards" });
}

/**
 * The body of a block, a list item or the Advanced rows: grows open and shrinks closed, then
 * unmounts. Padding belongs on a child, since the panel's own height runs down to zero.
 *
 * Motion starts from wherever the panel is, so a toggle can be reversed midway, and only covers
 * what the scroller shows: the part of a tall panel below its bottom edge appears or goes at once.
 * The clip lasts only as long as the motion, so sticky toolbars and floating hints inside aren't
 * cut off at rest.
 */
export function DisclosurePanel({
	open,
	instant = false,
	headRef,
	onClosed,
	className,
	...props
}: {
	open: boolean;
	/** Opens or closes without motion, as Expand all and Collapse all do. */
	instant?: boolean;
	/**
	 * The panel's head. When it's pinned over a scrolled panel, the panel closes in place: the
	 * fields in view stay put and the rows below rise to meet the head.
	 */
	headRef?: React.RefObject<HTMLElement | null>;
	/** Called once a closed panel is gone. */
	onClosed?: () => void;
} & React.ComponentPropsWithoutRef<"div">) {
	const ref = React.useRef<HTMLDivElement>(null);
	const motionRef = React.useRef<PanelMotion | null>(null);
	const shownRef = React.useRef(open);
	const [mounted, setMounted] = React.useState(open);
	if (open && !mounted) setMounted(true);
	const unmount = useStableCallback(() => {
		setMounted(false);
		onClosed?.();
	});

	React.useLayoutEffect(() => {
		if (open === shownRef.current) {
			// Expand all and Collapse all also finish a panel already on its way.
			const motion = motionRef.current;
			if (instant && motion) {
				motionRef.current = null;
				motion.finish();
			}
			return;
		}
		shownRef.current = open;
		const panel = ref.current;
		if (!panel) return;
		const scroller = scrollerOf(panel);
		const previous = motionRef.current;
		motionRef.current = null;
		const current = panel.getBoundingClientRect().height;
		const opacity = previous ? Number(getComputedStyle(panel).opacity) : open ? 0 : 1;
		let lift = previous?.lift ?? 0;
		previous?.height.cancel();
		previous?.content?.cancel();
		// A close being reversed keeps holding the scroller until the panel is open again.
		const held = previous?.release ?? noop;
		const still = instant || prefersReducedMotion();

		if (open) {
			// An open panel takes the place of any room a close left under the content.
			const restore = () => {
				if (scroller && lift > 0) scrollInstantly(scroller, lift);
				held();
				if (scroller) scrollRooms.get(scroller)?.trim();
			};
			if (still) {
				restore();
				return;
			}
			const { top, height: natural } = panel.getBoundingClientRect();
			const from = previous ? current : 0;
			const to = Math.max(from, travel(scroller, top, natural - lift));
			if (to - from < 1) {
				restore();
				return;
			}
			// A reversal takes the share of the time that is left of the way, but never so little
			// that it snaps, and turns the caret on the same clock.
			const duration = previous ? Math.max(REVERSE_MS, OPEN_MS * ((to - from) / to)) : OPEN_MS;
			if (previous) turnCaretWith(panel, duration);
			const height = panel.animate(
				{
					height: [`${from}px`, `${to}px`],
					opacity: [opacity, 1],
					clipPath: ["inset(0)", "inset(0)"],
				},
				{ duration, easing: DISCLOSURE_EASE, fill: lift > 0 ? "forwards" : "none" },
			);
			const motion: PanelMotion = {
				height,
				content: liftContent(panel, lift, duration),
				lift,
				release: held,
				finish() {
					height.cancel();
					motion.content?.cancel();
					restore();
				},
			};
			motionRef.current = motion;
			height.addEventListener("finish", () => {
				if (motionRef.current !== motion) return;
				motionRef.current = null;
				motion.finish();
			});
			return;
		}

		// Expand all and Collapse all keep the reader's place themselves, once every panel has moved.
		if (instant) {
			held();
			unmount();
			return;
		}
		let shown = current;
		let hidden = 0;
		const head = headRef?.current;
		if (head && scroller) {
			// A head pinned over the panel hides the part above it. Scrolling the block's top up to
			// the head while drawing the content up as far leaves everything in view where it was.
			const pinned = Math.round(
				head.getBoundingClientRect().bottom - panel.getBoundingClientRect().top,
			);
			if (pinned > 0) {
				scrollInstantly(scroller, -pinned);
				lift += pinned;
				shown = Math.max(0, shown - pinned);
				hidden = pinned;
			}
		}
		const { top, height: natural } = panel.getBoundingClientRect();
		const release = holdScroll(scroller, panel);
		held();
		const from = travel(scroller, top, shown);
		if (still || from < 1) {
			unmount();
			requestAnimationFrame(release);
			return;
		}
		const full = previous ? travel(scroller, top, natural - hidden) : from;
		const duration = previous
			? Math.max(REVERSE_MS, CLOSE_MS * Math.min(1, from / Math.max(from, full)))
			: CLOSE_MS;
		if (previous) turnCaretWith(panel, duration);
		const height = panel.animate(
			{
				height: [`${from}px`, "0px"],
				opacity: [opacity, 0],
				clipPath: ["inset(0)", "inset(0)"],
			},
			{ duration, easing: DISCLOSURE_EASE, fill: "forwards" },
		);
		const motion: PanelMotion = {
			height,
			content: liftContent(panel, lift, duration),
			lift,
			release,
			finish() {
				height.finish();
				release();
				unmount();
			},
		};
		motionRef.current = motion;
		height.addEventListener("finish", () => {
			if (motionRef.current !== motion) return;
			motionRef.current = null;
			motion.finish();
		});
	}, [open, instant, headRef, unmount]);

	React.useEffect(() => () => motionRef.current?.release(), []);

	if (!mounted) return null;
	return (
		<div
			ref={ref}
			inert={!open || undefined}
			className={cn("emdash-disclosure", className)}
			{...props}
		/>
	);
}

/**
 * A dragged row eases from where it was let go into its slot, still lifted, instead of jumping
 * there. Returns the sortable's node ref, wrapped, and whether the row is still settling.
 */
export function useDropSettle(
	id: string,
	isDragging: boolean,
	setSortableRef: (node: HTMLElement | null) => void,
) {
	const nodeRef = React.useRef<HTMLElement | null>(null);
	const letGoRef = React.useRef<DOMRect | null>(null);
	const settleRef = React.useRef<Animation | null>(null);
	const shadowRef = React.useRef<Animation | null>(null);
	const [settling, setSettling] = React.useState(false);
	const setNodeRef = React.useCallback(
		(node: HTMLElement | null) => {
			nodeRef.current = node;
			setSortableRef(node);
		},
		[setSortableRef],
	);
	const monitor = React.useMemo(() => {
		const letGo = ({ active }: DragEndEvent) => {
			if (active.id === id && nodeRef.current) {
				letGoRef.current = nodeRef.current.getBoundingClientRect();
			}
		};
		return { onDragEnd: letGo, onDragCancel: letGo };
	}, [id]);
	useDndMonitor(monitor);

	// Runs in the commit that drops the row, once it sits in its new slot but before it paints.
	React.useLayoutEffect(() => {
		const from = letGoRef.current;
		letGoRef.current = null;
		const node = nodeRef.current;
		const previous = settleRef.current;
		// A row picked up again while it settles stays where it was caught: the settle holds still,
		// added to the drag's own transform, until the row is let go again, and its shadow lifts again.
		if (isDragging) {
			previous?.pause();
			shadowRef.current?.cancel();
			return;
		}
		if (previous) {
			settleRef.current = null;
			previous.cancel();
			setSettling(false);
		}
		if (!from || !node || prefersReducedMotion()) return;
		const to = node.getBoundingClientRect();
		const x = from.left - to.left;
		const y = from.top - to.top;
		if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return;
		setSettling(true);
		const settle = slideFrom(node, x, y);
		// A row dropped in a new slot was moved in the page, which ends any transition on it, so its
		// lifted shadow fades out here, while it settles.
		shadowRef.current = node.animate(
			{ opacity: [1, 0] },
			{ pseudoElement: "::after", duration: SHADOW_MS, easing: EASE_EMDASH },
		);
		settleRef.current = settle;
		const done = () => {
			if (settleRef.current !== settle) return;
			settleRef.current = null;
			setSettling(false);
		};
		settle.addEventListener("finish", done);
		settle.addEventListener("cancel", done);
	}, [isDragging]);

	return { setNodeRef, settling };
}

/** The caret of a disclosure row, which turns to point at the open body as the body moves. */
export function DisclosureCaret({
	open,
	instant = false,
	className,
}: {
	open: boolean;
	instant?: boolean;
	className?: string;
}) {
	return (
		<span aria-hidden="true" className={cn("grid size-4 shrink-0 place-items-center", className)}>
			<CaretRight
				data-disclosure-caret=""
				weight="bold"
				className={cn(
					"size-3 text-kumo-subtle transition-transform duration-160 ease-emdash-disclosure motion-reduce:transition-none rtl:-scale-x-100",
					open && "rotate-90 duration-200 rtl:-rotate-90",
					instant && "transition-none",
				)}
			/>
		</span>
	);
}
