import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import type { MediaItem, SiteSettings } from "../../../src/lib/api";
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

vi.mock("../../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({
		open,
		title,
		onSelect,
	}: {
		open: boolean;
		title: React.ReactNode;
		onSelect: (media: MediaItem) => void;
	}) => {
		if (!open) return null;
		const modalTitle = typeof title === "string" ? title : "";
		const isLogo = modalTitle === "Select logo";
		return (
			<div role="dialog" aria-label={modalTitle}>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: isLogo ? "new-logo" : "new-favicon",
							filename: isLogo ? "logo.png" : "favicon.png",
							mimeType: "image/png",
							url: isLogo ? "/media/logo.png" : "/media/favicon.png",
							alt: isLogo ? "Replacement logo" : "",
							provider: "local",
							storageKey: isLogo ? "logo.png" : "favicon.png",
							size: 1,
							createdAt: "2026-01-01T00:00:00.000Z",
						})
					}
				>
					Choose image
				</button>
			</div>
		);
	},
}));

const { GeneralSettings } = await import("../../../src/components/settings/GeneralSettings");

const defaultSettings: Partial<SiteSettings> = {
	title: "My Blog",
	tagline: "Thoughts on building for the web",
	url: "https://example.com",
	postsPerPage: 10,
	dateFormat: "MMMM d, yyyy",
	timezone: "UTC",
	social: { github: "https://github.com/example" },
};

function Wrapper({ children }: { children: React.ReactNode }) {
	return <Toasty>{children}</Toasty>;
}

async function renderGeneralSettings() {
	return render(<GeneralSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchSettings.mockResolvedValue(defaultSettings);
	mockUpdateSettings.mockImplementation(async (settings) => {
		mockFetchSettings.mockResolvedValue(settings);
		return settings;
	});
});

describe("GeneralSettings", () => {
	it("shows the shared frame while settings load", async () => {
		mockFetchSettings.mockReturnValue(new Promise(() => undefined));
		const screen = await renderGeneralSettings();

		await expect
			.element(screen.getByRole("heading", { name: "General Settings", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading settings...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("shows a load failure without form actions", async () => {
		mockFetchSettings.mockRejectedValue(new Error("Settings service unavailable"));
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("An error occurred");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Settings service unavailable");
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("renders grouped fields with both save actions initially disabled", async () => {
		const screen = await renderGeneralSettings();

		await expect.element(screen.getByLabelText("Site Title")).toHaveValue("My Blog");
		await expect
			.element(screen.getByRole("heading", { name: "Site Identity", level: 2 }))
			.toBeInTheDocument();
		await expect
			.element(screen.getByRole("heading", { name: "Reading", level: 2 }))
			.toBeInTheDocument();

		const saveButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(saveButtons).toHaveLength(2);
		for (const button of saveButtons) await expect.element(button).toBeDisabled();
	});

	it("enables both save actions when dirty and returns to saved after success", async () => {
		const screen = await renderGeneralSettings();
		await screen.getByLabelText("Site Title").fill("A better blog");

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();

		await userEvent.click(dirtyButtons[0]);
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith({
				...defaultSettings,
				title: "A better blog",
			});
		});
		await expect.element(screen.getByText("Settings saved successfully")).toBeInTheDocument();

		const savedButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(savedButtons).toHaveLength(2);
		for (const button of savedButtons) await expect.element(button).toBeDisabled();
	});

	it("keeps cached settings visible when the post-save refetch fails", async () => {
		mockUpdateSettings.mockImplementation(async (settings) => {
			mockFetchSettings.mockRejectedValue(new Error("Settings refetch failed"));
			return settings;
		});
		const screen = await renderGeneralSettings();
		await screen.getByLabelText("Site Title").fill("A better blog");

		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);

		await vi.waitFor(() => expect(mockFetchSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
		await expect.element(screen.getByLabelText("Site Title")).toHaveValue("A better blog");
		expect(screen.getByRole("alert").query()).toBeNull();
	});

	it("keeps the form dirty and reports a failed save", async () => {
		mockUpdateSettings.mockRejectedValue(new Error("Could not persist settings"));
		const screen = await renderGeneralSettings();
		await screen.getByLabelText("Tagline").fill("A changed tagline");

		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);
		await expect.element(screen.getByText("Failed to save settings")).toBeInTheDocument();
		await expect.element(screen.getByText("Could not persist settings")).toBeInTheDocument();

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();
	});

	it("marks media selections dirty and includes them in the saved settings", async () => {
		const screen = await renderGeneralSettings();

		await userEvent.click(screen.getByRole("button", { name: "Select Logo" }));
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));
		await expect.element(screen.getByRole("img", { name: "Replacement logo" })).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Select Favicon" }));
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));
		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);

		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					logo: {
						mediaId: "new-logo",
						alt: "Replacement logo",
						url: "/media/logo.png",
					},
					favicon: { mediaId: "new-favicon", url: "/media/favicon.png" },
				}),
			);
		});
	});

	it("allows existing logo and favicon references to be removed", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			logo: { mediaId: "old-logo", alt: "Old logo", url: "/media/old-logo.png" },
			favicon: { mediaId: "old-favicon", url: "/media/old-favicon.png" },
		});
		const screen = await renderGeneralSettings();
		await expect.element(screen.getByRole("img", { name: "Old logo" })).toBeInTheDocument();

		const removeButtons = screen.getByRole("button", { name: "Remove" }).all();
		expect(removeButtons).toHaveLength(2);
		await userEvent.click(removeButtons[0]);
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));

		await expect.element(screen.getByRole("button", { name: "Select Logo" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Select Favicon" }))
			.toBeInTheDocument();
		for (const button of screen.getByRole("button", { name: "Save", exact: true }).all()) {
			await expect.element(button).toBeEnabled();
		}
	});
});
