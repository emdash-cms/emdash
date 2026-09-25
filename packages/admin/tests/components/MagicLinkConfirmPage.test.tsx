import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

const mockApiFetch = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		apiFetch: (...args: unknown[]) => mockApiFetch(...args),
	};
});

const { MagicLinkConfirmPage } = await import("../../src/components/MagicLinkConfirmPage");

describe("MagicLinkConfirmPage", () => {
	beforeEach(() => {
		mockApiFetch.mockReset();
	});

	it("does not use the token until Continue is pressed", async () => {
		mockApiFetch.mockReturnValue(new Promise(() => {}));
		const screen = await render(
			<MagicLinkConfirmPage token="tok-123" redirectUrl="/_emdash/admin" />,
		);

		await expect.element(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
		expect(mockApiFetch).not.toHaveBeenCalled();

		await screen.getByRole("button", { name: "Continue" }).click();

		expect(mockApiFetch).toHaveBeenCalledWith(
			"/_emdash/api/auth/magic-link/verify",
			expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "tok-123" }) }),
		);
	});

	it("explains a used link and offers no retry", async () => {
		mockApiFetch.mockResolvedValue(
			Response.json(
				{ success: false, error: { code: "INVALID_TOKEN", message: "Invalid or expired link" } },
				{ status: 400 },
			),
		);
		const screen = await render(
			<MagicLinkConfirmPage token="tok-123" redirectUrl="/_emdash/admin" />,
		);

		await screen.getByRole("button", { name: "Continue" }).click();

		await expect.element(screen.getByText(/invalid or has already been used/)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Continue" }).query()).toBeNull();
	});
});
