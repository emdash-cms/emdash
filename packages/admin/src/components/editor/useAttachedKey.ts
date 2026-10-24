import * as React from "react";

/**
 * A key that changes once the element is in the document.
 *
 * TipTap renders a new node view before ProseMirror adds it to the document,
 * and Base UI composites such as tabs and toolbars only register items that
 * are in the document. Keyed with this, a composite mounts again once it can
 * register them, so its arrow keys, tab stop and tab indicator work.
 */
export function useAttachedKey(ref: React.RefObject<HTMLElement | null>): string {
	const [attached, setAttached] = React.useState(false);
	React.useLayoutEffect(() => {
		const element = ref.current;
		if (!element || element.isConnected) return;
		let frame = requestAnimationFrame(function check() {
			if (element.isConnected) setAttached(true);
			else frame = requestAnimationFrame(check);
		});
		return () => cancelAnimationFrame(frame);
	}, [ref]);
	return attached ? "attached" : "initial";
}
