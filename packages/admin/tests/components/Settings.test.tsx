import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import type { AdminManifest } from "../../src/lib/api";
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

const mockFetchManifest = vi.fn<() => Promise<AdminManifest>>();
const mockSetLocale = vi.fn<(locale: string) => void>();
const currentUser = vi.hoisted(() => ({ role: 50 }));

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchManifest: (...args: unknown[]) => mockFetchManifest(...(args as [])),
	};
});

vi.mock("../../src/locales/useLocale.js", () => ({
	useLocale: () => ({ locale: "en", setLocale: mockSetLocale }),
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({
		data: { id: "user-1", email: "admin@example.com", role: currentUser.role },
		isLoading: false,
	}),
}));

// Import after mocks
const { Settings } = await import("../../src/components/Settings");

const defaultManifest: AdminManifest = {
	authMode: "passkey",
	collections: {},
	plugins: {},
	taxonomies: [],
	version: "1",
	hash: "",
};

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("Settings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.role = 50;
		mockFetchManifest.mockResolvedValue(defaultManifest);
	});

	it("displays settings heading", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect
			.element(screen.getByRole("heading", { name: "Settings", level: 1, exact: true }))
			.toBeInTheDocument();
	});

	it("shows links to General, Social, and SEO sub-pages", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect.element(screen.getByText("General")).toBeInTheDocument();
		await expect.element(screen.getByText("Social Links")).toBeInTheDocument();
		await expect.element(screen.getByText("SEO")).toBeInTheDocument();
	});

	it("shows links to API Tokens and Email sub-pages", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect.element(screen.getByRole("link", { name: /API Tokens/ })).toBeInTheDocument();
		await expect.element(screen.getByText("Email", { exact: true })).toBeInTheDocument();
	});

	it("shows media usage tracking setup only to administrators", async () => {
		const admin = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect
			.element(admin.getByRole("link", { name: /Media usage tracking/ }))
			.toBeInTheDocument();

		currentUser.role = 40;
		const editor = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		expect(editor.getByRole("link", { name: /Media usage tracking/ }).query()).toBeNull();
	});

	it("groups settings into clear semantic sections", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);

		for (const name of ["Site", "Security Settings", "API Tokens", "Email Settings", "Language"]) {
			await expect
				.element(screen.getByRole("heading", { name, level: 2, exact: true }))
				.toBeInTheDocument();
		}
	});

	it("filters and changes the admin language", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);

		await userEvent.click(screen.getByRole("combobox", { name: "Language", exact: true }));
		await screen.getByRole("combobox", { name: "Search" }).fill("Portu");
		await userEvent.click(screen.getByRole("option", { name: "Português (Brasil)" }));

		expect(mockSetLocale).toHaveBeenCalledWith("pt-BR");
	});

	it("preserves the settings destinations", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);

		expect(screen.getByRole("link", { name: /General/ }).element()).toHaveAttribute(
			"href",
			"/settings/general",
		);
		expect(screen.getByRole("link", { name: /API Tokens/ }).element()).toHaveAttribute(
			"href",
			"/settings/api-tokens",
		);
	});

	it("security link shown when authMode is passkey", async () => {
		mockFetchManifest.mockResolvedValue(defaultManifest);
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Security", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Self-Signup Domains")).toBeInTheDocument();
	});

	it("security link hidden when authMode is not passkey", async () => {
		mockFetchManifest.mockResolvedValue({
			...defaultManifest,
			authMode: "cloudflare-access",
		});
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		// Wait for the page to render by checking a link that's always visible
		await expect.element(screen.getByText("General")).toBeInTheDocument();
		expect(screen.getByText("Security").query()).toBeNull();
		expect(screen.getByText("Self-Signup Domains").query()).toBeNull();
	});
});
