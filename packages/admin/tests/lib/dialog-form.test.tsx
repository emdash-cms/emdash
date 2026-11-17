import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { useSingleFlight } from "../../src/lib/dialog-form";
import { render } from "../utils/render.tsx";

function SaveButton({ submit }: { submit: () => Promise<unknown> }) {
	const save = useSingleFlight(submit);
	return (
		<button
			type="button"
			onClick={() => {
				try {
					save();
				} catch {
					// The test's first submit throws on purpose.
				}
			}}
		>
			Save
		</button>
	);
}

describe("useSingleFlight", () => {
	it("runs a submit again after one that threw before returning", async () => {
		const submit = vi
			.fn<() => Promise<unknown>>()
			.mockImplementationOnce(() => {
				throw new Error("Not ready");
			})
			.mockResolvedValue(undefined);
		const screen = await render(<SaveButton submit={submit} />);
		const save = screen.getByRole("button", { name: "Save" });

		await save.click();
		await save.click();

		expect(submit).toHaveBeenCalledTimes(2);
	});
});
