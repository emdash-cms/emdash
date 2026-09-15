import { Sidebar } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { ThemeProvider } from "../../src/components/ThemeProvider";
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

// Mutable so individual tests can render the header as a non-admin.
const currentUser = vi.hoisted(() => ({ role: 50 }));

// Mock API
vi.mock("../../src/lib/api/client", async () => {
	const actual = await vi.importActual("../../src/lib/api/client");
	return {
		...actual,
		apiFetch: vi.fn().mockImplementation((url: string) => {
			if (url.includes("/auth/me")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: {
								id: "1",
								name: "Matt Kane",
								email: "matt@test.com",
								role: currentUser.role,
							},
						}),
						{ status: 200 },
					),
				);
			}
			return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
		}),
	};
});

// Import after mocks
const { Header } = await import("../../src/components/Header");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THEME_BUTTON_REGEX = /Switch to (light|dark)/;
const USER_MENU_REGEX = /Matt Kane/;

// Mirror @emdash-cms/auth Role levels (kept inline, matching Header.tsx).
const ROLE_AUTHOR = 30;
const ROLE_ADMIN = 50;

function TestWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={qc}>
			<ThemeProvider defaultTheme="light">
				<Sidebar.Provider defaultOpen>{children}</Sidebar.Provider>
			</ThemeProvider>
		</QueryClientProvider>
	);
}

describe("Header", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.removeAttribute("data-mode");
		currentUser.role = ROLE_ADMIN;
	});

	it("theme toggle button is present", async () => {
		const screen = await render(
			<TestWrapper>
				<Header />
			</TestWrapper>,
		);
		// ThemeToggle exposes its next action in the aria-label.
		// (Kumo 2.x wraps `<Button title>` as a Tooltip popup, not a DOM title.)
		const themeButton = screen.getByLabelText(THEME_BUTTON_REGEX);
		await expect.element(themeButton).toBeInTheDocument();
	});

	it("displays user name when loaded", async () => {
		const screen = await render(
			<TestWrapper>
				<Header />
			</TestWrapper>,
		);
		// User data loads async via react-query
		await expect.element(screen.getByText("Matt Kane")).toBeInTheDocument();
	});

	it("View Site link is present", async () => {
		const screen = await render(
			<TestWrapper>
				<Header />
			</TestWrapper>,
		);
		await expect.element(screen.getByText("View Site")).toBeInTheDocument();
	});

	describe("user menu role gate", () => {
		it("shows Settings and Security Settings for an admin", async () => {
			const screen = await render(
				<TestWrapper>
					<Header />
				</TestWrapper>,
			);
			await screen.getByRole("button", { name: USER_MENU_REGEX }).click();

			await expect
				.element(screen.getByRole("link", { name: "Settings", exact: true }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("link", { name: "Security Settings", exact: true }))
				.toBeInTheDocument();
		});

		it("hides Settings for a non-admin but keeps Security Settings (own passkeys)", async () => {
			currentUser.role = ROLE_AUTHOR;
			const screen = await render(
				<TestWrapper>
					<Header />
				</TestWrapper>,
			);
			await screen.getByRole("button", { name: USER_MENU_REGEX }).click();

			await expect
				.element(screen.getByRole("link", { name: "Security Settings", exact: true }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("link", { name: "Settings", exact: true }))
				.not.toBeInTheDocument();
		});
	});
});
