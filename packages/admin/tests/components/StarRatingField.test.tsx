/**
 * Star rating field tests.
 *
 * The `stars` built-in widget renders an integer/number field as clickable
 * stars (1..max). Clicking a star sets that value, clicking the current value
 * clears it back to 0. `options.max` controls how many stars render.
 */

import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { StarRatingField } from "../../src/components/StarRatingField";
import { render } from "../utils/render.tsx";

describe("StarRatingField", () => {
	it("renders five stars by default", async () => {
		const screen = await render(
			<StarRatingField id="rating" label="Rating" value={0} onChange={vi.fn()} />,
		);

		const stars = screen.getByRole("radio").all();
		expect(stars.length).toBe(5);
		await expect.element(screen.getByText("0/5")).toBeInTheDocument();
	});

	it("honors options.max via the max prop", async () => {
		const screen = await render(
			<StarRatingField id="rating" label="Rating" value={2} max={3} onChange={vi.fn()} />,
		);

		const stars = screen.getByRole("radio").all();
		expect(stars.length).toBe(3);
		await expect.element(screen.getByText("2/3")).toBeInTheDocument();
	});

	it("falls back to the default when max is invalid", async () => {
		const screen = await render(
			<StarRatingField id="rating" label="Rating" value={0} max={0} onChange={vi.fn()} />,
		);

		expect(screen.getByRole("radio").all().length).toBe(5);
	});

	it("sets the value when a star is clicked", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<StarRatingField id="rating" label="Rating" value={0} onChange={onChange} />,
		);

		await screen.getByRole("radio", { name: "4 of 5" }).click();
		expect(onChange).toHaveBeenCalledWith(4);
	});

	it("clears the value when the current star is clicked again", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<StarRatingField id="rating" label="Rating" value={3} onChange={onChange} />,
		);

		await screen.getByRole("radio", { name: "3 of 5" }).click();
		expect(onChange).toHaveBeenCalledWith(0);
	});

	it("marks the current value as checked", async () => {
		const screen = await render(
			<StarRatingField id="rating" label="Rating" value={2} onChange={vi.fn()} />,
		);

		await expect
			.element(screen.getByRole("radio", { name: "2 of 5" }))
			.toHaveAttribute("aria-checked", "true");
		await expect
			.element(screen.getByRole("radio", { name: "1 of 5" }))
			.toHaveAttribute("aria-checked", "false");
	});
});
