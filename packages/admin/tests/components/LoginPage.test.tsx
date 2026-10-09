import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { AdminBrandingProvider } from "../../src/lib/admin-branding-context";
import { AuthProviderProvider } from "../../src/lib/auth-provider-context";
import type { AuthProviderModule } from "../../src/lib/auth-provider-context";
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

// Mock API — keep a reference so tests can override fetchAuthMode
const mockFetchAuthMode = vi.fn().mockResolvedValue({
	authMode: "passkey",
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchAuthMode: (...args: unknown[]) => mockFetchAuthMode(...args),
		apiFetch: vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
	};
});

// Mock WebAuthn APIs so PasskeyLogin doesn't bail out
Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

// Import after mocks
const { LoginPage } = await import("../../src/components/LoginPage");

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("LoginPage", () => {
	beforeEach(() => {
		// Clean URL params
		window.history.replaceState({}, "", window.location.pathname);
		// Reset auth mode mock to the default passkey response
		mockFetchAuthMode.mockReset();
		mockFetchAuthMode.mockResolvedValue({ authMode: "passkey" });
	});

	it("shows passkey login button when authMode is passkey", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Sign in with Passkey")).toBeInTheDocument();
	});

	it("shows 'Sign in with email link' button", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Sign in with email link")).toBeInTheDocument();
	});

	it("clicking email link button switches to magic link form", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		const emailButton = screen.getByText("Sign in with email link");
		await emailButton.click();
		// Heading should change
		await expect.element(screen.getByText("Sign in with email")).toBeInTheDocument();
	});

	it("magic link form has email input and submit button", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		// Switch to magic link
		await screen.getByText("Sign in with email link").click();
		// Check for email input (by placeholder)
		await expect.element(screen.getByPlaceholder("you@example.com")).toBeInTheDocument();
		// Check for submit button
		await expect.element(screen.getByText("Send magic link")).toBeInTheDocument();
	});

	it("'Back to login' from magic link returns to passkey view", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		// Switch to magic link
		await screen.getByText("Sign in with email link").click();
		await expect.element(screen.getByText("Sign in with email")).toBeInTheDocument();
		// Click back
		await screen.getByText("Back to login").click();
		// Should see passkey button again
		await expect.element(screen.getByText("Sign in with Passkey")).toBeInTheDocument();
	});

	it("hides sign up link when signup is not enabled", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		// Wait for manifest to load (passkey button appears)
		await expect.element(screen.getByText("Sign in with Passkey")).toBeInTheDocument();
		// Sign up link should NOT be present
		expect(screen.getByText("Sign up").query()).toBeNull();
	});

	it("shows sign up link when signup is enabled", async () => {
		mockFetchAuthMode.mockResolvedValueOnce({
			authMode: "passkey",
			signupEnabled: true,
		});

		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Sign up")).toBeInTheDocument();
	});

	// Regression test for #639 / PR #705: the login page must reflect the
	// configured admin.logo/siteName (white-label branding), not the stock
	// hardcoded EmDash mark — same as the Sidebar and SetupWizard already do.
	it("renders the configured admin logo and site name instead of the stock EmDash mark", async () => {
		const screen = await render(
			<QueryWrapper>
				<AdminBrandingProvider
					adminBranding={{ logo: "https://example.com/logo.png", siteName: "Acme CMS" }}
				>
					<LoginPage />
				</AdminBrandingProvider>
			</QueryWrapper>,
		);
		const logoImg = screen.getByRole("img", { name: "Acme CMS" });
		await expect.element(logoImg).toBeInTheDocument();
		expect(logoImg.element().getAttribute("src")).toBe("https://example.com/logo.png");
		// The stock lockup must not also be rendered
		expect(screen.getByRole("img", { name: "EmDash" }).query()).toBeNull();
	});

	it("falls back to the stock EmDash mark when no admin branding is configured", async () => {
		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		await expect.element(screen.getByRole("img", { name: "EmDash" })).toBeInTheDocument();
	});

	it("falls back to neutral help text for providers without a loginHelp export", async () => {
		const passwordProvider: AuthProviderModule = {
			id: "password",
			label: "Email & Password",
			LoginButton: () => <button type="button">Email & Password</button>,
			LoginForm: () => (
				<form data-testid="password-form">
					<input />
				</form>
			),
		};

		const screen = await render(
			<QueryWrapper>
				<AuthProviderProvider authProviders={{ password: passwordProvider }}>
					<LoginPage />
				</AuthProviderProvider>
			</QueryWrapper>,
		);

		await screen.getByText("Email & Password").click();
		await expect.element(screen.getByText("Continue with Email & Password.")).toBeInTheDocument();
		expect(screen.getByText("Enter your handle to sign in.").query()).toBeNull();
	});

	it("shows a provider's exported loginHelp string on its LoginForm", async () => {
		const handleProvider: AuthProviderModule = {
			id: "atproto-mock",
			label: "Mock Atmosphere",
			LoginButton: () => <button type="button">Mock Atmosphere</button>,
			LoginForm: () => (
				<form data-testid="handle-form">
					<input />
				</form>
			),
			loginHelp: "Enter your handle to sign in.",
		};

		const screen = await render(
			<QueryWrapper>
				<AuthProviderProvider authProviders={{ "atproto-mock": handleProvider }}>
					<LoginPage />
				</AuthProviderProvider>
			</QueryWrapper>,
		);

		await screen.getByText("Mock Atmosphere").click();
		await expect.element(screen.getByText("Enter your handle to sign in.")).toBeInTheDocument();
		expect(screen.getByText("Continue with Mock Atmosphere.").query()).toBeNull();
	});

	it("supports loginHelp exported as a component", async () => {
		function CustomHelp() {
			return <>Custom provider help.</>;
		}

		const customProvider: AuthProviderModule = {
			id: "custom",
			label: "Custom Provider",
			LoginButton: () => <button type="button">Custom Provider</button>,
			LoginForm: () => (
				<form data-testid="custom-form">
					<input />
				</form>
			),
			loginHelp: CustomHelp,
		};

		const screen = await render(
			<QueryWrapper>
				<AuthProviderProvider authProviders={{ custom: customProvider }}>
					<LoginPage />
				</AuthProviderProvider>
			</QueryWrapper>,
		);

		await screen.getByText("Custom Provider").click();
		await expect.element(screen.getByText("Custom provider help.")).toBeInTheDocument();
		expect(screen.getByText("Continue with Custom Provider.").query()).toBeNull();
	});
});
