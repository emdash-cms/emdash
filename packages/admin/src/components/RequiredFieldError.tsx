/**
 * Timing for the "required" message on controls the browser cannot validate
 * itself (file, image and reference pickers).
 *
 * Native inputs stay quiet until Save is pressed. These custom controls have no
 * native `required` check, so the editor tells them when a save or publish has
 * been attempted. A field the editor has just emptied also reports at once, as
 * the change is theirs. Outside the content editor the context defaults to
 * `true`, so other callers of these renderers keep showing the message.
 */
import * as React from "react";

export const SaveAttemptedContext = React.createContext(true);

/** Whether a required field should show its "required" message now. */
export function useShowRequiredError(required: boolean | undefined, empty: boolean): boolean {
	const saveAttempted = React.useContext(SaveAttemptedContext);
	const [emptiedByEditor, setEmptiedByEditor] = React.useState(false);
	const wasEmpty = React.useRef(empty);

	React.useEffect(() => {
		if (empty && !wasEmpty.current) setEmptiedByEditor(true);
		wasEmpty.current = empty;
	}, [empty]);

	return !!required && empty && (saveAttempted || emptiedByEditor);
}

export function RequiredFieldMessage({ id, children }: { id: string; children: React.ReactNode }) {
	return (
		<p id={id} role="alert" className="-mt-1 text-xs leading-4 text-kumo-danger">
			{children}
		</p>
	);
}
