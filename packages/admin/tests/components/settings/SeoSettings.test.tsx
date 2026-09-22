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
		return (
			<div role="dialog" aria-label={modalTitle}>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "new-og-image",
							filename: "social-card.png",
							mimeType: "image/png",
							url: "/media/social-card.png",
							alt: "Social card",
							provider: "local",
							storageKey: "social-card.png",
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

const { SeoSettings } = await import("../../../src/components/settings/SeoSettings");

const defaultSettings: Partial<SiteSettings> = {
	title: "My Blog",
	seo: {
		titleSeparator: "—",
		defaultOgImage: {
			mediaId: "existing-og-image",
			alt: "Existing social card",
			url: "/media/existing-social-card.png",
		},
		googleVerification: "google-code",
		bingVerification: "bing-code",
		robotsTxt: "User-agent: *\nDisallow: /private/",
	},
};

function Wrapper({ children }: { children: React.ReactNode }) {
	return <Toasty>{children}</Toasty>;
}

async function renderSeoSettings() {
	return render(<SeoSettings />, { wrapper: Wrapper });
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetchSettings.mockResolvedValue(defaultSettings);
	mockUpdateSettings.mockImplementation(async (settings) => {
		mockFetchSettings.mockResolvedValue(settings);
		return settings;
	});
});

describe("SeoSettings", () => {
	it("shows the shared frame while settings load", async () => {
		mockFetchSettings.mockReturnValue(new Promise(() => undefined));
		const screen = await renderSeoSettings();

		await expect
			.element(screen.getByRole("heading", { name: "SEO Settings", level: 1 }))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Loading settings...")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("shows a load failure without form actions", async () => {
		mockFetchSettings.mockRejectedValue(new Error("Settings service unavailable"));
		const screen = await renderSeoSettings();

		await expect.element(screen.getByRole("alert")).toHaveTextContent("An error occurred");
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("Settings service unavailable");
		expect(screen.getByRole("button", { name: "Save" }).query()).toBeNull();
	});

	it("renders initial SEO values with both save actions pristine", async () => {
		const screen = await renderSeoSettings();

		await expect.element(screen.getByLabelText("Title Separator")).toHaveValue("—");
		await expect
			.element(screen.getByRole("textbox", { name: "Google Verification", exact: true }))
			.toHaveValue("google-code");
		await expect
			.element(screen.getByRole("textbox", { name: "Bing Verification", exact: true }))
			.toHaveValue("bing-code");
		await expect
			.element(screen.getByRole("textbox", { name: "robots.txt", exact: true }))
			.toHaveValue("User-agent: *\nDisallow: /private/");
		await expect
			.element(screen.getByRole("img", { name: "Existing social card" }))
			.toBeInTheDocument();

		const saveButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(saveButtons).toHaveLength(2);
		for (const button of saveButtons) await expect.element(button).toBeDisabled();
	});

	it("submits the bottom save action and returns both actions to pristine", async () => {
		const screen = await renderSeoSettings();
		await screen
			.getByRole("textbox", { name: "Google Verification", exact: true })
			.fill("updated-google-code");

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();

		await userEvent.click(dirtyButtons[1]);
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith({
				...defaultSettings,
				seo: {
					...defaultSettings.seo,
					googleVerification: "updated-google-code",
				},
			});
		});
		await expect.element(screen.getByText("SEO settings saved")).toBeInTheDocument();

		const savedButtons = screen.getByRole("button", { name: "Saved", exact: true }).all();
		expect(savedButtons).toHaveLength(2);
		for (const button of savedButtons) await expect.element(button).toBeDisabled();
	});

	it("keeps cached SEO settings visible when the post-save refetch fails", async () => {
		mockUpdateSettings.mockImplementation(async (settings) => {
			mockFetchSettings.mockRejectedValue(new Error("Settings refetch failed"));
			return settings;
		});
		const screen = await renderSeoSettings();
		await screen
			.getByRole("textbox", { name: "Google Verification", exact: true })
			.fill("updated-google-code");

		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);

		await vi.waitFor(() => expect(mockFetchSettings.mock.calls.length).toBeGreaterThanOrEqual(2));
		await expect
			.element(screen.getByRole("textbox", { name: "Google Verification", exact: true }))
			.toHaveValue("updated-google-code");
		expect(screen.getByRole("alert").query()).toBeNull();
	});

	it("keeps the form dirty when the header save action fails", async () => {
		mockUpdateSettings.mockRejectedValue(new Error("Could not persist settings"));
		const screen = await renderSeoSettings();
		await screen
			.getByRole("textbox", { name: "Bing Verification", exact: true })
			.fill("updated-bing-code");

		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);
		await expect.element(screen.getByText("Failed to save settings")).toBeInTheDocument();
		await expect.element(screen.getByText("Could not persist settings")).toBeInTheDocument();

		const dirtyButtons = screen.getByRole("button", { name: "Save", exact: true }).all();
		expect(dirtyButtons).toHaveLength(2);
		for (const button of dirtyButtons) await expect.element(button).toBeEnabled();
	});

	it("selects and removes a default social image", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			seo: { ...defaultSettings.seo, defaultOgImage: undefined },
		});
		const screen = await renderSeoSettings();

		await userEvent.click(screen.getByRole("button", { name: "Select Image" }));
		await expect
			.element(screen.getByRole("dialog", { name: "Select default social image" }))
			.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));
		await expect.element(screen.getByRole("img", { name: "Social card" })).toBeInTheDocument();
		for (const button of screen.getByRole("button", { name: "Save", exact: true }).all()) {
			await expect.element(button).toBeEnabled();
		}
		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[0]);
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					seo: expect.objectContaining({
						defaultOgImage: {
							mediaId: "new-og-image",
							alt: "Social card",
							url: "/media/social-card.png",
						},
					}),
				}),
			);
		});

		await userEvent.click(screen.getByRole("button", { name: "Remove" }));
		await expect.element(screen.getByRole("button", { name: "Select Image" })).toBeInTheDocument();
		for (const button of screen.getByRole("button", { name: "Save", exact: true }).all()) {
			await expect.element(button).toBeEnabled();
		}
	});

	it("keeps an orphaned image reference visible and removable", async () => {
		mockFetchSettings.mockResolvedValue({
			...defaultSettings,
			seo: {
				...defaultSettings.seo,
				defaultOgImage: { mediaId: "missing-og-image", alt: "Missing social card" },
			},
		});
		const screen = await renderSeoSettings();

		await expect
			.element(
				screen.getByText(
					"The referenced image is no longer available. Pick a new one or remove the reference.",
				),
			)
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Change Image" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));
		await expect.element(screen.getByRole("button", { name: "Select Image" })).toBeInTheDocument();
		for (const button of screen.getByRole("button", { name: "Save", exact: true }).all()) {
			await expect.element(button).toBeEnabled();
		}
		await userEvent.click(screen.getByRole("button", { name: "Save", exact: true }).all()[1]);
		await vi.waitFor(() => {
			expect(mockUpdateSettings).toHaveBeenCalledWith(
				expect.objectContaining({
					seo: expect.objectContaining({ defaultOgImage: undefined }),
				}),
			);
		});
	});
});
