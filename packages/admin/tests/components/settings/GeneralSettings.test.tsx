import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { render } from "../../utils/render";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
	};
});

const mockFetchSettings = vi.fn();
const mockUpdateSettings = vi.fn();

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
		updateSettings: (...args: unknown[]) => mockUpdateSettings(...args),
	};
});

const { GeneralSettings } = await import("../../../src/components/settings/GeneralSettings");

const SETTINGS = {
	title: "EmDash",
	tagline: "A content platform",
	url: "https://example.com",
	postsPerPage: 10,
	dateFormat: "MMMM d, yyyy",
	timezone: "UTC",
	social: {},
};

function Wrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<Toasty>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</Toasty>
	);
}

describe("GeneralSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchSettings.mockResolvedValue(SETTINGS);
		mockUpdateSettings.mockResolvedValue(SETTINGS);
	});

	it("shows the shared loading recipe", async () => {
		mockFetchSettings.mockImplementationOnce(() => new Promise(() => {}));
		const screen = await render(
			<Wrapper>
				<GeneralSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByText("Loading settings...")).toBeInTheDocument();
	});

	it("keeps Save disabled until the form is dirty", async () => {
		const screen = await render(
			<Wrapper>
				<GeneralSettings />
			</Wrapper>,
		);

		const saveButton = screen.getByRole("button", { name: "Saved" }).first();
		await expect.element(saveButton).toBeDisabled();
		await screen.getByLabelText("Site Title").fill("Updated EmDash");
		await expect.element(screen.getByRole("button", { name: "Save" }).first()).not.toBeDisabled();
	});

	it("saves edited settings explicitly", async () => {
		const screen = await render(
			<Wrapper>
				<GeneralSettings />
			</Wrapper>,
		);

		await screen.getByLabelText("Tagline").fill("A better content platform");
		await screen.getByRole("button", { name: "Save" }).first().click();

		await vi.waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
		expect(mockUpdateSettings).toHaveBeenCalledWith({
			...SETTINGS,
			tagline: "A better content platform",
		});
		await expect.element(screen.getByText("Settings saved successfully")).toBeInTheDocument();
	});

	it("shows load failures inline", async () => {
		mockFetchSettings.mockRejectedValueOnce(new Error("Settings unavailable"));
		const screen = await render(
			<Wrapper>
				<GeneralSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByText("Settings unavailable")).toBeInTheDocument();
	});

	it("keeps media controls visible for configured references", async () => {
		mockFetchSettings.mockResolvedValueOnce({
			...SETTINGS,
			logo: { mediaId: "logo-1", url: "/logo.png" },
			favicon: { mediaId: "favicon-1", url: "/favicon.png" },
		});
		const screen = await render(
			<Wrapper>
				<GeneralSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByRole("button", { name: "Change Logo" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Change Favicon" }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Remove" }).first())
			.toBeInTheDocument();
	});
});
