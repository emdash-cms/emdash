import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import type { NotFoundSummary, Redirect } from "../../src/lib/api/redirects.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/redirects.js", () => ({
	createRedirect: vi.fn(),
	deleteRedirect: vi.fn(),
	fetch404Summary: vi.fn(),
	fetchRedirects: vi.fn(),
	updateRedirect: vi.fn(),
}));

import { Redirects } from "../../src/components/Redirects.js";
import {
	createRedirect,
	deleteRedirect,
	fetch404Summary,
	fetchRedirects,
	updateRedirect,
} from "../../src/lib/api/redirects.js";

function makeRedirect(index: number): Redirect {
	return {
		id: `redirect-${index}`,
		source: `/source-${index}`,
		destination: `/destination-${index}`,
		type: 301,
		isPattern: false,
		enabled: true,
		hits: 0,
		lastHitAt: null,
		groupName: null,
		auto: false,
		createdAt: "2026-08-10T00:00:00.000Z",
		updatedAt: "2026-08-10T00:00:00.000Z",
	};
}

const missingPage: NotFoundSummary = {
	path: "/missing-page",
	count: 2,
	lastSeen: "2026-10-29T10:00:00.000Z",
	topReferrer: null,
};

async function renderNotFoundTab() {
	vi.mocked(fetch404Summary).mockResolvedValue([missingPage]);
	const screen = await render(<Redirects />);
	await screen.getByRole("tab", { name: "404 Errors" }).click();
	return screen;
}

describe("Redirects", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetch404Summary).mockResolvedValue([]);
		vi.mocked(updateRedirect).mockResolvedValue(makeRedirect(1));
		vi.mocked(fetchRedirects).mockImplementation(async ({ cursor } = {}) => {
			if (cursor === "page-2") {
				return { items: [makeRedirect(101)] };
			}

			return {
				items: Array.from({ length: 100 }, (_, index) => makeRedirect(index + 1)),
				nextCursor: "page-2",
			};
		});
	});

	it("loads redirects beyond the first page", async () => {
		const screen = await render(<Redirects />);

		await expect.element(screen.getByText("/source-100")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Load more" }).click();

		await expect.element(screen.getByText("/source-101")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Load more" }).query()).toBeNull();
		expect(fetchRedirects).toHaveBeenLastCalledWith(
			expect.objectContaining({ cursor: "page-2", limit: 100 }),
		);
	});

	it("restarts pagination after a redirect mutation", async () => {
		const screen = await render(<Redirects />);

		await expect.element(screen.getByText("/source-100")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Load more" }).click();
		await expect.element(screen.getByText("/source-101")).toBeInTheDocument();

		await screen.getByRole("switch", { name: "Disable redirect" }).first().click();

		await expect.element(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
		expect(screen.getByText("/source-101").query()).toBeNull();
	});

	it("edits a redirect from its source", async () => {
		const screen = await render(<Redirects />);
		const source = screen.getByRole("button", { name: "Edit redirect /source-2", exact: true });

		await expect.element(source).toHaveTextContent("/source-2");
		await source.click();

		const dialog = screen.getByRole("dialog", { name: "Edit Redirect" });
		await expect
			.element(dialog.getByRole("textbox", { name: "Source path" }))
			.toHaveValue("/source-2");
		await dialog.getByRole("textbox", { name: "Destination path" }).fill("/moved");
		// Direct DOM clicks bypass Base UI's inert overlay, which covers the unstyled dialog.
		dialog.getByRole("button", { name: "Save" }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		expect(updateRedirect).toHaveBeenCalledWith(
			"redirect-2",
			expect.objectContaining({ source: "/source-2", destination: "/moved" }),
		);
	});

	it("deletes a redirect from its menu after confirming", async () => {
		vi.mocked(deleteRedirect).mockResolvedValue(undefined);
		const screen = await render(<Redirects />);

		await screen
			.getByRole("button", { name: "Actions for redirect /source-2", exact: true })
			.click();
		await screen.getByRole("menuitem", { name: "Delete redirect /source-2", exact: true }).click();

		const dialog = screen.getByRole("dialog", { name: "Delete Redirect?" });
		await expect.element(dialog).toBeVisible();
		expect(deleteRedirect).not.toHaveBeenCalled();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		expect(deleteRedirect).toHaveBeenCalledExactlyOnceWith("redirect-2");
	});

	it("shows a redirect's loop warning, automatic badge, and disabled state on its own row", async () => {
		vi.mocked(fetchRedirects).mockResolvedValue({
			items: [
				makeRedirect(1),
				{ ...makeRedirect(2), auto: true },
				{ ...makeRedirect(3), enabled: false },
			],
			loopRedirectIds: ["redirect-1"],
		});
		const screen = await render(<Redirects />);
		const row = (source: string) =>
			screen.getByRole("row").filter({
				has: page.getByRole("button", { name: `Edit redirect ${source}`, exact: true }),
			});

		await expect
			.element(row("/source-1").getByRole("img", { name: "Part of a redirect loop" }))
			.toBeVisible();
		await expect.element(row("/source-2").getByText("auto", { exact: true })).toBeVisible();
		await expect
			.element(row("/source-3").getByRole("switch", { name: "Enable redirect" }))
			.not.toBeChecked();
		await expect
			.element(row("/source-1").getByRole("switch", { name: "Disable redirect" }))
			.toBeChecked();
		expect(screen.getByRole("img", { name: "Part of a redirect loop" }).elements()).toHaveLength(1);
		expect(screen.getByText("auto", { exact: true }).elements()).toHaveLength(1);
	});

	it("opens a new redirect for a 404 path", async () => {
		const screen = await renderNotFoundTab();
		await screen
			.getByRole("button", { name: "Create redirect for /missing-page", exact: true })
			.click();

		const dialog = screen.getByRole("dialog", { name: "New Redirect" });
		await expect
			.element(dialog.getByRole("textbox", { name: "Source path" }))
			.toHaveValue("/missing-page");
	});

	it("describes what marking a 404 path as gone does", async () => {
		const screen = await renderNotFoundTab();

		await expect
			.element(
				screen.getByRole("button", { name: "Mark /missing-page as Gone (410)", exact: true }),
			)
			.toHaveAccessibleDescription(
				"Mark as Gone (410) — tells search engines it was permanently deleted",
			);
	});

	it("marks a 404 path as gone with a 410 rule and no destination", async () => {
		vi.mocked(createRedirect).mockResolvedValue({
			...makeRedirect(1),
			source: missingPage.path,
			destination: "",
			type: 410,
		});
		const screen = await renderNotFoundTab();
		await screen
			.getByRole("button", { name: "Mark /missing-page as Gone (410)", exact: true })
			.click();

		await vi.waitFor(() =>
			expect(createRedirect).toHaveBeenCalledExactlyOnceWith({
				source: "/missing-page",
				destination: "",
				type: 410,
				enabled: true,
			}),
		);
	});

	it("uses accessible tabs to switch between redirects and 404 errors", async () => {
		const screen = await render(<Redirects />);

		const redirectsTab = screen.getByRole("tab", { name: /^Redirects/ });
		const notFoundTab = screen.getByRole("tab", { name: "404 Errors" });
		const search = screen.getByRole("searchbox", { name: "Search source or destination..." });
		const redirectsIcon = redirectsTab.element().querySelector("svg")!;
		const notFoundIcon = notFoundTab.element().querySelector("svg")!;
		const redirectsPath = redirectsIcon.querySelector("path")!.getAttribute("d");
		const notFoundPath = notFoundIcon.querySelector("path")!.getAttribute("d");

		await expect.element(redirectsTab).toHaveAttribute("aria-selected", "true");
		expect(redirectsIcon).toHaveAttribute("aria-hidden", "true");
		expect(notFoundIcon).toHaveAttribute("aria-hidden", "true");
		await expect.element(search).toBeInTheDocument();
		await notFoundTab.click();

		await expect.element(notFoundTab).toHaveAttribute("aria-selected", "true");
		expect(redirectsTab.element().querySelector("svg path")!.getAttribute("d")).not.toBe(
			redirectsPath,
		);
		expect(notFoundTab.element().querySelector("svg path")!.getAttribute("d")).not.toBe(
			notFoundPath,
		);
		await expect.element(screen.getByText("No 404 errors recorded yet.")).toBeInTheDocument();
		expect(search.query()).toBeNull();
	});
});
