import * as React from "react";

import { TOAST_REGION } from "./block-field-keyboard.js";

const POPUP = '[role="dialog"], [role="alertdialog"], [role="menu"]';

/** Whether `target` is in a dialog or menu a control opened. A toast is a dialog no control opened. */
function inPopup(target: EventTarget | null): boolean {
	return (
		target instanceof Element && target.closest(POPUP) !== null && !target.closest(TOAST_REGION)
	);
}

/**
 * Hover controls show on keyboard focus with `:focus-visible`. A dialog or menu that closes with
 * Escape hands focus back to its opener, and browsers count that as keyboard focus even when a
 * pointer opened it. This marks the group while that returned focus sits on the opener, so it
 * doesn't keep the controls shown. Any other focus, or a key pressed outside the popup, ends it.
 */
export function useQuietReturnFocus() {
	const [quiet, setQuiet] = React.useState(false);
	const openerRef = React.useRef<HTMLElement | null>(null);
	/** The opener holding quiet returned focus now. */
	const quietOpenerRef = React.useRef<HTMLElement | null>(null);
	/** An opener whose popup handed focus on to another, which returns it there too. */
	const handedOffRef = React.useRef<HTMLElement | null>(null);
	const stopRef = React.useRef<(() => void) | null>(null);

	const forget = React.useCallback(() => {
		openerRef.current = null;
		handedOffRef.current = null;
		stopRef.current?.();
		stopRef.current = null;
	}, []);
	React.useEffect(() => forget, [forget]);

	const watch = (opener: HTMLElement) => {
		forget();
		openerRef.current = opener;
		// Focus may come back somewhere else, or the dialog may never open.
		const onFocusIn = (focus: FocusEvent) => {
			if (focus.target !== opener && !inPopup(focus.target)) forget();
		};
		const onKeyDown = (key: KeyboardEvent) => {
			if (!inPopup(key.target)) forget();
		};
		document.addEventListener("focusin", onFocusIn, true);
		document.addEventListener("keydown", onKeyDown, true);
		stopRef.current = () => {
			document.removeEventListener("focusin", onFocusIn, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	};

	const markOpener = (event: React.MouseEvent<HTMLElement>) => {
		forget();
		// A click from the keyboard has no detail, and its returned focus should show the controls.
		if (event.detail === 0) return;
		watch(event.currentTarget);
	};

	/**
	 * A popup opened from one that just closed, such as the block picker from a menu, gives focus
	 * back to `opener` too. Its returned focus stays quiet when the first popup's was.
	 */
	const handOff = (opener: HTMLElement | null) => {
		if (!opener) return;
		// The first popup may not have handed focus back yet.
		if (openerRef.current === opener) handedOffRef.current = opener;
		else if (quietOpenerRef.current === opener) watch(opener);
	};

	return {
		markOpener,
		handOff,
		groupProps: {
			"data-quiet-focus": quiet || undefined,
			// Events from a dialog rendered inside the group bubble here through its portal.
			onFocus: (event: React.FocusEvent<HTMLElement>) => {
				if (!event.currentTarget.contains(event.target)) return;
				const returned =
					event.target === openerRef.current &&
					(event.relatedTarget === null || inPopup(event.relatedTarget));
				if (returned && event.target === handedOffRef.current) {
					handedOffRef.current = null;
					quietOpenerRef.current = event.target;
					setQuiet(true);
					return;
				}
				forget();
				quietOpenerRef.current = returned ? event.target : null;
				setQuiet(returned);
			},
			onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
				if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
					quietOpenerRef.current = null;
					setQuiet(false);
				}
			},
		},
	};
}
