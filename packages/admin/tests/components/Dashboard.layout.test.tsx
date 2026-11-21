import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { AdminManifest } from "../../src/lib/api";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import { PluginAdminProvider } from "../../src/lib/plugin-context";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, params: _params, search: _search, ...props }: any) => (
			<a href={String(to ?? "")} {...props}>
				{children}
			</a>
		),
	};
});

const mockFetchDashboardStats = vi.fn<() => Promise<DashboardStats>>();

vi.mock("../../src/lib/api/dashboard", async () => ({
	...(await vi.importActual("../../src/lib/api/dashboard")),
	fetchDashboardStats: () => mockFetchDashboardStats(),
}));

vi.mock("../../src/lib/api/current-user", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api/current-user")>()),
	useCurrentUser: () => ({ data: { role: 50 } }),
}));

const { Dashboard } = await import("../../src/components/Dashboard");

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "test",
	authMode: "passkey",
	collections: {
		case_studies: {
			label: "Customer Success Stories, Case Studies & Partner Spotlights (2015–2025)",
			labelSingular: "Customer Success Story",
			supports: [],
			hasSeo: false,
			fields: {},
		},
	},
	plugins: {},
};

const longTitle =
	"How We Migrated 1,284 WordPress Sites to EmDash Without Losing a Single Comment, Redirect, or Custom Field";

describe("Dashboard layout", () => {
	it("keeps long titles, collection names and scheduling notices inside a phone-width screen", async () => {
		await page.viewport(375, 800);
		mockFetchDashboardStats.mockResolvedValue({
			collections: [
				{
					slug: "case_studies",
					label: "Customer Success Stories, Case Studies & Partner Spotlights (2015–2025)",
					total: 1,
					published: 1,
					draft: 0,
					scheduled: 0,
				},
			],
			mediaCount: 18_432,
			userCount: 1,
			recentItems: [
				{
					id: "1",
					collection: "case_studies",
					collectionLabel: "Customer Success Stories & Case Studies",
					title: longTitle,
					slug: "migrated",
					status: "published",
					updatedAt: new Date().toISOString(),
					authorId: null,
				},
			],
			policyRejectedScheduled: 1,
			policyRejections: [
				{
					collection: "case_studies",
					id: "01JD3K8Q9X7V2M4N6P8R0T2W00",
					reason:
						"This entry needs sign-off from a second editor in the Legal & Compliance group before it can be published.",
					rejectedAt: new Date().toISOString(),
					_rev: "rev",
				},
			],
		});

		const screen = await render(
			<div style={{ width: 375, padding: 24, boxSizing: "border-box" }}>
				<Dashboard manifest={manifest} />
			</div>,
		);

		await expect.element(screen.getByText(longTitle)).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
		const container = screen.container.firstElementChild as HTMLElement;
		const limit = container.getBoundingClientRect().right;
		const overflowing = [...container.querySelectorAll("*")].filter(
			(element) => element.getBoundingClientRect().right > limit + 0.5,
		);
		expect(overflowing.map((element) => element.outerHTML.slice(0, 80))).toEqual([]);
	});

	it("places plugin widgets by size, keeping Content above them on narrow screens", async () => {
		mockFetchDashboardStats.mockResolvedValue({
			collections: [
				{
					slug: "case_studies",
					label: "Case studies",
					total: 1,
					published: 1,
					draft: 0,
					scheduled: 0,
				},
			],
			mediaCount: 1,
			userCount: 1,
			recentItems: [],
		});
		const withWidgets: AdminManifest = {
			...manifest,
			plugins: {
				forms: {
					enabled: true,
					dashboardWidgets: [
						{ id: "submissions", title: "Submissions", size: "half" },
						{ id: "status", title: "Status", size: "third" },
					],
				},
			},
		};
		const card = (name: string) =>
			screen.getByRole("heading", { name }).element().parentElement!.parentElement!;
		const left = (name: string) => card(name).getBoundingClientRect().left;
		const top = (name: string) => card(name).getBoundingClientRect().top;

		await page.viewport(1440, 900);
		const screen = await render(
			<PluginAdminProvider
				pluginAdmins={{ forms: { widgets: { submissions: () => null, status: () => null } } }}
			>
				<Dashboard manifest={withWidgets} />
			</PluginAdminProvider>,
		);
		await expect.element(screen.getByRole("heading", { name: "Submissions" })).toBeInTheDocument();

		expect(left("Submissions")).toBeCloseTo(left("Overview"), 0);
		expect(left("Status")).toBeCloseTo(left("Content"), 0);
		expect(left("Content")).toBeGreaterThan(left("Overview"));

		await page.viewport(900, 900);
		await expect.poll(() => left("Content")).toBeCloseTo(left("Overview"), 0);
		expect(top("Content")).toBeLessThan(top("Submissions"));
	});
});
