import { vi } from "vitest";
import type { RenderResult } from "vitest-browser-react";

export function solidImage(width: number, height: number) {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d")!;
	context.fillStyle = "#4f46e5";
	context.fillRect(0, 0, width, height);
	return canvas.toDataURL("image/png");
}

export async function loadedPreview(screen: RenderResult) {
	const img = await vi.waitFor(() => {
		const element = screen.container.querySelector("img");
		if (!element) throw new Error("The preview image has not rendered");
		return element;
	});
	await img.decode();
	return img;
}

/** "shown" when both an action can be seen and the pointer hits it, "hidden" when neither. */
export function actionStates(screen: RenderResult) {
	return ["Replace OG Image", "Remove OG Image"].map((name) => {
		const element = screen.getByRole("button", { name, exact: true }).element();
		let opacity = 1;
		for (let node: Element | null = element; node; node = node.parentElement) {
			opacity *= Number(getComputedStyle(node).opacity);
		}
		const { x, y, width, height } = element.getBoundingClientRect();
		const hit = element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
		if (opacity === 1 && hit) return "shown";
		if (opacity === 0 && !hit) return "hidden";
		return `opacity ${opacity}, ${hit ? "hit" : "missed"} by the pointer`;
	});
}
