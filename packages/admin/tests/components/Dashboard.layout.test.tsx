import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { AdminManifest } from "../../src/lib/api";
import type { DashboardStats } from "../../src/lib/api/dashboard";
import { render } from "../utils/render.tsx";

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

vi.mock("../../src/lib/api/dashboard", async () => {
	const actual = await vi.importActual("../../src/lib/api/dashboard");
	return { ...actual, fetchDashboardStats: () => mockFetchDashboardStats() };
});

vi.mock("../../src/lib/api/transfer.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/transfer.js");
	return {
		...actual,
		fetchTransferCapabilities: () => new Promise(() => {}),
	};
});

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: { role: 50 } }),
}));

const { Dashboard } = await import("../../src/components/Dashboard");

const manifest: AdminManifest = {
	version: "1.0.0",
	hash: "test",
	authMode: "passkey",
	collections: {
		pages: { label: "Pages", labelSingular: "Page", supports: [], hasSeo: false, fields: {} },
	},
	plugins: {},
};

function stats(scheduled: number): DashboardStats {
	return {
		collections: [
			{ slug: "pages", label: "Pages", total: 140, published: 12, draft: 128, scheduled },
		],
		mediaCount: 1024,
		userCount: 12,
		recentItems: [],
		schedulerHealth: { status: "healthy", lastCompletedAt: new Date().toISOString() },
	};
}

async function metricRects() {
	const cards = page.getByTestId("dashboard-metric");
	await expect.poll(() => cards.elements().length).toBeGreaterThan(0);
	return cards.elements().map((card) => {
		const heading = card.querySelector("h2");
		if (!heading) throw new Error("Metric label is missing");
		const cardRect = card.getBoundingClientRect();
		const headingRect = heading.getBoundingClientRect();
		return {
			top: Math.round(cardRect.top),
			labelInside:
				headingRect.left >= cardRect.left - 0.5 &&
				headingRect.right <= cardRect.right + 0.5 &&
				heading.scrollWidth <= heading.clientWidth + 0.5,
		};
	});
}

function rowCount(rects: { top: number }[]) {
	return new Set(rects.map((rect) => rect.top)).size;
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
});

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("Dashboard metrics layout", () => {
	describe.each([320, 375])("on a %ipx phone", (width) => {
		it.each(["ltr", "rtl"] as const)("keeps three metrics on one row (%s)", async (dir) => {
			document.documentElement.dir = dir;
			await page.viewport(width, 800);
			mockFetchDashboardStats.mockResolvedValue(stats(0));

			await render(<Dashboard manifest={manifest} />);
			const rects = await metricRects();

			expect(rects).toHaveLength(3);
			expect(rowCount(rects)).toBe(1);
			expect(rects.every((rect) => rect.labelInside)).toBe(true);
		});

		it.each(["ltr", "rtl"] as const)("puts four metrics in two rows of two (%s)", async (dir) => {
			document.documentElement.dir = dir;
			await page.viewport(width, 800);
			mockFetchDashboardStats.mockResolvedValue(stats(2));

			await render(<Dashboard manifest={manifest} />);
			const rects = await metricRects();

			expect(rects).toHaveLength(4);
			expect(rowCount(rects)).toBe(2);
			expect(rects.every((rect) => rect.labelInside)).toBe(true);
		});
	});

	it("shows four metrics on one row on wide screens", async () => {
		await page.viewport(1280, 800);
		mockFetchDashboardStats.mockResolvedValue(stats(2));

		await render(<Dashboard manifest={manifest} />);
		const rects = await metricRects();

		expect(rects).toHaveLength(4);
		expect(rowCount(rects)).toBe(1);
	});
});
