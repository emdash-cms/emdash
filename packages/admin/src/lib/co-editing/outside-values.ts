import type { OutsideValue } from "../../co-editing/types.js";

/**
 * Resolves once focus is outside every input marked `data-emdash-outside` with one of `values`,
 * and no dialog or menu one of them opened is still open, so a value someone else saved never
 * replaces one being edited.
 */
export function whenOutsideValuesUnfocused(values: readonly OutsideValue[]): Promise<void> {
	const inputs = values.map((value) => `[data-emdash-outside="${value}"]`);
	const selector = inputs.join(",");
	const openPopups = inputs.map((input) => `${input} [data-popup-open]`).join(",");
	const inUse = () =>
		document.activeElement?.closest(selector) != null ||
		document.querySelector(openPopups) !== null;
	if (!inUse()) return Promise.resolve();
	return new Promise((resolve) => {
		// Focus has moved on only after `focusout`, and stays put when just the window lost it.
		const check = () =>
			setTimeout(() => {
				if (inUse()) return;
				document.removeEventListener("focusout", check);
				document.removeEventListener("focusin", check);
				resolve();
			});
		document.addEventListener("focusout", check);
		document.addEventListener("focusin", check);
	});
}
