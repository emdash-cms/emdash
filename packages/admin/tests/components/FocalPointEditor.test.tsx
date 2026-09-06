import * as React from "react";
import { describe, expect, it } from "vitest";

import { FocalPointPreviews } from "../../src/components/FocalPointEditor.js";
import { render } from "../utils/render.tsx";

const image = (color: string) =>
	`data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="${color}"/></svg>`;

describe("FocalPointPreviews", () => {
	it("retries the original fallback after the preview source changes", async () => {
		const firstFallback = image("blue");
		const screen = await render(
			<FocalPointPreviews src={image("red")} fallbackSrc={firstFallback} point={null} />,
		);
		const firstPreview = screen.getByTestId("focal-preview-square").element();
		firstPreview.dispatchEvent(new Event("error"));
		expect(firstPreview.src).toBe(firstFallback);

		const secondSource = image("green");
		const secondFallback = image("black");
		await screen.rerender(
			<FocalPointPreviews src={secondSource} fallbackSrc={secondFallback} point={null} />,
		);
		const secondPreview = screen.getByTestId("focal-preview-square").element();
		secondPreview.dispatchEvent(new Event("error"));

		expect(secondPreview.src).toBe(secondFallback);
	});
});
