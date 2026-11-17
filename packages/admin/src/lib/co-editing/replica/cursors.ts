import type { DecorationAttrs } from "@tiptap/pm/view";
import type { Awareness } from "y-protocols/awareness";

import type { AuthorColor } from "../../author-colors.js";
import type { Clock } from "../session.js";

/** How long a person's name shows over their caret after their cursor moves. */
export const CURSOR_LABEL_MS = 2500;

interface AwarenessChange {
	added: number[];
	updated: number[];
	removed: number[];
}

interface CursorUser {
	id?: unknown;
	name?: unknown;
}

/**
 * The other clients' carets and selections in rich text. The cursor plugin rebuilds them on every
 * awareness change and remote edit, and ProseMirror reuses a caret's element only sometimes: it
 * keeps it while its person moves within a paragraph, and makes a new one when the caret moves to
 * another block or someone formats the text around it. So a caret's name shows from the time its
 * person's cursor last moved, never from when its element was made, and others' edits never
 * flash it.
 */
export class RemoteCursors {
	readonly #awareness: Awareness;
	readonly #clock: Clock;
	readonly #colorOf: (userId: string | null) => AuthorColor;
	/** Each client's last cursor, kept after it leaves, so a rejoin isn't a move. */
	readonly #cursors = new Map<number, string>();
	readonly #movedAt = new Map<number, number>();
	readonly #timers = new Map<number, unknown>();
	readonly #carets = new Map<number, Set<HTMLElement>>();
	#frame = 0;
	readonly #unfitted = new Set<HTMLElement>();

	constructor(awareness: Awareness, clock: Clock, colorOf: (userId: string | null) => AuthorColor) {
		this.#awareness = awareness;
		this.#clock = clock;
		this.#colorOf = colorOf;
		awareness.on("change", this.#onChange);
	}

	readonly caret = (user: CursorUser, clientId: number): HTMLElement => {
		const caret = document.createElement("span");
		caret.className = "emdash-remote-caret";
		caret.setAttribute("data-author-color", this.#colorOf(userId(user)));
		caret.setAttribute("data-user", userId(user) ?? "");
		const label = document.createElement("span");
		label.className = "emdash-presence-pill emdash-remote-caret-label";
		// The name takes its own direction, and its `dir` keeps it out of the editor's
		// `dir="auto"`, which it would turn left-to-right at the start of a right-to-left document.
		// The label itself keeps the paragraph's direction, which places it.
		const name = document.createElement("span");
		name.dir = "auto";
		name.textContent = typeof user.name === "string" ? user.name : "";
		label.append(name);
		// Word joiners keep the caret from opening a line break where it sits.
		caret.append("\u2060", label, "\u2060");
		caret.toggleAttribute("data-active", this.#active(clientId));
		caret.addEventListener("pointerenter", () => this.#fit(caret));
		let carets = this.#carets.get(clientId);
		if (!carets) this.#carets.set(clientId, (carets = new Set()));
		for (const old of carets) if (!old.isConnected) carets.delete(old);
		carets.add(caret);
		this.#fit(caret);
		return caret;
	};

	readonly selection = (user: CursorUser): DecorationAttrs => ({
		class: "emdash-remote-selection",
		"data-author-color": this.#colorOf(userId(user)),
	});

	/** Gives the carets on screen their people's colors again, after the colors change. */
	recolor(): void {
		for (const carets of this.#carets.values()) {
			for (const caret of carets) {
				caret.setAttribute("data-author-color", this.#colorOf(caret.getAttribute("data-user")));
			}
		}
	}

	dispose(): void {
		this.#awareness.off("change", this.#onChange);
		for (const timer of this.#timers.values()) this.#clock.clearTimeout(timer);
		this.#timers.clear();
		this.#carets.clear();
		if (this.#frame) cancelAnimationFrame(this.#frame);
	}

	readonly #onChange = ({ added, updated, removed }: AwarenessChange): void => {
		const own = this.#awareness.clientID;
		for (const clientId of [...added, ...updated]) {
			if (clientId === own) continue;
			const cursor: unknown = this.#awareness.getStates().get(clientId)?.cursor ?? null;
			const key = cursor === null ? null : JSON.stringify(cursor);
			if (key === (this.#cursors.get(clientId) ?? null)) continue;
			if (key === null) this.#cursors.delete(clientId);
			else this.#cursors.set(clientId, key);
			if (key !== null) this.#moved(clientId);
		}
		for (const clientId of removed) {
			this.#clock.clearTimeout(this.#timers.get(clientId));
			this.#timers.delete(clientId);
			this.#movedAt.delete(clientId);
			this.#carets.delete(clientId);
		}
	};

	#moved(clientId: number): void {
		this.#movedAt.set(clientId, this.#clock.now());
		this.#show(clientId, true);
		this.#clock.clearTimeout(this.#timers.get(clientId));
		this.#timers.set(
			clientId,
			this.#clock.setTimeout(() => {
				this.#timers.delete(clientId);
				this.#show(clientId, false);
			}, CURSOR_LABEL_MS),
		);
	}

	#active(clientId: number): boolean {
		const movedAt = this.#movedAt.get(clientId);
		return movedAt !== undefined && this.#clock.now() - movedAt < CURSOR_LABEL_MS;
	}

	#show(clientId: number, active: boolean): void {
		for (const caret of this.#carets.get(clientId) ?? []) {
			caret.toggleAttribute("data-active", active);
			if (active) this.#fit(caret);
		}
	}

	/** Keeps the caret's label inside the editor, on the next frame once ProseMirror placed it. */
	#fit(caret: HTMLElement): void {
		if (typeof requestAnimationFrame === "undefined") return;
		this.#unfitted.add(caret);
		if (this.#frame) return;
		this.#frame = requestAnimationFrame(() => {
			this.#frame = 0;
			const carets = [...this.#unfitted].filter((element) => element.isConnected);
			this.#unfitted.clear();
			const placements = carets.map(placeLabel);
			carets.forEach((element, index) => applyPlacement(element, placements[index]));
		});
	}
}

interface Placement {
	/** How far the label moves toward the inline start, to end inside the editor. */
	shift: number;
	/** The label would be cut off above the caret, so it goes under it. */
	below: boolean;
}

/**
 * Reads where the label would sit unshifted. It stays within the editor's width, and goes under
 * the caret only where whatever clips the editor would cut it off above.
 */
function placeLabel(caret: HTMLElement): Placement | undefined {
	const label = caret.querySelector<HTMLElement>(".emdash-remote-caret-label");
	const editor = caret.closest<HTMLElement>(".ProseMirror");
	if (!label || !editor) return undefined;
	const box = editor.getBoundingClientRect();
	const clip = clippingAncestor(editor)?.getBoundingClientRect();
	const start = Math.max(box.left, clip?.left ?? -Infinity) + LABEL_INSET_PX;
	const end = Math.min(box.right, clip?.right ?? Infinity) - LABEL_INSET_PX;
	const at = caret.getBoundingClientRect();
	const width = label.offsetWidth;
	const rtl = getComputedStyle(caret).direction === "rtl";
	const overflow = rtl ? start - (at.right - width) : at.left + width - end;
	const room = rtl ? end - at.right : at.left - start;
	return {
		shift: Math.round(Math.max(0, Math.min(overflow, room))),
		below: at.top - label.offsetHeight < (clip?.top ?? 0),
	};
}

/** The least space a shifted label keeps from the editor's edge. */
const LABEL_INSET_PX = 4;

const clippers = new WeakMap<Element, Element | null>();

/** The nearest ancestor that cuts off what overflows it, or null for the viewport. */
function clippingAncestor(element: Element): Element | null {
	if (clippers.has(element)) return clippers.get(element) ?? null;
	let found: Element | null = null;
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const { overflowX, overflowY } = getComputedStyle(parent);
		if (overflowX !== "visible" || overflowY !== "visible") {
			found = parent;
			break;
		}
	}
	clippers.set(element, found);
	return found;
}

function applyPlacement(caret: HTMLElement, placement: Placement | undefined): void {
	if (!placement) return;
	caret.style.setProperty("--emdash-caret-label-shift", `${placement.shift}px`);
	caret.toggleAttribute("data-shifted", placement.shift > 0);
	caret.toggleAttribute("data-below", placement.below);
}

function userId(user: CursorUser): string | null {
	return typeof user.id === "string" ? user.id : null;
}
