import { cdp } from "vitest/browser";

/**
 * Presses a corner of the page with real mouse input, outside any dialog.
 * Base UI's outside-press dismissal ignores synthetic events.
 */
export async function pressOutside(corner: "top" | "bottom" = "top") {
	const session = cdp();
	// Mouse input lands in the top-level page, which hosts this test's frame.
	const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const y = corner === "top" ? frame.top + 4 : frame.bottom - 4;
	for (const type of ["mousePressed", "mouseReleased"] as const) {
		await session.send("Input.dispatchMouseEvent", {
			type,
			x: frame.left + 4,
			y,
			button: "left",
			clickCount: 1,
		});
	}
	// A dismissal has started by the time the test looks.
	await new Promise((resolve) => setTimeout(resolve, 300));
}
