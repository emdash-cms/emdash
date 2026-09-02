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
		schedulerHealth: { status: "healthy", lastCompletedAt: new Date().toISOString() },
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

	it("warns when scheduled content is overdue and the scheduler has never completed", async () => {
		const stats = makeStats([
			{
				slug: "pages",
				label: "Pages",
				total: 1,
				published: 0,
				draft: 1,
				scheduled: 1,
				overdueScheduled: 1,
			},
		]);
		stats.schedulerHealth = { status: "unknown", lastCompletedAt: null };
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByText("Scheduled publishing needs attention"))
			.toBeInTheDocument();
		await expect.element(screen.getByText(/no scheduler run has completed/i)).toBeInTheDocument();
		await expect.element(screen.getByText(/npx emdash doctor/i)).toBeInTheDocument();
	});

	it("warns when scheduled content is overdue and the heartbeat is stale", async () => {
		const stats = makeStats([
			{
				slug: "pages",
				label: "Pages",
				total: 1,
				published: 0,
				draft: 1,
				scheduled: 1,
				overdueScheduled: 1,
			},
		]);
		stats.schedulerHealth = {
			status: "stale",
			lastCompletedAt: "2026-08-16T11:50:00.000Z",
		};
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByText("Scheduled publishing needs attention"))
			.toBeInTheDocument();
		await expect.element(screen.getByText(/scheduler heartbeat is stale/i)).toBeInTheDocument();
	});

	it("does not warn when the scheduler heartbeat is healthy", async () => {
		mockFetchDashboardStats.mockResolvedValue(
			makeStats([
				{
					slug: "pages",
					label: "Pages",
					total: 1,
					published: 0,
					draft: 1,
					scheduled: 1,
					overdueScheduled: 1,
				},
			]),
		);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByText("Scheduled publishing needs attention"))
			.not.toBeInTheDocument();
	});

	it("renders dashboard data from an older API without scheduler health", async () => {
		const stats = makeStats([
			{
				slug: "pages",
				label: "Pages",
				total: 1,
				published: 0,
				draft: 1,
				scheduled: 0,
			},
		]);
		stats.schedulerHealth = undefined;
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect.element(screen.getByText("Content")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Scheduled publishing needs attention"))
			.not.toBeInTheDocument();
	});

	it("labels the published count for screen readers with the state, not the action", async () => {
		mockFetchDashboardStats.mockResolvedValue(
			makeStats([
				{ slug: "pages", label: "Pages", total: 5, published: 2, draft: 3, scheduled: 0 },
			]),
		);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect.element(screen.getByText("Published", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Publish", { exact: true })).not.toBeInTheDocument();
	});

	it("links collection quick actions to new content forms", async () => {
		mockFetchDashboardStats.mockResolvedValue(makeStats([]));

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByRole("link", { name: "Page" }))
			.toHaveAttribute("href", "/content/pages/new");
	});

	it("uses the same heading level for every dashboard card title", async () => {
		mockFetchDashboardStats.mockResolvedValue(makeStats([]));

		const screen = await render(<Dashboard manifest={manifest} />);

		for (const name of ["Drafts", "Media files", "Users", "Content", "Recent Activity"]) {
			await expect.element(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
		}
	});

	it("gives recent activity status icons normalized accessible labels", async () => {
		const stats = makeStats([]);
		stats.recentItems = [
			{
				id: "page-1",
				collection: "pages",
				collectionLabel: "Pages",
				title: "Updated page",
				slug: "updated-page",
				status: "pending",
				updatedAt: new Date().toISOString(),
				authorId: null,
			},
		];
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		const statusIcon = screen.getByRole("img", { name: "Pending changes" });
		await expect.element(statusIcon).toBeInTheDocument();
		expect(screen.container.textContent).not.toContain("Modified");
	});

	it("renders unknown status names without treating object properties as lifecycle states", async () => {
		const stats = makeStats([]);
		stats.recentItems = [
			{
				id: "page-1",
				collection: "pages",
				collectionLabel: "Pages",
				title: "Unexpected status",
				slug: "unexpected-status",
				status: "toString",
				updatedAt: new Date().toISOString(),
				authorId: null,
			},
		];
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect.element(screen.getByRole("img", { name: "Status: toString" })).toBeInTheDocument();
	});
});
