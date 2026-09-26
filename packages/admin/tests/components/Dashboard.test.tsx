import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AdminManifest } from "../../src/lib/api";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import type { TransferCapabilities } from "../../src/lib/api/transfer.js";
import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params, search, ...props }: any) => {
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
			const query = new URLSearchParams(
				Object.entries((search ?? {}) as Record<string, unknown>).flatMap(([key, value]) =>
					typeof value === "string" ? [[key, value]] : [],
				),
			).toString();
			if (query) href += `?${query}`;
			return (
				<a href={href} {...props}>
					{children}
				</a>
			);
		},
	};
});

const mockFetchDashboardStats = vi.fn<() => Promise<DashboardStats>>();
const mockDismissScheduledPolicyRejection =
	vi.fn<(collection: string, id: string, revision: string) => Promise<void>>();
const mockUseCurrentUser = vi.fn();

vi.mock("../../src/lib/api/dashboard", async () => {
	const actual = await vi.importActual("../../src/lib/api/dashboard");
	return {
		...actual,
		fetchDashboardStats: () => mockFetchDashboardStats(),
		dismissScheduledPolicyRejection: (collection: string, id: string, revision: string) =>
			mockDismissScheduledPolicyRejection(collection, id, revision),
	};
});

const mockFetchTransferCapabilities = vi.fn<() => Promise<TransferCapabilities>>();

vi.mock("../../src/lib/api/transfer.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/transfer.js");
	return { ...actual, fetchTransferCapabilities: () => mockFetchTransferCapabilities() };
});

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => mockUseCurrentUser(),
}));

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

function policyStats(reason = "Approval is required.", revision = "rejection-revision") {
	const stats = makeStats([]);
	stats.policyRejectedScheduled = 1;
	stats.policyRejections = [
		{
			collection: "posts",
			id: "post-1",
			pluginId: "content-guard",
			reason,
			rejectedAt: "2030-01-01T00:00:00.000Z",
			_rev: revision,
		},
	];
	return stats;
}

function transferCapabilities(empty: boolean): TransferCapabilities {
	return {
		formatVersions: ["1"],
		features: [],
		optionalFeatures: [],
		limits: {
			manifestBytes: 1,
			recordLineBytes: 1,
			chunkBytes: 1,
			chunkRecords: 1,
			totalRecords: 1,
			totalFiles: 1,
			indexChunks: 1,
			jsonDepth: 1,
			maxBlobBytes: 1,
		},
		portableDomain: { empty, blockers: [], seededScaffold: [] },
	};
}

describe("Dashboard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockUseCurrentUser.mockReturnValue({ data: { role: 50 } });
		mockDismissScheduledPolicyRejection.mockResolvedValue();
		mockFetchTransferCapabilities.mockResolvedValue(transferCapabilities(false));
		window.localStorage.clear();
	});

	it("shows marketplace migration guidance to admins", async () => {
		mockFetchDashboardStats.mockResolvedValue(makeStats([]));

		const screen = await render(<Dashboard manifest={{ ...manifest, marketplace: true }} />);

		await expect
			.element(screen.getByText("Marketplace configuration is deprecated"))
			.toBeInTheDocument();
	});

	it("hides marketplace migration guidance from non-admins", async () => {
		mockUseCurrentUser.mockReturnValue({ data: { role: 40 } });
		mockFetchDashboardStats.mockResolvedValue(makeStats([]));

		const screen = await render(<Dashboard manifest={{ ...manifest, marketplace: true }} />);

		await expect
			.element(screen.getByText("Marketplace configuration is deprecated"))
			.not.toBeInTheDocument();
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

	it("warns when a publication policy blocks scheduled content", async () => {
		const stats = policyStats();
		stats.policyRejectedScheduled = 2;
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByText("Publication policy blocked scheduled content"))
			.toBeInTheDocument();
		await expect.element(screen.getByText("Approval is required.")).toBeInTheDocument();
		await expect.element(screen.getByText("posts/post-1")).toBeInTheDocument();
		await expect
			.element(screen.getByText("One more blocked entry is not shown."))
			.toBeInTheDocument();
		await screen.getByRole("button", { name: "Dismiss" }).click();
		expect(mockDismissScheduledPolicyRejection).toHaveBeenCalledWith(
			"posts",
			"post-1",
			"rejection-revision",
		);
	});

	it("refreshes a stale policy rejection after dismissal conflicts", async () => {
		const staleStats = policyStats("Stale reason.", "stale-revision");
		const currentStats = policyStats("Current reason.", "current-revision");
		mockFetchDashboardStats.mockResolvedValueOnce(staleStats).mockResolvedValueOnce(currentStats);
		mockDismissScheduledPolicyRejection.mockRejectedValueOnce(
			new Error("The rejection changed before it could be dismissed"),
		);

		const screen = await render(<Dashboard manifest={manifest} />);
		await screen.getByRole("button", { name: "Dismiss" }).click();

		await expect.element(screen.getByText("Current reason.")).toBeInTheDocument();
		await expect
			.element(screen.getByText("The rejection changed before it could be dismissed"))
			.toBeInTheDocument();
		expect(mockFetchDashboardStats).toHaveBeenCalledTimes(2);
	});

	it("does not offer dismissal to authors", async () => {
		mockUseCurrentUser.mockReturnValue({ data: { role: 30 } });
		const stats = policyStats();
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect.element(screen.getByText("Approval is required.")).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
	});

	it("shows policy rejections and scheduler outages independently", async () => {
		const stats = makeStats([
			{
				slug: "posts",
				label: "Posts",
				total: 1,
				published: 0,
				draft: 1,
				scheduled: 1,
				overdueScheduled: 1,
			},
		]);
		stats.policyRejectedScheduled = 1;
		stats.policyRejections = [];
		stats.schedulerHealth = { status: "stale", lastCompletedAt: null };
		mockFetchDashboardStats.mockResolvedValue(stats);

		const screen = await render(<Dashboard manifest={manifest} />);

		await expect
			.element(screen.getByText("Publication policy blocked scheduled content"))
			.toBeInTheDocument();
		await expect
			.element(screen.getByText("Scheduled publishing needs attention"))
			.toBeInTheDocument();
		await expect.element(screen.getByText(/scheduler heartbeat is stale/i)).toBeInTheDocument();
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

	it("omits quick actions for hidden collections", async () => {
		mockFetchDashboardStats.mockResolvedValue(makeStats([]));
		const withHidden: AdminManifest = {
			...manifest,
			collections: {
				...manifest.collections,
				sync_runs: { ...manifest.collections.pages!, labelSingular: "Sync run", hidden: true },
			},
		};

		const screen = await render(<Dashboard manifest={withHidden} />);

		await expect.element(screen.getByRole("link", { name: "Page" })).toBeInTheDocument();
		await expect.element(screen.getByRole("link", { name: "Sync run" })).not.toBeInTheDocument();
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

	describe("site import suggestion", () => {
		const emptyStats = () =>
			makeStats([
				{ slug: "pages", label: "Pages", total: 0, published: 0, draft: 0, scheduled: 0 },
			]);

		it("links an admin of an importable site to the Transfer import", async () => {
			mockFetchDashboardStats.mockResolvedValue(emptyStats());
			mockFetchTransferCapabilities.mockResolvedValue(transferCapabilities(true));

			const screen = await render(<Dashboard manifest={manifest} />);

			await expect
				.element(screen.getByRole("link", { name: "Import a site package" }))
				.toHaveAttribute("href", "/settings/transfer?start=import");
		});

		it("stays hidden when the site can't receive an import", async () => {
			mockFetchDashboardStats.mockResolvedValue(emptyStats());
			mockFetchTransferCapabilities.mockResolvedValue(transferCapabilities(false));

			const screen = await render(<Dashboard manifest={manifest} />);

			await expect.element(screen.getByText("Media files")).toBeInTheDocument();
			await vi.waitFor(() => expect(mockFetchTransferCapabilities).toHaveBeenCalled());
			await expect
				.element(screen.getByText("Moving from another EmDash site?"))
				.not.toBeInTheDocument();
		});

		it("doesn't check import eligibility for non-admins", async () => {
			mockUseCurrentUser.mockReturnValue({ data: { role: 40 } });
			mockFetchDashboardStats.mockResolvedValue(emptyStats());
			mockFetchTransferCapabilities.mockResolvedValue(transferCapabilities(true));

			const screen = await render(<Dashboard manifest={manifest} />);

			await expect.element(screen.getByText("Media files")).toBeInTheDocument();
			await expect
				.element(screen.getByText("Moving from another EmDash site?"))
				.not.toBeInTheDocument();
			expect(mockFetchTransferCapabilities).not.toHaveBeenCalled();
		});

		it("doesn't check import eligibility once the site has content", async () => {
			mockFetchDashboardStats.mockResolvedValue(
				makeStats([
					{ slug: "pages", label: "Pages", total: 1, published: 1, draft: 0, scheduled: 0 },
				]),
			);
			mockFetchTransferCapabilities.mockResolvedValue(transferCapabilities(true));

			const screen = await render(<Dashboard manifest={manifest} />);

			await expect.element(screen.getByText("Media files")).toBeInTheDocument();
			await expect
				.element(screen.getByText("Moving from another EmDash site?"))
				.not.toBeInTheDocument();
			expect(mockFetchTransferCapabilities).not.toHaveBeenCalled();
		});

		it("stays dismissed", async () => {
			mockFetchDashboardStats.mockResolvedValue(emptyStats());
			mockFetchTransferCapabilities.mockResolvedValue(transferCapabilities(true));

			const first = await render(<Dashboard manifest={manifest} />);
			await first.getByRole("button", { name: "Dismiss import suggestion" }).click();
			await expect
				.element(first.getByText("Moving from another EmDash site?"))
				.not.toBeInTheDocument();
			await first.unmount();

			const second = await render(<Dashboard manifest={manifest} />);
			await expect.element(second.getByText("Media files")).toBeInTheDocument();
			await expect
				.element(second.getByText("Moving from another EmDash site?"))
				.not.toBeInTheDocument();
			expect(mockFetchTransferCapabilities).toHaveBeenCalledTimes(1);
		});
	});
});
