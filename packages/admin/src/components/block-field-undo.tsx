// The page's one Undo for a blocks field's deletions: its toast, and Mod+Z while that toast is open.

import { useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useStableCallback } from "../lib/hooks.js";
import type { DeletionHold } from "./BlockListField.js";
import type { ImageFieldValue } from "./ImageFieldRenderer.js";

const UNDO_TIMEOUT_MS = 6000;
/**
 * Reaching a toast from the keyboard takes longer, so a deletion made from it keeps its Undo
 * longer. So does one made from assistive technology, which presses nothing on the page.
 */
const KEYBOARD_UNDO_TIMEOUT_MS = 15_000;
/** How soon after a press of the pointer a deletion counts as made with it. */
const POINTER_DELETION_MS = 2000;

type UndoOwner =
	| { kind: "block" }
	| { kind: "item"; blockKey: string; field: string }
	| { kind: "field"; name: string };

const APPLE_PLATFORM =
	typeof navigator !== "undefined" &&
	/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const UNDO_KEYS = APPLE_PLATFORM ? "Meta+Z" : "Control+Z";
const UNDO_KEYS_SHOWN = APPLE_PLATFORM ? "⌘Z" : "Ctrl+Z";
const NOT_TYPED_IN = new Set([
	"button",
	"submit",
	"reset",
	"checkbox",
	"radio",
	"range",
	"color",
	"file",
	"image",
]);

/** Cmd+Z on Apple platforms, Ctrl+Z elsewhere, and the Z key's place on a layout without a Latin Z. */
function isUndoKey(event: KeyboardEvent): boolean {
	const z =
		event.key.toLowerCase() === "z" ||
		(event.code === "KeyZ" && event.key.length === 1 && event.key.charCodeAt(0) > 0x7f);
	if (!z || event.shiftKey || event.altKey) return false;
	return APPLE_PLATFORM ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Whether keys pressed in `target` edit text, which has an undo of its own. */
function editsText(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
	if (target instanceof HTMLSelectElement) return true;
	// A control inside rich text, such as a button in an embedded block, leaves undo to the text.
	if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
	return target instanceof HTMLInputElement && !NOT_TYPED_IN.has(target.type);
}

/** The latest deletion in any blocks field on the page, which Undo and Mod+Z put back. */
interface UndoEntry {
	/** The blocks field it was made in. */
	field: object;
	/** What was deleted, once it has been. A deletion whose row still shrinks away has none. */
	owner?: UndoOwner;
	undo: () => void;
	/** Closes its toast. */
	close: () => void;
}

interface UndoSlot {
	current: UndoEntry | null;
	lastInput: { kind: "keyboard" | "pointer"; at: number };
	/** How many blocks fields are on the page, while any are listening. */
	fields: number;
	onInput: (event: Event) => void;
	onKeyDown: (event: KeyboardEvent) => void;
}

interface HeldDeletion extends DeletionHold {
	entry: UndoEntry;
}

function isHeld(hold: DeletionHold | undefined): hold is HeldDeletion {
	return hold !== undefined && "entry" in hold;
}

const UNDO_SLOT = Symbol.for("emdash.blocks-field.undo");

/**
 * The page's one Undo, shared by every blocks field on it: only the latest deletion in any of
 * them can be put back, by its toast or by Mod+Z while that toast is open and focus is not
 * somewhere to type.
 */
function undoSlot(): UndoSlot {
	const scope = globalThis as typeof globalThis & { [UNDO_SLOT]?: UndoSlot };
	scope[UNDO_SLOT] ??= {
		current: null,
		lastInput: { kind: "pointer", at: Number.NEGATIVE_INFINITY },
		fields: 0,
		onInput(event) {
			if (event instanceof KeyboardEvent && isUndoKey(event)) return;
			const kind = event.type === "pointerdown" ? "pointer" : "keyboard";
			undoSlot().lastInput = { kind, at: performance.now() };
		},
		onKeyDown(event) {
			const current = undoSlot().current;
			if (!current || event.defaultPrevented || !isUndoKey(event) || editsText(event.target)) {
				return;
			}
			event.preventDefault();
			current.undo();
		},
	};
	return scope[UNDO_SLOT];
}

/** Makes `entry` the page's Undo, closing the toast of the one before. */
function takeUndo(entry: UndoEntry) {
	const slot = undoSlot();
	const previous = slot.current;
	slot.current = entry;
	if (previous !== entry) previous?.close();
}

/** Ends `entry`'s chance to undo, without closing its toast. */
function releaseUndo(entry: UndoEntry) {
	const slot = undoSlot();
	if (slot.current === entry) slot.current = null;
}

/**
 * A blocks field's part in the page's Undo: it offers a toast for the field's deletions (of a
 * block, of a list item inside one, or of a photo), each in place of the page's latest, and
 * closes it once Undo can't apply. While a deleted row shrinks away, Mod+Z calls its deletion off.
 */
export function useUndoToast() {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const field = React.useRef({}).current;

	const mine = () => {
		const current = undoSlot().current;
		return current?.field === field ? current : null;
	};
	const dismiss = () => {
		const entry = mine();
		if (!entry) return;
		releaseUndo(entry);
		entry.close();
	};
	const dismissOnUnmount = useStableCallback(dismiss);

	React.useEffect(() => {
		const slot = undoSlot();
		if (slot.fields++ === 0) {
			document.addEventListener("keydown", slot.onInput, true);
			document.addEventListener("pointerdown", slot.onInput, true);
			document.addEventListener("keydown", slot.onKeyDown);
		}
		return () => {
			dismissOnUnmount();
			if (--slot.fields > 0) return;
			document.removeEventListener("keydown", slot.onInput, true);
			document.removeEventListener("pointerdown", slot.onInput, true);
			document.removeEventListener("keydown", slot.onKeyDown);
		};
	}, [dismissOnUnmount]);

	/** Lets Mod+Z call a deletion off while its row shrinks away, in place of any older Undo. */
	const hold = (cancel: () => void): HeldDeletion => {
		const entry: UndoEntry = {
			field,
			undo: () => {
				releaseUndo(entry);
				cancel();
			},
			close: () => {},
		};
		takeUndo(entry);
		return { entry, release: () => releaseUndo(entry) };
	};

	/** Offers Undo for a deletion. One held while its row shrank away offers it only if still the latest. */
	const offer = (title: string, owner: UndoOwner, restore: () => void, held?: DeletionHold) => {
		const slot = undoSlot();
		if (isHeld(held) && slot.current !== held.entry) return;
		const { kind, at } = slot.lastInput;
		const byPointer = kind === "pointer" && performance.now() - at < POINTER_DELETION_MS;
		let id = "";
		const entry: UndoEntry = {
			field,
			owner,
			undo: () => {
				if (undoSlot().current !== entry) return;
				releaseUndo(entry);
				entry.close();
				restore();
			},
			close: () => toastManager.close(id),
		};
		takeUndo(entry);
		id = toastManager.add({
			title,
			timeout: byPointer ? UNDO_TIMEOUT_MS : KEYBOARD_UNDO_TIMEOUT_MS,
			onClose: () => releaseUndo(entry),
			actions: [
				{
					children: (
						<>
							{t`Undo`}
							<kbd
								aria-hidden="true"
								className="ms-1 font-sans text-kumo-subtle pointer-coarse:hidden"
							>
								{UNDO_KEYS_SHOWN}
							</kbd>
						</>
					),
					variant: "secondary",
					size: "sm",
					className: "pointer-coarse:h-11 pointer-coarse:px-4",
					"aria-keyshortcuts": UNDO_KEYS,
					onClick: entry.undo,
				},
			],
		});
	};

	/** A deletion with no Undo of its own leaves nothing older for Undo to put back. */
	const supersede = () => {
		const entry = undoSlot().current;
		if (!entry) return;
		releaseUndo(entry);
		entry.close();
	};

	return { offer, hold, dismiss, supersede, owner: () => mine()?.owner };
}

type UndoToast = ReturnType<typeof useUndoToast>;

/** The blocks field's Undo toast, for the fields inside it. */
export const UndoContext = React.createContext<UndoToast | null>(null);

/**
 * The Undo for a photo removed from the control `name`: returns the function that offers it, and
 * puts the photo back through `change`.
 */
export function usePhotoUndo(
	name: string,
	fieldLabel: string,
	empty: boolean,
	change: (value: unknown) => void,
) {
	const { t } = useLingui();
	const undo = React.useContext(UndoContext);
	const putBack = useStableCallback(change);
	const ownsUndo = () => {
		const owner = undo?.owner();
		return owner?.kind === "field" && owner.name === name;
	};
	const offerRestore = (removed: ImageFieldValue | string, restored: () => void) =>
		undo?.offer(t`Removed ${fieldLabel}`, { kind: "field", name }, () => {
			restored();
			putBack(removed);
		});
	// Undo has nothing left to put back once a photo is there again, or the control has gone.
	React.useEffect(() => {
		if (!empty && ownsUndo()) undo?.dismiss();
	});
	const dismissOwnUndo = useStableCallback(() => {
		if (ownsUndo()) undo?.dismiss();
	});
	React.useEffect(() => dismissOwnUndo, [dismissOwnUndo]);
	return offerRestore;
}
