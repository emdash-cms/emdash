import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AssessmentState } from "../api/types.js";
import { StateBadge } from "./StateBadge.js";

const ALL_STATES: readonly AssessmentState[] = [
	"observed",
	"verifying",
	"pending",
	"running",
	"passed",
	"warned",
	"blocked",
	"error",
	"stale",
	"cancelled",
];

describe("StateBadge", () => {
	it("renders a label for every assessment state", () => {
		for (const state of ALL_STATES) {
			const { unmount } = render(<StateBadge state={state} />);
			expect(screen.getByText(new RegExp(state, "i"))).toBeTruthy();
			unmount();
		}
	});
});
