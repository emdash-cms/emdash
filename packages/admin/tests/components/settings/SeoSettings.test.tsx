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

vi.mock("../../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({ open, onSelect }: { open: boolean; onSelect: (item: unknown) => void }) =>
		open ? (
			<button type="button" onClick={() => onSelect({ id: "og-2", alt: "", url: "/og-2.png" })}>
				Choose image
			</button>
		) : null,
}));

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

const { SeoSettings } = await import("../../../src/components/settings/SeoSettings");

const SETTINGS = {
	title: "EmDash",
	postsPerPage: 10,
	dateFormat: "MMMM d, yyyy",
	timezone: "UTC",
	seo: {
		titleSeparator: "|",
		googleVerification: "google-token",
		bingVerification: "",
		robotsTxt: "User-agent: *",
	},
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

describe("SeoSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchSettings.mockResolvedValue(SETTINGS);
		mockUpdateSettings.mockResolvedValue(SETTINGS);
	});

	it("renders SEO fields and keeps Save disabled when unchanged", async () => {
		const screen = await render(
			<Wrapper>
				<SeoSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByLabelText("Title Separator")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Google Verification")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("robots.txt")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Saved" }).first()).toBeDisabled();
	});

	it("preserves OG picker selection state and marks the form dirty", async () => {
		mockFetchSettings.mockResolvedValueOnce({
			...SETTINGS,
			seo: { ...SETTINGS.seo, defaultOgImage: { mediaId: "og-1", url: "/og-1.png" } },
		});
		const screen = await render(
			<Wrapper>
				<SeoSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByRole("button", { name: "Change Image" })).toBeInTheDocument();
		await screen.getByRole("button", { name: "Change Image" }).click();
		await screen.getByRole("button", { name: "Choose image" }).click();
		await expect.element(screen.getByRole("button", { name: "Save" }).first()).not.toBeDisabled();
	});

	it("saves SEO values and reports load failures", async () => {
		const screen = await render(
			<Wrapper>
				<SeoSettings />
			</Wrapper>,
		);

		await screen.getByLabelText("Bing Verification").fill("bing-token");
		await screen.getByRole("button", { name: "Save" }).first().click();
		await vi.waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
		expect(mockUpdateSettings).toHaveBeenCalledWith({
			...SETTINGS,
			seo: { ...SETTINGS.seo, bingVerification: "bing-token" },
		});
		await expect.element(screen.getByText("SEO settings saved")).toBeInTheDocument();

		mockFetchSettings.mockRejectedValueOnce(new Error("SEO settings unavailable"));
		const failedScreen = await render(
			<Wrapper>
				<SeoSettings />
			</Wrapper>,
		);
		await expect.element(failedScreen.getByText("SEO settings unavailable")).toBeInTheDocument();
	});
});
