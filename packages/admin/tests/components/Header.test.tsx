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
								role: 50,
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

const THEME_BUTTON_REGEX = /Theme:/;

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
	});

	it("theme toggle button is present", async () => {
		const screen = await render(
			<TestWrapper>
				<Header />
			</TestWrapper>,
		);
		// ThemeToggle renders a button with title containing "Theme:"
		const themeButton = screen.getByTitle(THEME_BUTTON_REGEX);
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
});
