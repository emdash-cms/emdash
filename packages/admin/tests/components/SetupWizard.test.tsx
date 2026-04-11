import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "../utils/render.js";

// Mock API
vi.mock("../../src/lib/api/client", async () => {
	const actual = await vi.importActual("../../src/lib/api/client");
	return {
		...actual,
		apiFetch: vi.fn().mockImplementation((url: string) => {
			if (url.includes("/setup/status")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: { needsSetup: true, authMode: "passkey" } }), {
						status: 200,
					}),
				);
			}
			if (url.includes("/setup/admin")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: { success: true } }), { status: 200 }),
				);
			}
			if (url.includes("/setup") && !url.includes("status")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: { success: true } }), { status: 200 }),
				);
			}
			return Promise.resolve(new Response(JSON.stringify({ data: {} }), { status: 200 }));
		}),
	};
});

// Mock WebAuthn so PasskeyRegistration doesn't bail out
Object.defineProperty(window, "PublicKeyCredential", {
	value: function PublicKeyCredential() {},
	writable: true,
});

// Import after mocks
const { SetupWizard } = await import("../../src/components/SetupWizard");

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("SetupWizard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows site setup step first with title input", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		await expect.element(screen.getByPlaceholder("My Awesome Blog")).toBeInTheDocument();
	});

	it("empty title prevents advancing and shows validation error", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		// Wait for setup status to load
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		// Click Continue without filling title
		await screen.getByText("Continue →").click();
		await expect.element(screen.getByText("Site title is required")).toBeInTheDocument();
		// Should still be on site step
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
	});

	it("filling title and clicking Next advances to admin step", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		// Fill in the title
		await screen.getByPlaceholder("My Awesome Blog").fill("Test Site");
		// Click continue
		await screen.getByText("Continue →").click();
		// Should advance to admin step
		await expect.element(screen.getByText("Create your account")).toBeInTheDocument();
	});

	it("admin step shows email input", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		// Fill title and advance
		await screen.getByPlaceholder("My Awesome Blog").fill("Test Site");
		await screen.getByText("Continue →").click();
		// Should see email input on admin step
		await expect.element(screen.getByText("Create your account")).toBeInTheDocument();
		await expect.element(screen.getByPlaceholder("you@example.com")).toBeInTheDocument();
	});

	it("empty email prevents advancing on admin step", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		// Fill title and advance
		await screen.getByPlaceholder("My Awesome Blog").fill("Test Site");
		await screen.getByText("Continue →").click();
		await expect.element(screen.getByText("Create your account")).toBeInTheDocument();
		// Click Continue without filling email
		await screen.getByText("Continue →").click();
		// Should show validation error
		await expect.element(screen.getByText("Email is required")).toBeInTheDocument();
	});

	it("step indicator shows three steps", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		// Step indicator labels - use exact matching via role
		await expect.element(screen.getByText("Account")).toBeInTheDocument();
		await expect.element(screen.getByText("Passkey")).toBeInTheDocument();
	});
});
