import { Toasty } from "@cloudflare/kumo/components/toast";
import { DirectionProvider } from "@cloudflare/kumo/primitives";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { TaxonomySidebar } from "../../src/components/TaxonomySidebar.js";
import { apiFetch } from "../../src/lib/api/client.js";
import { adminRoot } from "../utils/form-layout.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api/client.js")>()),
	apiFetch: vi.fn(),
}));

const terms = Array.from({ length: 20 }, (_, index) => ({
	id: `term-${index}`,
	name: `term-${index}`,
	slug: `term-${index}`,
	label: `Term ${String(index).padStart(2, "0")}`,
	children: [],
	locale: "en",
	translationGroup: null,
}));

async function settlePosition() {
	for (let frame = 0; frame < 3; frame++) {
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
	}
}

async function openPicker(label: string, top: number, direction: "ltr" | "rtl") {
	document.documentElement.dir = direction;
	vi.mocked(apiFetch).mockImplementation(async (url) => {
		const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		const data =
			urlString === "/_emdash/api/taxonomies"
				? {
						taxonomies: [
							{
								id: "taxonomy",
								name: "taxonomy",
								label,
								hierarchical: label === "Categories",
								collections: ["posts"],
							},
						],
					}
				: { terms };
		return new Response(JSON.stringify({ data }), {
			headers: { "Content-Type": "application/json" },
		});
	});
	const root = adminRoot();
	const screen = await render(
		<DirectionProvider direction={direction}>
			<Toasty>
				<div style={{ position: "absolute", top, insetInlineEnd: 16, width: 288 }}>
					<TaxonomySidebar collection="posts" canManageTaxonomies />
				</div>
			</Toasty>
		</DirectionProvider>,
		{ container: root },
	);
	await screen.getByRole("button", { name: `Choose ${label}` }).click();
	const search = page.getByRole("searchbox", { name: `Search ${label}` });
	await expect.element(page.getByRole("checkbox", { name: "Term 00", exact: true })).toBeVisible();
	await settlePosition();
	await Promise.all(
		search
			.element()
			.closest('[role="dialog"]')!
			.getAnimations({ subtree: true })
			.map((animation) => animation.finished),
	);
	return { root, search, options: page.getByRole("group", { name: `${label} options` }) };
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	vi.clearAllMocks();
	await page.viewport(1280, 800);
});

describe("TaxonomySidebar picker layout", () => {
	for (const label of ["Categories", "Tags"]) {
		for (const direction of ["ltr", "rtl"] as const) {
			it.each([20, 400, 650])(
				`keeps ${label} search still while filtering at y=%s (${direction})`,
				async (top) => {
					const { search, options } = await openPicker(label, top, direction);
					const initialTop = search.element().getBoundingClientRect().top;
					for (const query of ["Term 19", "no-match", ""]) {
						await search.fill(query);
						await expect
							.poll(() => options.element().querySelectorAll('[role="checkbox"]').length)
							.toBe(query === "" ? 20 : query === "Term 19" ? 1 : 0);
						await settlePosition();
						expect(
							Math.abs(search.element().getBoundingClientRect().top - initialTop),
						).toBeLessThanOrEqual(1);
					}
				},
			);
		}
	}
});

it.each([
	["ltr", 480, 210],
	["rtl", 480, 210],
	["ltr", 320, 130],
	["rtl", 320, 130],
] as const)(
	"fits a short viewport and keeps the last term reachable after resizing (%s, %s)",
	async (direction, height, top) => {
		await page.viewport(360, height);
		const { search, options } = await openPicker("Tags", top, direction);
		const popup = search.element().closest('[role="dialog"]')!;
		const expectInsideViewport = () => {
			const bounds = popup.getBoundingClientRect();
			expect(bounds.top).toBeGreaterThanOrEqual(0);
			expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
			expect(bounds.left).toBeGreaterThanOrEqual(0);
			expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
		};
		expectInsideViewport();
		const initialTop = search.element().getBoundingClientRect().top;
		for (const query of ["Term 19", "no-match", ""]) {
			await search.fill(query);
			await settlePosition();
			expect(
				Math.abs(search.element().getBoundingClientRect().top - initialTop),
			).toBeLessThanOrEqual(1);
			expectInsideViewport();
		}
		const list = options.element();
		expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
		await search.click();
		await userEvent.keyboard("{ArrowUp}");
		const last = page.getByRole("checkbox", { name: "Term 19", exact: true });
		await expect.element(last).toHaveFocus();
		await settlePosition();
		const lastBounds = last.element().getBoundingClientRect();
		const listBounds = list.getBoundingClientRect();
		expect(lastBounds.top).toBeGreaterThanOrEqual(listBounds.top);
		expect(lastBounds.bottom).toBeLessThanOrEqual(listBounds.bottom);
		await page.viewport(360, 400);
		await settlePosition();
		expectInsideViewport();
		await last.click();
		await expect.element(last).toBeChecked();
		await expect
			.element(page.getByRole("list", { name: "Selected Tags" }).getByText("Term 19"))
			.toBeInTheDocument();
	},
);

it.each(["ltr", "rtl"] as const)(
	"tracks page scrolling without moving the search when results change (%s)",
	async (direction) => {
		const { root, search } = await openPicker("Categories", 650, direction);
		root.style.minHeight = "1600px";
		try {
			window.scrollTo(0, 400);
			await settlePosition();
			expect(window.scrollY).toBe(400);
			const searchTop = search.element().getBoundingClientRect().top;
			const popup = search.element().closest('[role="dialog"]')!;
			const bounds = popup.getBoundingClientRect();
			expect(bounds.top).toBeGreaterThanOrEqual(0);
			expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
			await search.fill("Term 19");
			await settlePosition();
			expect(
				Math.abs(search.element().getBoundingClientRect().top - searchTop),
			).toBeLessThanOrEqual(1);
		} finally {
			root.style.minHeight = "";
			window.scrollTo(0, 0);
		}
	},
);
