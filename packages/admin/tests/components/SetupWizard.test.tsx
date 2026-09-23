import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render } from "../utils/render.tsx";

// Mock API
let mockSeedInfo: any = null;
let mockAuthMode: "passkey" | "cloudflare-access" = "passkey";
let setupRequests: unknown[] = [];
const navigateTo = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/navigation.js", () => ({ navigateTo }));

vi.mock("../../src/lib/api/client", async () => {
	const actual = await vi.importActual("../../src/lib/api/client");
	return {
		...actual,
		apiFetch: vi.fn().mockImplementation((url: string, init?: RequestInit) => {
			if (url.includes("/setup/status")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: {
								needsSetup: true,
								authMode: mockAuthMode,
								...(mockSeedInfo ? { seedInfo: mockSeedInfo } : {}),
							},
						}),
						{
							status: 200,
						},
					),
				);
			}
			if (url.includes("/setup/admin")) {
				return Promise.resolve(
					new Response(JSON.stringify({ data: { success: true } }), { status: 200 }),
				);
			}
			if (url.includes("/setup") && !url.includes("status")) {
				setupRequests.push(JSON.parse(init?.body as string));
				return Promise.resolve(
					new Response(
						JSON.stringify({
							data: { success: true, setupComplete: mockAuthMode === "cloudflare-access" },
						}),
						{ status: 200 },
					),
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
const { AuthProviderProvider } = await import("../../src/lib/auth-provider-context");

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("SetupWizard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockSeedInfo = null;
		mockAuthMode = "passkey";
		setupRequests = [];
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

	it("does not present media usage tracking as an onboarding choice", async () => {
		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);
		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: /Track where media is used/ }).query()).toBeNull();
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
		await expect.element(screen.getByText("Sign In")).toBeInTheDocument();
	});

	it("prefills title and tagline from seedInfo", async () => {
		mockSeedInfo = {
			name: "Blog Template",
			description: "A blog template",
			collections: 2,
			hasContent: true,
			title: "My Awesome Blog",
			tagline: "Thoughts and tutorials",
		};

		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();

		const titleInput = screen.getByPlaceholder("My Awesome Blog");
		const taglineInput = screen.getByPlaceholder("Thoughts, tutorials, and more");

		await vi.waitFor(() => {
			expect((titleInput.element() as HTMLInputElement).value).toBe("My Awesome Blog");
		});
		await vi.waitFor(() => {
			expect((taglineInput.element() as HTMLInputElement).value).toBe("Thoughts and tutorials");
		});
	});

	it("uses empty string for title and tagline when not in seedInfo", async () => {
		mockSeedInfo = {
			name: "Blank Template",
			description: "A blank template",
			collections: 0,
			hasContent: false,
			// title and tagline not provided
		};

		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();

		const titleInput = screen.getByPlaceholder("My Awesome Blog");
		const taglineInput = screen.getByPlaceholder("Thoughts, tutorials, and more");

		await vi.waitFor(() => {
			expect((titleInput.element() as HTMLInputElement).value).toBe("");
		});
		await vi.waitFor(() => {
			expect((taglineInput.element() as HTMLInputElement).value).toBe("");
		});
	});

	it("prefilled title can be edited and submitted", async () => {
		mockSeedInfo = {
			name: "Blog Template",
			description: "A blog template",
			collections: 2,
			hasContent: true,
			title: "My Awesome Blog",
			tagline: "Thoughts and tutorials",
		};

		const screen = await render(
			<QueryWrapper>
				<SetupWizard />
			</QueryWrapper>,
		);

		await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();

		const titleInput = screen.getByPlaceholder("My Awesome Blog");
		await vi.waitFor(() => {
			expect((titleInput.element() as HTMLInputElement).value).toBe("My Awesome Blog");
		});

		// Edit the title
		await titleInput.fill("My Custom Blog");
		await vi.waitFor(() => {
			expect((screen.getByPlaceholder("My Awesome Blog").element() as HTMLInputElement).value).toBe(
				"My Custom Blog",
			);
		});

		// Should be able to advance with the edited value
		await screen.getByText("Continue →").click();
		await expect.element(screen.getByText("Create your account")).toBeInTheDocument();
	});

	describe("starting from a site package", () => {
		const blogSeed = {
			name: "Blog Template",
			description: "A blog template",
			collections: 2,
			hasContent: true,
		};

		const testProvider = {
			id: "test",
			label: "Test Provider",
			LoginButton: () => <button type="button">Sign in with test provider</button>,
			SetupStep: ({ onComplete }: { onComplete: () => void }) => (
				<button type="button" onClick={onComplete}>
					Finish provider setup
				</button>
			),
		};

		async function renderWizard() {
			const screen = await render(
				<QueryWrapper>
					<AuthProviderProvider authProviders={{ test: testProvider }}>
						<SetupWizard />
					</AuthProviderProvider>
				</QueryWrapper>,
			);
			await expect.element(screen.getByText("Set up your site")).toBeInTheDocument();
			return screen;
		}

		async function completeSiteAndAccount(screen: Awaited<ReturnType<typeof renderWizard>>) {
			await screen.getByPlaceholder("My Awesome Blog").fill("Moved Site");
			await screen.getByText("Continue →").click();
			await expect.element(screen.getByText("Create your account")).toBeInTheDocument();
			await screen.getByPlaceholder("you@example.com").fill("admin@example.com");
			await screen.getByText("Continue →").click();
			await screen.getByRole("button", { name: "Sign in with test provider" }).click();
			await screen.getByRole("button", { name: "Finish provider setup" }).click();
		}

		it("offers import alongside sample content and an empty site", async () => {
			mockSeedInfo = blogSeed;
			const screen = await renderWizard();

			await expect.element(screen.getByRole("radio", { name: /Sample content/ })).toBeChecked();
			await expect.element(screen.getByRole("radio", { name: /Empty site/ })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("radio", { name: /Import an existing EmDash site/ }))
				.toBeInTheDocument();
		});

		it("skips sample content and lands on the Transfer import after signing in", async () => {
			mockSeedInfo = blogSeed;
			const screen = await renderWizard();

			await screen.getByText("Import an existing EmDash site").click();
			await completeSiteAndAccount(screen);

			await vi.waitFor(() => {
				expect(navigateTo).toHaveBeenCalledWith("/_emdash/admin/settings/transfer?start=import");
			});
			expect(setupRequests).toEqual([{ title: "Moved Site", tagline: "", includeContent: false }]);
		});

		it("keeps sample content and the dashboard as the default", async () => {
			mockSeedInfo = blogSeed;
			const screen = await renderWizard();

			await completeSiteAndAccount(screen);

			await vi.waitFor(() => {
				expect(navigateTo).toHaveBeenCalledWith("/_emdash/admin");
			});
			expect(setupRequests).toEqual([{ title: "Moved Site", tagline: "", includeContent: true }]);
		});

		it("skips sample content for an empty site", async () => {
			mockSeedInfo = blogSeed;
			const screen = await renderWizard();

			await screen.getByText("Empty site").click();
			await completeSiteAndAccount(screen);

			await vi.waitFor(() => {
				expect(navigateTo).toHaveBeenCalledWith("/_emdash/admin");
			});
			expect(setupRequests).toEqual([{ title: "Moved Site", tagline: "", includeContent: false }]);
		});

		it("goes straight to the Transfer import when Cloudflare Access completes setup", async () => {
			mockAuthMode = "cloudflare-access";
			const screen = await renderWizard();

			await expect
				.element(screen.getByRole("radio", { name: /Sample content/ }))
				.not.toBeInTheDocument();
			await expect.element(screen.getByRole("radio", { name: /Empty site/ })).toBeChecked();
			await screen.getByText("Import an existing EmDash site").click();
			await screen.getByPlaceholder("My Awesome Blog").fill("Moved Site");
			await screen.getByText("Continue →").click();

			await vi.waitFor(() => {
				expect(navigateTo).toHaveBeenCalledWith("/_emdash/admin/settings/transfer?start=import");
			});
		});
	});
});
