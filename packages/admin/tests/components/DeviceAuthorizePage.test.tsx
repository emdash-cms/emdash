import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../utils/render.tsx";

const mockApiFetch = vi.fn();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		apiFetch: (...args: unknown[]) => mockApiFetch(...args),
	};
});

const { DeviceAuthorizePage } = await import("../../src/components/DeviceAuthorizePage");

const editor = { id: "user-1", email: "editor@example.com", name: "Editor", role: 40 };

function respondWith(lookup: Response) {
	mockApiFetch.mockImplementation((input: string) => {
		if (input.endsWith("/auth/me")) return Promise.resolve(Response.json({ data: editor }));
		if (input.includes("/oauth/device/authorize?")) return Promise.resolve(lookup);
		return Promise.reject(new Error(`Unexpected request: ${input}`));
	});
}

describe("DeviceAuthorizePage", () => {
	const originalUrl = window.location.href;

	beforeEach(() => {
		mockApiFetch.mockReset();
		window.history.replaceState(null, "", "/_emdash/admin/device?code=ABCD-EFGH");
	});

	afterEach(() => {
		window.history.replaceState(null, "", originalUrl);
	});

	it("lists the scopes that will be granted and those withheld before approval", async () => {
		respondWith(
			Response.json({
				data: {
					requestedScopes: ["content:read", "admin"],
					grantedScopes: ["content:read"],
				},
			}),
		);

		const screen = await render(<DeviceAuthorizePage />);

		const granted = screen.getByRole("region", {
			name: "This device is requesting permission to use:",
		});
		await expect.element(granted.getByText("Content Read")).toBeInTheDocument();
		expect(granted.getByText("Admin", { exact: true }).query()).toBeNull();

		const withheld = screen.getByRole("region", {
			name: "Also requested, but not available to your role:",
		});
		await expect.element(withheld.getByText("Admin", { exact: true })).toBeInTheDocument();

		await expect.element(screen.getByRole("button", { name: "Authorize" })).toBeEnabled();
	});

	it("normalizes a code supplied in the URL before looking it up", async () => {
		window.history.replaceState(null, "", "/_emdash/admin/device?code=%20abcd-efgh%20");
		respondWith(
			Response.json({
				data: { requestedScopes: ["content:read"], grantedScopes: ["content:read"] },
			}),
		);

		const screen = await render(<DeviceAuthorizePage />);

		await expect.element(screen.getByRole("button", { name: "Authorize" })).toBeEnabled();
		expect(mockApiFetch).toHaveBeenCalledWith(
			"/_emdash/api/oauth/device/authorize?user_code=ABCDEFGH",
		);
	});

	it("disables approval and explains an unknown code", async () => {
		respondWith(
			Response.json(
				{ error: { code: "INVALID_CODE", message: "Invalid or expired code" } },
				{ status: 400 },
			),
		);

		const screen = await render(<DeviceAuthorizePage />);

		await expect
			.element(screen.getByText("This code is invalid or has already been used."))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Authorize" })).toBeDisabled();
	});

	it("disables approval when the viewer's role permits none of the requested scopes", async () => {
		respondWith(Response.json({ data: { requestedScopes: ["admin"], grantedScopes: [] } }));

		const screen = await render(<DeviceAuthorizePage />);

		await expect
			.element(
				screen.getByText("Your role does not permit any of the permissions this device requested."),
			)
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Authorize" })).toBeDisabled();
	});
});
