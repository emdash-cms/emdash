import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render } from "../utils/render.js";

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

// Mock API — keep a reference so tests can override fetchManifest
const mockFetchManifest = vi.fn().mockResolvedValue({
	authMode: "passkey",
	collections: {},
	plugins: {},
	version: "1",
	hash: "",
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchManifest: (...args: unknown[]) => mockFetchManifest(...args),
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
		mockFetchManifest.mockResolvedValueOnce({
			authMode: "passkey",
			collections: {},
			plugins: {},
			version: "1",
			hash: "",
			signupEnabled: true,
		});

		const screen = await render(
			<QueryWrapper>
				<LoginPage />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Sign up")).toBeInTheDocument();
	});
});
