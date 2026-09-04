import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "../src/renderer.js";

vi.mock("../src/blocks/chart.js", () => {
	throw new Error("simulated chart chunk failure");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("BlockRenderer chart loading failures", () => {
	it("logs the failure and keeps the configured-height chart placeholder", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { container } = render(
			<BlockRenderer
				blocks={[
					{
						type: "chart",
						config: { chart_type: "custom", options: {}, height: 420 },
					},
				]}
				onAction={vi.fn()}
			/>,
		);

		await waitFor(() => {
			expect(error).toHaveBeenCalledWith(
				"[blocks] Failed to load chart renderer:",
				expect.any(Error),
			);
		});

		const placeholder = container.querySelector<HTMLElement>('[aria-hidden="true"]');
		expect((placeholder?.firstElementChild as HTMLElement | undefined)?.style.height).toBe("420px");
	});
});
