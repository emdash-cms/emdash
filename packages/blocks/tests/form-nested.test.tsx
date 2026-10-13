import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "../src/renderer.js";
import type { Block } from "../src/types.js";

afterEach(cleanup);

// Uses the real Kumo components, not mocks: the fix relies on Button passing `type` and
// `onClick` to the native <button>, and on Input keeping `min`/`max` for validation.

// The admin renders plugin editor panels inside the content editor's own <form>,
// so a Block Kit form there is nested in another form.
const blocks: Block[] = [
	{
		type: "form",
		block_id: "panel",
		fields: [{ type: "text_input", action_id: "price", label: "Price", initial_value: "$0.05" }],
		submit: { label: "Save price", action_id: "save_price" },
	},
];

describe("form block inside another form", () => {
	it("submits only the Block Kit form", () => {
		const onAction = vi.fn();
		const outerSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
		// Chromium doesn't propagate a nested form's native submit event, so the browser would
		// submit the page itself. The form block must not dispatch one at all.
		const nativeSubmit = vi.fn();
		document.addEventListener("submit", nativeSubmit, true);
		try {
			render(
				<form onSubmit={outerSubmit}>
					<BlockRenderer blocks={blocks} onAction={onAction} />
				</form>,
			);

			fireEvent.click(screen.getByRole("button", { name: "Save price" }));

			expect(onAction).toHaveBeenCalledTimes(1);
			expect(onAction).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "form_submit",
					action_id: "save_price",
					values: { price: "$0.05" },
				}),
			);
			expect(outerSubmit).not.toHaveBeenCalled();
			expect(nativeSubmit).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("submit", nativeSubmit, true);
		}
	});

	it("keeps the browser's validation before submitting", () => {
		const onAction = vi.fn();
		render(
			<BlockRenderer
				blocks={[
					{
						type: "form",
						block_id: "count",
						fields: [{ type: "number_input", action_id: "count", label: "Count", min: 0, max: 10 }],
						submit: { label: "Save count", action_id: "save_count" },
					},
				]}
				onAction={onAction}
			/>,
		);
		const input = screen.getByRole("spinbutton");
		const button = screen.getByRole("button", { name: "Save count" });

		fireEvent.change(input, { target: { value: "11" } });
		fireEvent.click(button);
		expect(onAction).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: "5" } });
		fireEvent.click(button);
		expect(onAction).toHaveBeenCalledTimes(1);
	});
});
