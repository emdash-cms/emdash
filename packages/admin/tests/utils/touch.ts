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
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
	try {
		await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
		await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	} finally {
		await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
	}
}
