import * as React from "react";

const DIALOG = '[role="dialog"], [role="alertdialog"]';

function inDialog(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest(DIALOG) !== null;
}

/**
 * Hover controls show on keyboard focus with `:focus-visible`. A dialog that closes with Escape
 * hands focus back to its opener, and browsers count that as keyboard focus even when a pointer
 * opened it. This marks the group while that returned focus sits on the opener, so it doesn't
 * keep the controls shown. Any other focus, or a key pressed outside a dialog, ends it.
 */
export function useQuietReturnFocus() {
	const [quiet, setQuiet] = React.useState(false);
	const openerRef = React.useRef<HTMLElement | null>(null);
	const stopRef = React.useRef<(() => void) | null>(null);

	const forget = React.useCallback(() => {
		openerRef.current = null;
		stopRef.current?.();
		stopRef.current = null;
	}, []);
	React.useEffect(() => forget, [forget]);

	const markOpener = (event: React.MouseEvent<HTMLElement>) => {
		forget();
		// A click from the keyboard has no detail, and its returned focus should show the controls.
		if (event.detail === 0) return;
		const opener = event.currentTarget;
		openerRef.current = opener;
		// Focus may come back somewhere else, or the dialog may never open.
		const onFocusIn = (focus: FocusEvent) => {
			if (focus.target !== opener && !inDialog(focus.target)) forget();
		};
		const onKeyDown = (key: KeyboardEvent) => {
			if (!inDialog(key.target)) forget();
		};
		document.addEventListener("focusin", onFocusIn, true);
		document.addEventListener("keydown", onKeyDown, true);
		stopRef.current = () => {
			document.removeEventListener("focusin", onFocusIn, true);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	};

	return {
		markOpener,
		groupProps: {
			"data-quiet-focus": quiet || undefined,
			// Events from a dialog rendered inside the group bubble here through its portal.
			onFocus: (event: React.FocusEvent<HTMLElement>) => {
				if (!event.currentTarget.contains(event.target)) return;
				const returned =
					event.target === openerRef.current &&
					(event.relatedTarget === null || inDialog(event.relatedTarget));
				forget();
				setQuiet(returned);
			},
			onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
				if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
					setQuiet(false);
				}
			},
		},
	};
}
