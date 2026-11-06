import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SelectElementComponent } from "../src/elements/select.js";
import type { SelectElement } from "../src/types.js";

// Renders the real Kumo Select (renderer.test.tsx mocks it with a native <select>,
// which always shows option labels).

afterEach(cleanup);

const element: SelectElement = {
	type: "select",
	action_id: "network",
	label: "Network",
	options: [
		{ value: "eip155:8453", label: "Base" },
		{ value: "eip155:84532", label: "Base Sepolia (testnet)" },
	],
	initial_value: "eip155:84532",
};

describe("SelectElementComponent", () => {
	it("shows the selected option's label, not its value", () => {
		render(<SelectElementComponent element={element} onAction={() => {}} />);
		const trigger = screen.getByRole("combobox");
		expect(trigger.textContent).toContain("Base Sepolia (testnet)");
		expect(trigger.textContent).not.toContain("eip155:84532");
	});
});
