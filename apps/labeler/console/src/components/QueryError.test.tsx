import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueryError } from "./QueryError.js";

describe("QueryError", () => {
	it("renders the failure title and the underlying error message", () => {
		render(<QueryError title="Failed to load assessments" error={new Error("network down")} />);

		expect(screen.getByText("Failed to load assessments")).toBeTruthy();
		expect(screen.getByText(/network down/)).toBeTruthy();
	});

	it("renders distinctly from a not-found state rather than masquerading as one", () => {
		render(<QueryError title="Failed to load assessment" error={new Error("500")} />);

		expect(screen.queryByText(/not found/i)).toBeNull();
	});

	it("falls back to a generic message for a non-Error rejection", () => {
		render(<QueryError title="Failed to load labels" error="rejected" />);

		expect(screen.getByText(/An unexpected error occurred/)).toBeTruthy();
	});
});
