import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { SiteSettings } from "../../../src/lib/api";
import { render } from "../../utils/render";

const mockFetchSettings = vi.fn<() => Promise<Partial<SiteSettings>>>();
const mockUpdateSettings =
	vi.fn<(settings: Partial<SiteSettings>) => Promise<Partial<SiteSettings>>>();

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		fetchSettings: () => mockFetchSettings(),
		updateSettings: (settings: Partial<SiteSettings>) => mockUpdateSettings(settings),
	};
});

const { SocialSettings } = await import("../../../src/components/settings/SocialSettings");

const defaultSettings: Partial<SiteSettings> = {
	title: "My Blog",
	social: {
		twitter: "@example",
		github: "example",
		facebook: "example.page",
		instagram: "example.photos",
		linkedin: "example-profile",
		youtube: "@example-video",
	},
};

function Wrapper({ children }: { children: React.ReactNode }) {
	return <Toasty>{children}</Toasty>;
}

async function renderSocialSettings() {
	return render(<SocialSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchSettings.mockResolvedValue(defaultSettings);
	mockUpdateSettings.mockImplementation(async (settings) => {
		mockFetchSettings.mockResolvedValue(settings);
		return settings;
	});
});

describe("SocialSettings", () => {
	it("shows the shared frame while settings load", async () => {
		mockFetchSettings.mockReturnValue(new Promise(() => undefined));
		const screen = await renderSocialSettings();

		await expect
			.element(screen.getByRole("heading", { name: "Social Links", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading settings...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("shows a load failure without form actions", async () => {
		mockFetchSettings.mockRejectedValue(new Error("Settings service unavailable"));
		const screen = await renderSocialSettings();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("An error occurred");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Settings service unavailable");
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("renders existing social profiles with both save actions initially disabled", async () => {
		const screen = await renderSocialSettings();

		await expect.element(screen.getByLabelText("Twitter")).toHaveValue("@example");
		await expect.element(screen.getByLabelText("GitHub")).toHaveValue("example");
		await expect.element(screen.getByLabelText("Facebook")).toHaveValue("example.page");
		await expect.element(screen.getByLabelText("Instagram")).toHaveValue("example.photos");
		await expect.element(screen.getByLabelText("LinkedIn")).toHaveValue("example-profile");
		await expect.element(screen.getByLabelText("YouTube")).toHaveValue("@example-video");

		const saveButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(saveButtons).toHaveLength(2);
		for (const button of saveButtons) await expect.element(button).toBeDisabled();
	});

	it("enables both save actions when dirty and returns to saved after a header save", async () => {
		const screen = await renderSocialSettings();
		await screen.getByLabelText("GitHub").fill("emdash-cms");

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();

		await userEvent.click(dirtyButtons[0]);
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith({
				...defaultSettings,
				social: { ...defaultSettings.social, github: "emdash-cms" },
			});
		});
		await expect.element(screen.getByText("Social links saved")).toBeInTheDocument();

		const savedButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(savedButtons).toHaveLength(2);
		for (const button of savedButtons) await expect.element(button).toBeDisabled();
	});

	it("keeps cached social links visible when the post-save refetch fails", async () => {
		mockUpdateSettings.mockImplementation(async (settings) => {
			mockFetchSettings.mockRejectedValue(new Error("Settings refetch failed"));
			return settings;
		});
		const screen = await renderSocialSettings();
		await screen.getByLabelText("GitHub").fill("emdash-cms");

		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);

		await vi.waitFor(() => expect(mockFetchSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
		await expect.element(screen.getByLabelText("GitHub")).toHaveValue("emdash-cms");
		expect(screen.getByRole("alert").query()).toBeNull();
	});

	it("submits changes from the bottom save action", async () => {
		const screen = await renderSocialSettings();
		await screen.getByLabelText("YouTube").fill("@emdash-cms");

		const saveButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		await userEvent.click(saveButtons[1]);

		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith({
				...defaultSettings,
				social: { ...defaultSettings.social, youtube: "@emdash-cms" },
			});
		});
	});

	it("keeps the form dirty and reports a failed save", async () => {
		mockUpdateSettings.mockRejectedValue(new Error("Could not persist settings"));
		const screen = await renderSocialSettings();
		await screen.getByLabelText("Instagram").fill("new.photos");

		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);
		await expect.element(screen.getByText("Failed to save settings")).toBeInTheDocument();
		await expect.element(screen.getByText("Could not persist settings")).toBeInTheDocument();

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();
	});
});
