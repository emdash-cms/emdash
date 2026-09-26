import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Redirect } from "../../src/lib/api/redirects.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/redirects.js", () => ({
	createRedirect: vi.fn(),
	deleteRedirect: vi.fn(),
	fetch404Summary: vi.fn().mockResolvedValue([]),
	fetchRedirects: vi.fn(),
	updateRedirect: vi.fn(),
}));

import { Redirects } from "../../src/components/Redirects.js";
import { fetchRedirects, updateRedirect } from "../../src/lib/api/redirects.js";

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

describe("Redirects", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
