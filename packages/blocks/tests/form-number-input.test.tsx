import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "../src/renderer.js";
import type { Block } from "../src/types.js";

afterEach(cleanup);

const blocks: Block[] = [
	{
		type: "form",
		block_id: "plan",
		fields: [{ type: "number_input", action_id: "price", label: "Price", min: 0.01, max: 10 }],
		submit: { label: "Save price", action_id: "save_price" },
	},
];

describe("number input in a form", () => {
	it.each(["5.00", "5.25", "5.01", "0.01", "10", "5.001"])(
		"submits the in-range price %s as a number",
		(price) => {
			const onAction = vi.fn();
			render(<BlockRenderer blocks={blocks} onAction={onAction} />);

			fireEvent.change(screen.getByRole("spinbutton"), { target: { value: price } });
			fireEvent.click(screen.getByRole("button", { name: "Save price" }));

			expect(onAction).toHaveBeenCalledTimes(1);
			expect(onAction).toHaveBeenCalledWith({
				type: "form_submit",
				action_id: "save_price",
				block_id: "plan",
				values: { price: Number(price) },
			});
		},
	);

	it.each(["0", "0.009", "10.01"])("rejects the out-of-range price %s", (price) => {
		const onAction = vi.fn();
		render(<BlockRenderer blocks={blocks} onAction={onAction} />);

		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: price } });
		fireEvent.click(screen.getByRole("button", { name: "Save price" }));

		expect(onAction).not.toHaveBeenCalled();
	});

	it("submits a decimal price with Enter", () => {
		const onAction = vi.fn();
		render(<BlockRenderer blocks={blocks} onAction={onAction} />);
		const input = screen.getByRole("spinbutton");

		fireEvent.change(input, { target: { value: "5.25" } });
		fireEvent.keyDown(input, { key: "Enter" });

		expect(onAction).toHaveBeenCalledTimes(1);
		expect(onAction).toHaveBeenCalledWith({
			type: "form_submit",
			action_id: "save_price",
			block_id: "plan",
			values: { price: 5.25 },
		});
	});
});
