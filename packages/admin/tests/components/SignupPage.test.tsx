import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AdminBrandingProvider } from "../../src/lib/admin-branding-context";
import { render } from "../utils/render.tsx";

// Mock router
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

// Mock API
const mockFetchAuthMode = vi.fn().mockResolvedValue({ authMode: "passkey" });
const mockRequestSignup = vi.fn().mockResolvedValue({ success: true });
const mockVerifySignupToken = vi
	.fn()
	.mockResolvedValue({ email: "test@example.com", role: 30, roleName: "Author" });

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchAuthMode: (...args: unknown[]) => mockFetchAuthMode(...args),
		requestSignup: (...args: unknown[]) => mockRequestSignup(...args),
		verifySignupToken: (...args: unknown[]) => mockVerifySignupToken(...args),
		hasAllowedDomains: vi.fn().mockResolvedValue(true),
	};
});

// Mock WebAuthn so PasskeyRegistration doesn't bail out
Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

// Import after mocks
const { SignupPage } = await import("../../src/components/SignupPage");
const { ApiResponseError } = await import("../../src/lib/api");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESEND_COOLDOWN_REGEX = /Resend in \d+s/;

describe("SignupPage", () => {
	beforeEach(() => {
		mockRequestSignup.mockClear();
		mockVerifySignupToken.mockClear();
		// Clean URL params
		window.history.replaceState({}, "", window.location.pathname);
	});

	afterEach(() => {
		delete window.turnstile;
	});

	it("shows email input initially", async () => {
		const screen = await render(<SignupPage />);
		await expect.element(screen.getByText("Create an account")).toBeInTheDocument();
		await expect.element(screen.getByPlaceholder("you@company.com")).toBeInTheDocument();
	});

	it("submit empty email shows validation error", async () => {
		const screen = await render(<SignupPage />);
		await screen.getByText("Continue").click();
		await expect.element(screen.getByText("Email is required")).toBeInTheDocument();
	});

	it("submit invalid email (no dot) shows validation error", async () => {
		const screen = await render(<SignupPage />);
		const input = screen.getByPlaceholder("you@company.com");
		// Use an email with @ but no dot - passes browser validation but fails component validation
		await input.fill("test@nodot");
		await screen.getByText("Continue").click();
		await expect
			.element(screen.getByText("Please enter a valid email address"))
			.toBeInTheDocument();
	});

	it("submit valid email advances to check-email step", async () => {
		const screen = await render(<SignupPage />);
		const input = screen.getByPlaceholder("you@company.com");
		await input.fill("test@example.com");
		await screen.getByText("Continue").click();
		// Should advance to check-email: the h1 heading and the card copy.
		await expect
			.element(screen.getByRole("heading", { level: 1, name: "Check your email" }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("We've sent a verification link to")).toBeInTheDocument();
	});

	it("check-email step shows correct email", async () => {
		const screen = await render(<SignupPage />);
		await screen.getByPlaceholder("you@company.com").fill("test@example.com");
		await screen.getByText("Continue").click();
		await expect.element(screen.getByText("test@example.com")).toBeInTheDocument();
	});

	it("resend button has cooldown timer", async () => {
		mockRequestSignup.mockResolvedValue({ success: true });
		const screen = await render(<SignupPage />);
		await screen.getByPlaceholder("you@company.com").fill("test@example.com");
		await screen.getByText("Continue").click();
		// Should see resend button
		await expect.element(screen.getByText("Resend email")).toBeInTheDocument();
		// Click resend
		await screen.getByText("Resend email").click();
		// Should show cooldown text
		await expect.element(screen.getByText(RESEND_COOLDOWN_REGEX)).toBeInTheDocument();
	});

	it("error step shows correct heading for token_expired", async () => {
		mockVerifySignupToken.mockRejectedValue(
			Object.assign(new Error("This link has expired"), { code: "token_expired" }),
		);
		// Navigate with token in URL
		window.history.replaceState({}, "", "?token=expired-token");
		const screen = await render(<SignupPage />);
		await expect.element(screen.getByText("Link expired")).toBeInTheDocument();
	});

	it("error step shows correct heading for invalid_token", async () => {
		mockVerifySignupToken.mockRejectedValue(
			Object.assign(new Error("Invalid token"), { code: "invalid_token" }),
		);
		window.history.replaceState({}, "", "?token=bad-token");
		const screen = await render(<SignupPage />);
		await expect.element(screen.getByText("Invalid link")).toBeInTheDocument();
	});

	it("error step shows correct heading for user_exists", async () => {
		mockVerifySignupToken.mockRejectedValue(
			Object.assign(new Error("Account already exists"), { code: "user_exists" }),
		);
		window.history.replaceState({}, "", "?token=exists-token");
		const screen = await render(<SignupPage />);
		await expect.element(screen.getByText("Account exists")).toBeInTheDocument();
	});

	// Regression test for #639 / PR #705: the signup page must reflect the
	// configured admin.logo/siteName (white-label branding), not the stock
	// hardcoded EmDash mark — same as LoginPage.
	it("renders the configured admin logo/site name instead of the stock mark", async () => {
		const screen = await render(
			<AdminBrandingProvider
				adminBranding={{ logo: "https://example.com/logo.png", siteName: "Acme CMS" }}
			>
				<SignupPage />
			</AdminBrandingProvider>,
		);
		const logoImg = screen.getByRole("img", { name: "Acme CMS" });
		await expect.element(logoImg).toBeInTheDocument();
		expect(logoImg.element().getAttribute("src")).toBe("https://example.com/logo.png");
		expect(screen.getByRole("img", { name: "EmDash" }).query()).toBeNull();
	});

	it("falls back to the stock EmDash mark when no admin branding is configured", async () => {
		const screen = await render(<SignupPage />);
		await expect.element(screen.getByRole("img", { name: "EmDash" })).toBeInTheDocument();
	});

	it("sends the Turnstile token with signup and explains a failed check on resend", async () => {
		mockFetchAuthMode.mockResolvedValueOnce({ authMode: "passkey", turnstileSiteKey: "site-key" });
		const issueToken: ((token: string) => void)[] = [];
		window.turnstile = {
			render: (_container, options) => {
				issueToken.push(options.callback);
				return `widget-${issueToken.length}`;
			},
			remove: vi.fn(),
		};
		mockRequestSignup.mockResolvedValueOnce({ success: true });

		const screen = await render(<SignupPage />);
		await screen.getByPlaceholder("you@company.com").fill("test@example.com");
		const submit = screen.getByRole("button", { name: "Continue" });
		await expect.element(submit).toBeDisabled();
		await vi.waitFor(() => expect(issueToken).toHaveLength(1));
		issueToken[0]!("first-token");
		await submit.click();

		await expect.element(screen.getByText("Resend email")).toBeInTheDocument();
		expect(mockRequestSignup).toHaveBeenLastCalledWith("test@example.com", "first-token");

		mockRequestSignup.mockRejectedValueOnce(
			new ApiResponseError(403, "TURNSTILE_FAILED", "CAPTCHA verification failed"),
		);
		const resend = screen.getByRole("button", { name: "Resend email" });
		await expect.element(resend).toBeDisabled();
		await vi.waitFor(() => expect(issueToken).toHaveLength(2));
		issueToken[1]!("second-token");
		await resend.click();

		expect(mockRequestSignup).toHaveBeenLastCalledWith("test@example.com", "second-token");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("The security check failed. Please try again.");
		await vi.waitFor(() => expect(issueToken).toHaveLength(3));
		await expect.element(resend).toBeDisabled();
	});
});
