import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AdminManifest } from "../../src/lib/api";
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

const mockFetchManifest = vi.fn<() => Promise<AdminManifest>>();

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchManifest: (...args: unknown[]) => mockFetchManifest(...(args as [])),
	};
});

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
		mockFetchManifest.mockResolvedValue(defaultManifest);
	});

	it("displays settings heading", async () => {
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect.element(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
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
		await expect.element(screen.getByText("API Tokens")).toBeInTheDocument();
		await expect.element(screen.getByText("Email", { exact: true })).toBeInTheDocument();
	});

	it("security link shown when authMode is passkey", async () => {
		mockFetchManifest.mockResolvedValue(defaultManifest);
		const screen = await render(
			<Wrapper>
				<Settings />
			</Wrapper>,
		);
		await expect.element(screen.getByText("Security")).toBeInTheDocument();
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
