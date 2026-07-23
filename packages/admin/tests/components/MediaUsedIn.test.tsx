import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaUsedIn } from "../../src/components/MediaUsedIn";
import {
	fetchManifest,
	fetchMediaUsageDetails,
	type AdminManifest,
	type MediaUsageDetailsResponse,
	type MediaUsageEntryDetail,
	type MediaUsageSummary,
} from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: React.forwardRef<
			HTMLAnchorElement,
			React.AnchorHTMLAttributes<HTMLAnchorElement> & {
				to: string;
				params: { collection: string; id: string };
				search: { locale?: string };
			}
		>(({ to: _to, params, search, ...props }, ref) => {
			const query = search.locale ? `?locale=${encodeURIComponent(search.locale)}` : "";
			return <a ref={ref} href={`/content/${params.collection}/${params.id}${query}`} {...props} />;
		}),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return {
		...actual,
		fetchManifest: vi.fn(),
		fetchMediaUsageDetails: vi.fn(),
	};
});

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "manifest-hash",
	authMode: "passkey",
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts"],
			hasSeo: false,
			fields: {},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr"],
	},
};

const completeSummary: MediaUsageSummary = {
	count: 2,
	coverage: { scope: "all_content_collections", status: "complete" },
};

function usageEntry(overrides: Partial<MediaUsageEntryDetail> = {}): MediaUsageEntryDetail {
	return {
		collection: "posts",
		contentId: "entry-1",
		title: "Launch notes",
		slug: "launch-notes",
		locale: "fr",
		status: "published",
		scheduledAt: null,
		deletedAt: null,
		sources: [],
		...overrides,
	};
}

function usageResponse(
	items: MediaUsageEntryDetail[],
	overrides: Partial<MediaUsageDetailsResponse> = {},
): MediaUsageDetailsResponse {
	return {
		items,
		coverage: { scope: "all_content_collections", status: "complete" },
		...overrides,
	};
}

async function renderUsedIn(props: Partial<React.ComponentProps<typeof MediaUsedIn>> = {}) {
	return render(<MediaUsedIn mediaId="media-1" open summary={completeSummary} {...props} />);
}

describe("MediaUsedIn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchManifest).mockResolvedValue(manifest);
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([]));
	});

	it("renders loading skeletons while usage is loading", async () => {
		vi.mocked(fetchMediaUsageDetails).mockImplementation(() => new Promise(() => {}));

		const screen = await renderUsedIn();

		await expect.element(screen.getByRole("status", { name: "Loading usage" })).toBeVisible();
	});

	it("shows active references as localized content links and trashed references as static rows", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([
				usageEntry(),
				usageEntry({
					contentId: "entry-2",
					title: "Archived notes",
					slug: "archived-notes",
					locale: "en",
					deletedAt: "2026-01-01T00:00:00.000Z",
				}),
			]),
		);

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("2")).toBeVisible();
		await expect.element(screen.getByText("Used in")).toBeVisible();
		const activeLink = screen.getByRole("link", { name: /Launch notes/ });
		await expect.element(activeLink).toHaveAttribute("href", "/content/posts/entry-1?locale=fr");
		await expect.element(activeLink.getByText("Posts", { exact: true })).toBeVisible();
		await expect.element(activeLink.getByText("launch-notes", { exact: true })).toBeVisible();
		await expect.element(activeLink.getByText("fr", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("In trash")).toBeVisible();
		expect(screen.getByText("Archived notes").element().closest("a")).toBeNull();
	});

	it("uses restrained typography for collection and technical metadata", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));

		const screen = await renderUsedIn();
		const collection = screen.getByText("Posts", { exact: true });
		const identifier = screen.getByText("launch-notes", { exact: true });
		const locale = screen.getByText("fr", { exact: true });
		await expect.element(identifier).toBeVisible();

		expect(collection.element()).toHaveAttribute("dir", "auto");
		expect(identifier.element()).toHaveAttribute("dir", "ltr");
		expect(identifier.element().classList.contains("font-mono")).toBe(true);
		expect(identifier.element().classList.contains("text-[0.9em]")).toBe(true);
		expect(locale.element()).toHaveAttribute("dir", "ltr");

		const metadata = identifier.element().parentElement;
		expect(screen.getByText("Launch notes").element().classList.contains("text-base")).toBe(true);
		expect(metadata?.classList.contains("text-base")).toBe(true);
		expect(metadata?.textContent).toBe("Posts·launch-notes·fr");
		const separators = metadata?.querySelectorAll('[aria-hidden="true"]');
		expect(separators).toHaveLength(2);
		expect([...separators!].every((separator) => separator.textContent === "·")).toBe(true);
	});

	it("keeps the reference row surface aligned to the form column", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));

		const screen = await renderUsedIn();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		const activeLink = screen.getByRole("link", { name: /Launch notes/ });
		await expect.element(activeLink).toBeVisible();
		const activeLinkElement = activeLink.element();

		expect(activeLinkElement.classList.contains("w-full")).toBe(true);
		expect(activeLinkElement.classList.contains("-mx-2")).toBe(false);
		expect(activeLinkElement.classList.contains("border")).toBe(true);
		expect(activeLinkElement.classList.contains("border-kumo-line")).toBe(true);
		expect(activeLinkElement.classList.contains("bg-kumo-control")).toBe(true);
		expect(activeLinkElement.classList.contains("items-center")).toBe(true);

		const iconTile = activeLinkElement.querySelector("svg")?.parentElement;
		expect(iconTile).not.toBeNull();
		expect(iconTile?.classList.contains("h-10")).toBe(true);
		expect(iconTile?.classList.contains("w-10")).toBe(true);
	});

	it("uses a clear spacing hierarchy for the heading, rows, and metadata", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));

		const screen = await renderUsedIn();
		const activeLink = screen.getByRole("link", { name: /Launch notes/ });
		await expect.element(activeLink).toBeVisible();

		const section = screen.getByTestId("media-used-in").element();
		const list = screen.getByRole("list").element();
		const activeLinkElement = activeLink.element();
		const textGroup = screen.getByText("Launch notes").element().parentElement?.parentElement;

		expect(section.classList.contains("space-y-3")).toBe(true);
		expect(list.classList.contains("space-y-2")).toBe(true);
		expect(activeLinkElement.classList.contains("px-3")).toBe(true);
		expect(activeLinkElement.classList.contains("py-2.5")).toBe(true);
		expect(textGroup?.classList.contains("space-y-1")).toBe(true);
	});

	it("uses concise fallbacks when entry metadata is missing", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([
				usageEntry({
					collection: "unknown_collection",
					contentId: "01UNTITLED",
					title: null,
					slug: null,
					locale: null,
				}),
			]),
		);

		const screen = await renderUsedIn({ summary: { ...completeSummary, count: 1 } });

		await expect.element(screen.getByText("Untitled", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("unknown_collection", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("01UNTITLED", { exact: true })).toBeVisible();
	});

	it("shows a trustworthy empty state for complete coverage", async () => {
		const screen = await renderUsedIn({ summary: { ...completeSummary, count: 0 } });

		await expect.element(screen.getByText("0", { exact: true })).toBeVisible();
		await expect
			.element(screen.getByText("No usage found in EmDash-managed content fields."))
			.toBeVisible();
	});

	it("does not show an active zero above a trash-only reference", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([
				usageEntry({
					deletedAt: "2026-01-01T00:00:00.000Z",
				}),
			]),
		);

		const screen = await renderUsedIn({ summary: { ...completeSummary, count: 0 } });

		await expect.element(screen.getByText("In trash")).toBeVisible();
		await expect
			.element(screen.getByText("0", { exact: true }), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("does not show zero when empty usage coverage is incomplete", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([], {
				coverage: { scope: "all_content_collections", status: "partial" },
			}),
		);

		const screen = await renderUsedIn({
			summary: {
				count: 0,
				coverage: { scope: "all_content_collections", status: "partial" },
			},
		});

		await expect.element(screen.getByText("Usage may be incomplete")).toBeVisible();
		await expect
			.element(screen.getByText("0", { exact: true }), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("renders nothing and makes no request when the summary is absent", async () => {
		const screen = await renderUsedIn({ summary: undefined });

		await expect
			.element(screen.getByTestId("media-used-in"), { timeout: 100 })
			.not.toBeInTheDocument();
		expect(fetchMediaUsageDetails).not.toHaveBeenCalled();
	});

	it("does not request details while the panel is closed", async () => {
		await renderUsedIn({ open: false });

		expect(fetchMediaUsageDetails).not.toHaveBeenCalled();
	});

	it("does not request redacted usage details", async () => {
		const screen = await renderUsedIn({
			summary: { ...completeSummary, count: null },
		});

		await expect
			.element(screen.getByText("Usage details aren’t available for your account."))
			.toBeVisible();
		expect(fetchMediaUsageDetails).not.toHaveBeenCalled();
	});

	it("labels indexed counts and warns when coverage is incomplete", async () => {
		const staleSummary: MediaUsageSummary = {
			count: 4,
			coverage: { scope: "all_content_collections", status: "stale" },
		};
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([usageEntry()], {
				coverage: { scope: "all_content_collections", status: "stale" },
			}),
		);

		const screen = await renderUsedIn({ summary: staleSummary });

		await expect.element(screen.getByText("4")).toBeVisible();
		await expect.element(screen.getByText("Usage may be incomplete")).toBeVisible();
		await expect
			.element(screen.getByText("Some content references may not be indexed yet."))
			.toBeVisible();
	});

	it("shows an inline error and retries the initial request", async () => {
		vi.mocked(fetchMediaUsageDetails)
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce(usageResponse([usageEntry()]));

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Couldn’t load usage.")).toBeVisible();
		await screen.getByRole("button", { name: "Try again" }).click();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		expect(fetchMediaUsageDetails).toHaveBeenCalledTimes(2);
	});

	it("loads the next cursor page without replacing existing references", async () => {
		vi.mocked(fetchMediaUsageDetails).mockImplementation(async (_id, options) => {
			if (options?.cursor === "next-page") {
				return usageResponse([
					usageEntry({ contentId: "entry-2", title: "Second entry", slug: "second-entry" }),
				]);
			}
			return usageResponse([usageEntry()], { nextCursor: "next-page" });
		});

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		await screen.getByRole("button", { name: "Load more" }).click();
		await expect.element(screen.getByText("Second entry")).toBeVisible();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		expect(fetchMediaUsageDetails).toHaveBeenLastCalledWith("media-1", {
			cursor: "next-page",
			limit: 50,
		});
	});

	it("retains an earlier incomplete coverage warning after loading a complete page", async () => {
		vi.mocked(fetchMediaUsageDetails).mockImplementation(async (_id, options) => {
			if (options?.cursor === "next-page") {
				return usageResponse([usageEntry({ contentId: "entry-2", title: "Second entry" })], {
					coverage: { scope: "all_content_collections", status: "complete" },
				});
			}
			return usageResponse([usageEntry()], {
				nextCursor: "next-page",
				coverage: { scope: "all_content_collections", status: "partial" },
			});
		});

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Usage may be incomplete")).toBeVisible();
		await screen.getByRole("button", { name: "Load more" }).click();
		await expect.element(screen.getByText("Second entry")).toBeVisible();
		await expect.element(screen.getByText("Usage may be incomplete")).toBeVisible();
	});

	it("blocks entry activation and exposes disabled state while navigation is unavailable", async () => {
		const onEntryClick = vi.fn();
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));
		const screen = await renderUsedIn({ navigationBlocked: true, onEntryClick });

		const link = screen.getByRole("link", { name: /Launch notes/ });
		await expect.element(link).toHaveAttribute("aria-disabled", "true");
		link.element().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(onEntryClick).not.toHaveBeenCalled();
	});

	it("sets directionality for authored labels and technical identifiers", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));
		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Launch notes")).toHaveAttribute("dir", "auto");
		await expect.element(screen.getByText("launch-notes")).toHaveAttribute("dir", "ltr");
		await expect.element(screen.getByText("fr", { exact: true })).toHaveAttribute("dir", "ltr");
	});
});
