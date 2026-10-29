import * as React from "react";

/**
 * The text a media block's caption field shows. Tiptap re-renders a node view
 * a microtask after its attributes change, but React restores a controlled
 * field to its current value as soon as the input event ends, so a field read
 * straight from the node's attributes loses each keystroke for a moment and
 * puts the cursor at the end. The field keeps its own copy instead, and takes
 * the node's caption whenever that changes from elsewhere (undo, the settings
 * panel, a replaced image).
 */
export function useCaptionText(caption: string, write: (caption: string) => void) {
	const [text, setText] = React.useState(caption);
	const [seen, setSeen] = React.useState(caption);
	if (caption !== seen) {
		setSeen(caption);
		setText(caption);
	}
	return {
		value: text,
		onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
			setText(event.target.value);
			write(event.target.value);
		},
	};
}

/**
 * Whether a media block's caption field shows. A caption with text always
 * shows; an empty one only while it has focus, so it takes no room otherwise.
 * Losing focus closes the field after the press that moved focus ends and
 * the click it makes has landed, so nothing moves under the pointer first.
 */
export function useCaptionField(caption: string) {
	const [state, setState] = React.useState<"closed" | "open" | "closing">("closed");
	const pressedRef = React.useRef(false);

	React.useEffect(() => {
		if (state === "closed") return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const close = () => {
			clearTimeout(timer);
			timer = setTimeout(() => setState("closed"));
		};
		const press = () => {
			pressedRef.current = true;
		};
		const release = () => {
			pressedRef.current = false;
			if (state === "closing") close();
		};
		if (state === "closing" && !pressedRef.current) close();
		window.addEventListener("pointerdown", press, true);
		window.addEventListener("pointerup", release, true);
		window.addEventListener("pointercancel", release, true);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("pointerdown", press, true);
			window.removeEventListener("pointerup", release, true);
			window.removeEventListener("pointercancel", release, true);
		};
	}, [state]);

	return {
		shown: caption !== "" || state !== "closed",
		onFocus: () => {
			// Drops a press whose release a context menu swallowed. A press that focuses
			// the field is on the field, so it never has to keep the field open.
			pressedRef.current = false;
			setState("open");
		},
		onBlur: () => {
			// Switching windows returns the focus to the field afterwards.
			if (!document.hasFocus()) return;
			setState("closing");
		},
	};
}
