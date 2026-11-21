// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { clearImagePlaceholders } from "../../../src/components/image-placeholder.js";

function render(complete: boolean): HTMLImageElement {
	document.body.innerHTML = `<img data-emdash-placeholder style="background-image: url(&quot;data:image/bmp;base64,AA&quot;); background-size: cover; object-position: 25% 75%;">`;
	const image = document.querySelector("img")!;
	Object.defineProperty(image, "complete", { configurable: true, get: () => complete });
	return image;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("clearImagePlaceholders", () => {
	it("keeps the placeholder while the image loads, then removes it and keeps object-position", () => {
		const image = render(false);
		clearImagePlaceholders();
		expect(image.style.backgroundImage).not.toBe("");
		expect(image.hasAttribute("data-emdash-placeholder")).toBe(true);

		image.dispatchEvent(new Event("load"));
		expect(image.style.backgroundImage).toBe("");
		expect(image.style.backgroundSize).toBe("");
		expect(image.style.objectPosition).toBe("25% 75%");
		expect(image.hasAttribute("data-emdash-placeholder")).toBe(false);
	});

	it("removes the placeholder when the image fails", () => {
		const image = render(false);
		clearImagePlaceholders();
		image.dispatchEvent(new Event("error"));
		expect(image.style.backgroundImage).toBe("");
	});

	it("removes the placeholder at once from an image that already loaded", () => {
		const image = render(true);
		clearImagePlaceholders();
		expect(image.style.backgroundImage).toBe("");
		expect(image.hasAttribute("data-emdash-placeholder")).toBe(false);
	});

	it("clears a dominant-color placeholder", () => {
		document.body.innerHTML = `<img data-emdash-placeholder style="background-color: rgb(1, 2, 3);">`;
		const image = document.querySelector("img")!;
		Object.defineProperty(image, "complete", { get: () => true });
		clearImagePlaceholders();
		expect(image.style.backgroundColor).toBe("");
	});
});
