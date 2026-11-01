import { cdp } from "vitest/browser";

/** Taps the element with real touch input, as a finger would. */
export async function tap(element: Element) {
	const session = cdp();
	// Touch input lands in the top-level page, which hosts this test's frame.
	const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const scale = frame.width ? frame.width / window.innerWidth : 1;
	const box = element.getBoundingClientRect();
	const x = frame.left + (box.left + box.width / 2) * scale;
	const y = frame.top + (box.top + box.height / 2) * scale;
	// Touch input works without touch emulation, and turning emulation off resets
	// the page's hover and pointer to the machine's own devices, none on Linux CI,
	// for every later test file on the page.
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
