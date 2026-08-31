import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { MediaUsedIn } from "../../src/components/MediaUsedIn.js";
import {
	MediaUsageAccessDeniedError,
	fetchManifest,
	fetchMediaUsageDetails,
	type AdminManifest,
	type MediaUsageCoverageStatus,
	type MediaUsageDetailsResponse,
	type MediaUsageEntryDetail,
} from "../../src/lib/api/index.js";
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

vi.mock("../../src/lib/api/index.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/index.js")>(
		"../../src/lib/api/index.js",
	);
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
			fields: {
				featured_image: { kind: "image", label: "Featured image" },
			},
		},
	},
	plugins: {},
	taxonomies: [],
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr"],
	},
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
	return render(<MediaUsedIn mediaId="media-1" open {...props} />);
}

describe("MediaUsedIn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchManifest).mockResolvedValue(manifest);
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([]));
	});

	it("does not request usage while closed", async () => {
		await renderUsedIn({ open: false });

		expect(fetchMediaUsageDetails).not.toHaveBeenCalled();
		expect(fetchManifest).not.toHaveBeenCalled();
	});

	it("keeps the heading visible and marks initial loading as busy", async () => {
		vi.mocked(fetchMediaUsageDetails).mockImplementation(() => new Promise(() => {}));

		const screen = await renderUsedIn();

		await expect.element(screen.getByRole("heading", { name: "Used in" })).toBeVisible();
		await expect.element(screen.getByText("See where this file is used.")).toBeVisible();
		await expect
			.element(screen.getByRole("region", { name: "Used in" }))
			.toHaveAttribute("aria-busy", "true");
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading usage");
	});

	it("shows active references as links and trashed references as static rows", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([
				usageEntry({
					sources: [
						{
							variant: "columns",
							occurrences: [
								{
									fieldSlug: "featured_image",
									fieldPath: "featured_image",
									occurrenceIndex: 0,
									referenceType: "image_field",
								},
							],
						},
					],
				}),
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

		const list = screen.getByRole("list");
		const activeLink = list.getByRole("link", { name: /Launch notes/ });
		await expect.element(activeLink).toHaveAttribute("href", "/content/posts/entry-1?locale=fr");
		await expect.element(activeLink.getByText("Posts", { exact: true })).toBeVisible();
		await expect.element(activeLink.getByText("Featured image", { exact: true })).toBeVisible();
		await expect.element(activeLink.getByText("fr", { exact: true })).toBeVisible();
		await expect.element(activeLink.getByText("Open", { exact: true })).toBeVisible();
		await expect.element(screen.getByText("In trash")).toBeVisible();
		expect(screen.getByText("Archived notes").element().closest("a")).toBeNull();
	});

	it("mirrors the Open icon in right-to-left layouts", async () => {
		const previousDirection = document.documentElement.dir;
		document.documentElement.dir = "rtl";
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));

		try {
			const screen = await renderUsedIn();
			const openLabel = screen.getByText("Open", { exact: true });
			await expect.element(openLabel).toBeVisible();
			const openIcon = openLabel.element().querySelector("svg");

			expect(openIcon).not.toBeNull();
			expect(openIcon).toHaveClass("rtl:-scale-x-100");
		} finally {
			document.documentElement.dir = previousDirection;
		}
	});

	it.each<[MediaUsageCoverageStatus, string]>([
		["never", "Usage indexing hasn’t started."],
		["running", "Usage is updating. Some content may not appear here yet."],
		["partial", "Some content may not appear here yet."],
		["failed", "Usage indexing couldn’t finish."],
		["stale", "Usage may be out of date."],
		["unknown", "Usage completeness couldn’t be verified."],
	])("keeps known references visible when coverage is %s", async (status, message) => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([usageEntry()], {
				coverage: { scope: "all_content_collections", status },
			}),
		);

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: message })).toBeVisible();
	});

	it("explains incomplete coverage from an accessible icon tooltip", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([usageEntry()], {
				coverage: { scope: "all_content_collections", status: "partial" },
			}),
		);
		const screen = await renderUsedIn();
		const warning = screen.getByRole("button", {
			name: "Some content may not appear here yet.",
		});

		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		await expect
			.element(screen.getByText("Usage may be incomplete"), { timeout: 100 })
			.not.toBeInTheDocument();
		await userEvent.hover(warning.element());
		await expect
			.element(screen.getByText("Some content may not appear here yet.").all().at(-1)!)
			.toBeVisible();
	});

	it("distinguishes trustworthy and incomplete empty results", async () => {
		const completeScreen = await renderUsedIn();
		await expect.element(completeScreen.getByText("No usage", { exact: true })).toBeVisible();
		await expect
			.element(completeScreen.getByText("This file isn’t used in any content."))
			.toBeVisible();
		await expect
			.element(completeScreen.getByRole("region", { name: "Used in" }).getByRole("button"), {
				timeout: 100,
			})
			.not.toBeInTheDocument();

		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([], {
				coverage: { scope: "all_content_collections", status: "partial" },
			}),
		);
		const incompleteScreen = await renderUsedIn({ mediaId: "media-2" });

		await expect
			.element(incompleteScreen.getByText("No usage to show yet", { exact: true }))
			.toBeVisible();
		await expect
			.element(incompleteScreen.getByText("Some content may not appear here yet.").last())
			.toBeVisible();
		await expect
			.element(
				incompleteScreen.getByRole("button", {
					name: "Some content may not appear here yet.",
				}),
			)
			.toBeVisible();
	});

	it("renders access denial without retrying or exposing the error", async () => {
		vi.mocked(fetchMediaUsageDetails).mockRejectedValue(new MediaUsageAccessDeniedError());

		const screen = await renderUsedIn();

		await expect
			.element(screen.getByText("Usage details aren’t available for your account."))
			.toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Try again" }), { timeout: 100 })
			.not.toBeInTheDocument();
		expect(fetchMediaUsageDetails).toHaveBeenCalledTimes(1);
	});

	it("hides cached references when a reopen loses access", async () => {
		vi.mocked(fetchMediaUsageDetails)
			.mockResolvedValueOnce(usageResponse([usageEntry()]))
			.mockRejectedValueOnce(new MediaUsageAccessDeniedError());
		const screen = await renderUsedIn();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();

		await screen.rerender(<MediaUsedIn mediaId="media-1" open={false} />);
		await screen.rerender(<MediaUsedIn mediaId="media-1" open />);

		await expect
			.element(screen.getByText("Usage details aren’t available for your account."))
			.toBeVisible();
		await expect
			.element(screen.getByText("Launch notes"), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("keeps cached references visibly qualified after a refresh error", async () => {
		vi.mocked(fetchMediaUsageDetails)
			.mockResolvedValueOnce(usageResponse([usageEntry()]))
			.mockRejectedValueOnce(new Error("network error"));
		const screen = await renderUsedIn();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();

		await screen.rerender(<MediaUsedIn mediaId="media-1" open={false} />);
		await screen.rerender(<MediaUsedIn mediaId="media-1" open />);

		await expect.element(screen.getByText("Couldn’t load usage.")).toBeVisible();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
	});

	it("shows an actionable initial error and retries only after a click", async () => {
		vi.mocked(fetchMediaUsageDetails)
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce(usageResponse([usageEntry()]));

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Couldn’t load usage.")).toBeVisible();
		expect(fetchMediaUsageDetails).toHaveBeenCalledTimes(1);
		await screen.getByRole("button", { name: "Try again" }).click();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		expect(fetchMediaUsageDetails).toHaveBeenCalledTimes(2);
	});

	it("retains earlier groups and retries a failed next page", async () => {
		vi.mocked(fetchMediaUsageDetails)
			.mockResolvedValueOnce(usageResponse([usageEntry()], { nextCursor: "next-page" }))
			.mockRejectedValueOnce(new Error("network error"))
			.mockResolvedValueOnce(
				usageResponse([
					usageEntry({ contentId: "entry-2", title: "Second entry", slug: "second-entry" }),
				]),
			);

		const screen = await renderUsedIn();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		await screen.getByRole("button", { name: "Load more" }).click();

		await expect.element(screen.getByText("Couldn’t load more usage.")).toBeVisible();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		await screen.getByRole("button", { name: "Try again" }).click();
		await expect.element(screen.getByText("Second entry")).toBeVisible();
		await expect.element(screen.getByText("Launch notes")).toBeVisible();
		expect(fetchMediaUsageDetails).toHaveBeenLastCalledWith(
			"media-1",
			expect.objectContaining({
				cursor: "next-page",
				limit: 50,
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("retains the most conservative coverage across pages", async () => {
		vi.mocked(fetchMediaUsageDetails)
			.mockResolvedValueOnce(
				usageResponse([usageEntry()], {
					nextCursor: "next-page",
					coverage: { scope: "all_content_collections", status: "stale" },
				}),
			)
			.mockResolvedValueOnce(
				usageResponse([usageEntry({ contentId: "entry-2", title: "Second entry" })]),
			);

		const screen = await renderUsedIn();
		await screen.getByRole("button", { name: "Load more" }).click();

		await expect.element(screen.getByText("Second entry")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Usage may be out of date." }))
			.toBeVisible();
	});

	it("sets explicit direction for authored labels and technical identifiers", async () => {
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Launch notes")).toHaveAttribute("dir", "auto");
		await expect.element(screen.getByText("Posts")).toHaveAttribute("dir", "auto");
		await expect.element(screen.getByText("launch-notes")).toHaveAttribute("dir", "ltr");
		await expect.element(screen.getByText("fr", { exact: true })).toHaveAttribute("dir", "ltr");
	});

	it("uses safe metadata fallbacks when the manifest is unavailable", async () => {
		vi.mocked(fetchManifest).mockRejectedValue(new Error("manifest unavailable"));
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(
			usageResponse([
				usageEntry({
					collection: "unknown_collection",
					contentId: "01UNTITLED",
					title: "",
					slug: "",
					locale: null,
				}),
			]),
		);

		const screen = await renderUsedIn();

		await expect.element(screen.getByText("Untitled", { exact: true })).toBeVisible();
		await expect
			.element(screen.getByText("unknown_collection", { exact: true }))
			.toHaveAttribute("dir", "ltr");
		await expect
			.element(screen.getByText("01UNTITLED", { exact: true }))
			.toHaveAttribute("dir", "ltr");
	});

	it("blocks every link activation while navigation is unavailable", async () => {
		const onEntryClick = vi.fn();
		vi.mocked(fetchMediaUsageDetails).mockResolvedValue(usageResponse([usageEntry()]));
		const screen = await renderUsedIn({ navigationBlocked: true, onEntryClick });
		const link = screen.getByRole("link", { name: /Launch notes/ });

		await expect.element(link).toHaveAttribute("aria-disabled", "true");
		const click = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
		const auxiliary = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
		expect(link.element().dispatchEvent(click)).toBe(false);
		expect(link.element().dispatchEvent(auxiliary)).toBe(false);
		expect(onEntryClick).not.toHaveBeenCalled();
	});
});
