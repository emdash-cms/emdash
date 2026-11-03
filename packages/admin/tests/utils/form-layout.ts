/** How far form controls in `container` overlap each other and reach past its content box, in pixels. */
export function formControlSpill(container: Element) {
	const box = container.getBoundingClientRect();
	const style = getComputedStyle(container);
	const left = box.left + Number.parseFloat(style.paddingLeft);
	const right = box.right - Number.parseFloat(style.paddingRight);
	const controls = Array.from(
		container.querySelectorAll(
			"input:not([type=checkbox]):not([type=hidden]), textarea, [role=combobox]",
		),
		(control) => control.getBoundingClientRect(),
	).filter((rect) => rect.width > 2);

	let overlap = 0;
	let outside = 0;
	controls.forEach((a, index) => {
		outside = Math.max(outside, left - a.left, a.right - right);
		for (const b of controls.slice(index + 1)) {
			const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
			const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
			if (width > 0 && height > 0) overlap = Math.max(overlap, width);
		}
	});
	return { controls: controls.length, overlap, outside };
}

/** A mount point like the admin page's: `#admin-root`, directly under `body`. */
export function adminRoot() {
	const root = document.createElement("div");
	root.id = "admin-root";
	return document.body.appendChild(root);
}
