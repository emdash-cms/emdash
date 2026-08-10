import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { AdminBrandingProvider } from "../../src/lib/admin-branding-context";
import { render } from "../utils/render.tsx";

// Mock router — provide a token so the page reaches the "register" step
const mockUseSearch = vi.fn().mockReturnValue({ token: "valid-invite-token" });

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		useSearch: (...args: unknown[]) => mockUseSearch(...args),
	};
});

// Mock API
const mockValidateInviteToken = vi.fn().mockResolvedValue({
	email: "invitee@example.com",
	role: 30,
	roleName: "Author",
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		validateInviteToken: (...args: unknown[]) => mockValidateInviteToken(...args),
	};
});

// Mock WebAuthn so PasskeyRegistration doesn't bail out
Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

// Import after mocks
const { InviteAcceptPage } = await import("../../src/components/InviteAcceptPage");

describe("InviteAcceptPage", () => {
	beforeEach(() => {
		mockUseSearch.mockReturnValue({ token: "valid-invite-token" });
		mockValidateInviteToken.mockClear();
		mockValidateInviteToken.mockResolvedValue({
			email: "invitee@example.com",
			role: 30,
			roleName: "Author",
		});
	});

	// Regression test for #639 / PR #705: the invite-accept page must reflect
	// the configured admin.logo/siteName (white-label branding), not the
	// stock hardcoded EmDash mark — same as LoginPage/SignupPage.
	it("renders the configured admin logo/site name instead of the stock mark", async () => {
		const screen = await render(
			<AdminBrandingProvider
				adminBranding={{ logo: "https://example.com/logo.png", siteName: "Acme CMS" }}
			>
				<InviteAcceptPage />
			</AdminBrandingProvider>,
		);
		const logoImg = screen.getByRole("img", { name: "Acme CMS" });
		await expect.element(logoImg).toBeInTheDocument();
		expect(logoImg.element().getAttribute("src")).toBe("https://example.com/logo.png");
		expect(screen.getByRole("img", { name: "EmDash" }).query()).toBeNull();
	});

	it("falls back to the stock EmDash mark when no admin branding is configured", async () => {
		const screen = await render(<InviteAcceptPage />);
		await expect.element(screen.getByRole("img", { name: "EmDash" })).toBeInTheDocument();
	});
});
