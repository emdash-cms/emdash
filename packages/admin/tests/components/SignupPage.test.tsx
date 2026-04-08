import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";

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
const mockRequestSignup = vi.fn().mockResolvedValue({ success: true });
const mockVerifySignupToken = vi
	.fn()
	.mockResolvedValue({ email: "test@example.com", role: 30, roleName: "Author" });

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
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
		// Should advance to check-email - use the h1 heading to disambiguate
		await expect
			.element(screen.getByRole("heading", { level: 1, name: "Check your email" }))
			.toBeInTheDocument();
	});

	it("check-email step shows correct email", async () => {
		const screen = await render(<SignupPage />);
		await screen.getByPlaceholder("you@company.com").fill("test@example.com");
		await screen.getByText("Continue").click();
		await expect.element(screen.getByText("test@example.com")).toBeInTheDocument();
	});

	it("submit valid email advances to check-email step", async () => {
		const screen = await render(<SignupPage />);
		const input = screen.getByPlaceholder("you@company.com");
		await input.fill("test@example.com");
		await screen.getByText("Continue").click();
		// Should advance to check-email - h2 inside the card is unique to this step
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
});
