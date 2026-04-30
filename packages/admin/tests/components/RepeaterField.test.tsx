import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { RepeaterField } from "../../src/components/RepeaterField";
import { render } from "../utils/render.tsx";

describe("RepeaterField", () => {
	describe("datetime sub-field", () => {
		it("displays a stored ISO datetime in the datetime-local input", async () => {
			// Mirrors the top-level datetime widget contract: full ISO 8601
			// values must round-trip through `<input type="datetime-local">`,
			// which only accepts `YYYY-MM-DDTHH:mm`.
			const screen = await render(
				<RepeaterField
					label="Recalls"
					id="recalls"
					value={[{ recall_date: "2026-02-26T09:30:00.000Z" }]}
					onChange={vi.fn()}
					subFields={[{ slug: "recall_date", type: "datetime", label: "Recall date" }]}
				/>,
			);
			const input = screen.getByLabelText("Recall date");
			await expect.element(input).toHaveValue("2026-02-26T09:30");
		});

		it("emits a full ISO 8601 value with Z and milliseconds on change", async () => {
			const onChange = vi.fn();
			const screen = await render(
				<RepeaterField
					label="Recalls"
					id="recalls"
					value={[{ recall_date: "" }]}
					onChange={onChange}
					subFields={[{ slug: "recall_date", type: "datetime", label: "Recall date" }]}
				/>,
			);
			const input = screen.getByLabelText("Recall date");
			await input.fill("2026-02-26T09:30");

			expect(onChange).toHaveBeenLastCalledWith([
				expect.objectContaining({ recall_date: "2026-02-26T09:30:00.000Z" }),
			]);
		});
	});
});
