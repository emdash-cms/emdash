import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AdminManifest } from "../../src/lib/api";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params, search: _search, ...props }: any) => {
			let href = String(to ?? "");
			if (params && typeof params === "object") {
				for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
					const paramValue =
						typeof value === "string" || typeof value === "number" || typeof value === "boolean"
							? String(value)
							: "";
					href = href.replace(`$${key}`, paramValue);
				}
			}
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
	};
});

const mockFetchDashboardStats = vi.fn<() => Promise<DashboardStats>>();

vi.mock("../../src/lib/api/dashboard", async () => {
	const actual = await vi.importActual("../../src/lib/api/dashboard");
	return {
		...actual,
		fetchDashboardStats: () => mockFetchDashboardStats(),
	};
});

const { Dashboard } = await import("../../src/components/Dashboard");

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "test",
	authMode: "passkey",
	collections: {
		pages: {
			label: "Pages",
			labelSingular: "Page",
			supports: [],
			hasSeo: false,
			fields: {},
		},
	},
	plugins: {},
};

function makeStats(collections: DashboardStats["collections"]): DashboardStats {
	return {
		collections,
		mediaCount: 0,
		userCount: 0,
		recentItems: [],
	};
}

describe("Dashboard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shows scheduled summary when collection stats include pending schedules", async () => {
		mockFetchDashboardStats.mockResolvedValue(
			makeStats([
				{ slug: "pages", label: "Pages", total: 5, published: 2, draft: 3, scheduled: 2 },
			]),
		);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect.element(screen.getByText("Scheduled")).toBeInTheDocument();
	});

	it("omits scheduled summary when only residual non-scheduled statuses exist", async () => {
		mockFetchDashboardStats.mockResolvedValue(
			makeStats([
				{ slug: "pages", label: "Pages", total: 6, published: 2, draft: 3, scheduled: 0 },
			]),
		);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect.element(screen.getByText("Media files")).toBeInTheDocument();
		await expect.element(screen.getByText("Scheduled")).not.toBeInTheDocument();
	});

	it("links collection quick actions to new content forms", async () => {
		mockFetchDashboardStats.mockResolvedValue(makeStats([]));

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByRole("link", { name: "Page" }))
			.toHaveAttribute("href", "/content/pages/new");
	});
});
