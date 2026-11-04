import { i18n } from "@lingui/core";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { page } from "vitest/browser";

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
const { messages: ruMessages } = await import("../../src/locales/ru/messages.mjs");

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
		const inside = (element: Element) => {
			const rect = element.getBoundingClientRect();
			return (
				rect.left >= cardRect.left - 0.5 &&
				rect.right <= cardRect.right + 0.5 &&
				element.scrollWidth <= element.clientWidth + 0.5
			);
		};
		return {
			top: Math.round(cardRect.top),
			labelInside: [heading, ...heading.querySelectorAll("*")].every(inside),
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
	document.documentElement.lang = "en";
	i18n.loadAndActivate({ locale: "en", messages: {} });
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

	it("keeps a long linked Scheduled label inside its card on a 320px phone", async () => {
		i18n.loadAndActivate({ locale: "ru", messages: ruMessages });
		document.documentElement.lang = "ru";
		await page.viewport(320, 800);
		const { userCount: _userCount, ...withoutUsers } = stats(2);
		mockFetchDashboardStats.mockResolvedValue(withoutUsers);

		const screen = await render(
			<div className="p-6">
				<Dashboard manifest={manifest} />
			</div>,
		);
		const link = screen.getByRole("link", { name: "Запланировано" });
		await expect.element(link).toBeVisible();
		const rects = await metricRects();
		const arrow = link.element().querySelector("svg");
		if (!arrow) throw new Error("Scheduled arrow is missing");

		expect(rects).toHaveLength(3);
		expect(rowCount(rects)).toBe(1);
		expect(rects.every((rect) => rect.labelInside)).toBe(true);
		expect(arrow.getBoundingClientRect().width).toBeCloseTo(14, 0);
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
