const SHADOW_LAYER_SEPARATOR = /,(?![^(]*\))/;
const PX_LENGTH = /(-?[\d.]+)px/g;

/** Whether a `box-shadow` ring is drawn, how far it reaches outside the element, and the room beside it before an ancestor's `overflow` clips it. */
export function focusRingClearance(element: Element) {
	const layers = getComputedStyle(element)
		.boxShadow.split(SHADOW_LAYER_SEPARATOR)
		.map((layer) => ({
			spread: Number([...layer.matchAll(PX_LENGTH)][3]?.[1] ?? 0),
			inset: layer.includes("inset"),
		}));
	const drawn = layers.some((layer) => layer.spread > 0);
	const reach = Math.max(0, ...layers.filter((l) => !l.inset).map((l) => l.spread));

	let room = Infinity;
	const box = element.getBoundingClientRect();
	for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
		const style = getComputedStyle(ancestor);
		if (style.overflowX === "visible" && style.overflowY === "visible") continue;
		const left = ancestor.getBoundingClientRect().left + ancestor.clientLeft;
		room = Math.min(room, box.left - left, left + ancestor.clientWidth - box.right);
	}
	return { drawn, reach, room };
}
