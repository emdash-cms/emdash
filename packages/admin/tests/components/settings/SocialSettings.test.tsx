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

const { SocialSettings } = await import("../../../src/components/settings/SocialSettings");

const SETTINGS = {
	title: "EmDash",
	postsPerPage: 10,
	dateFormat: "MMMM d, yyyy",
	timezone: "UTC",
	social: {
		twitter: "@emdash",
		github: "cloudflare",
		facebook: "",
		instagram: "",
		linkedin: "",
		youtube: "",
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

describe("SocialSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFetchSettings.mockResolvedValue(SETTINGS);
		mockUpdateSettings.mockResolvedValue(SETTINGS);
	});

	it("renders all six social fields", async () => {
		const screen = await render(
			<Wrapper>
				<SocialSettings />
			</Wrapper>,
		);

		for (const label of ["Twitter", "GitHub", "Facebook", "Instagram", "LinkedIn", "YouTube"]) {
			await expect.element(screen.getByLabelText(label)).toBeInTheDocument();
		}
	});

	it("enables Save only after a social value changes", async () => {
		const screen = await render(
			<Wrapper>
				<SocialSettings />
			</Wrapper>,
		);

		await expect.element(screen.getByRole("button", { name: "Saved" }).first()).toBeDisabled();
		await screen.getByLabelText("Instagram").fill("@emdashcms");
		await expect.element(screen.getByRole("button", { name: "Save" }).first()).not.toBeDisabled();
	});

	it("saves social values and reports success", async () => {
		const screen = await render(
			<Wrapper>
				<SocialSettings />
			</Wrapper>,
		);

		await screen.getByLabelText("YouTube").fill("@emdash");
		await screen.getByRole("button", { name: "Save" }).first().click();

		await vi.waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledTimes(1));
		expect(mockUpdateSettings).toHaveBeenCalledWith({
			...SETTINGS,
			social: { ...SETTINGS.social, youtube: "@emdash" },
		});
		await expect.element(screen.getByText("Social links saved")).toBeInTheDocument();
	});

	it("reports save failures with the server message", async () => {
		mockUpdateSettings.mockRejectedValueOnce(new Error("Social provider rejected the update"));
		const screen = await render(
			<Wrapper>
				<SocialSettings />
			</Wrapper>,
		);

		await screen.getByLabelText("Twitter").fill("@newhandle");
		await screen.getByRole("button", { name: "Save" }).first().click();

		await expect.element(screen.getByText("Failed to save settings")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Social provider rejected the update"))
			.toBeInTheDocument();
	});
});
