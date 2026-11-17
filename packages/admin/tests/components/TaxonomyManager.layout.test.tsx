import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { TaxonomyManager } from "../../src/components/TaxonomyManager.js";
import type { TaxonomyTerm } from "../../src/lib/api/taxonomies.js";
import { render } from "../utils/render.js";

let manifestI18n: { defaultLocale: string; locales: string[] } | undefined;
let terms: TaxonomyTerm[] = [];

vi.mock("../../src/lib/api/client.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/client.js");
	return {
		...actual,
		apiFetch: vi.fn(async (url: string) => {
			const data = url.includes("/terms")
				? { terms }
				: {
						taxonomies: [
							{
								id: "categories",
								name: "categories",
								label: "Categories",
								labelSingular: "Category",
								hierarchical: true,
								collections: ["posts"],
							},
						],
					};
			return new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}),
		fetchManifest: vi.fn(async () => ({ collections: {}, i18n: manifestI18n })),
	};
});

function term(slug: string, label: string, children: TaxonomyTerm[] = []): TaxonomyTerm {
	for (const child of children) child.parentId = `${slug}-group`;
	return {
		id: slug,
		name: "categories",
		slug,
		label,
		parentId: null,
		translationGroup: `${slug}-group`,
		children,
		count: 12,
	};
}

/** One term per level, each the only child of the one above it. */
function chain(depth: number, level = 1): TaxonomyTerm {
	return term(
		`photography-level-${level}`,
		`Photography ${level}`,
		level < depth ? [chain(depth, level + 1)] : [],
	);
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<Toasty>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</Toasty>
	);
}

function renderAtWidth(width: number, dir: "ltr" | "rtl" = "ltr") {
	return render(
		<div dir={dir} style={{ width }}>
			<TaxonomyManager taxonomyName="categories" />
		</div>,
		{ wrapper: Wrapper },
	);
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

function nameButton(label: string) {
	return page.getByRole("button", { name: `Edit ${label}`, exact: true });
}

describe("Taxonomy term table layout", () => {
	beforeEach(() => {
		manifestI18n = undefined;
	});

	it.each(["ltr", "rtl"] as const)(
		"fits a nested term list into a phone-width table in %s",
		async (dir) => {
			terms = [
				term("design", "Design", [
					term("typography", "Typography", [
						term("variable-fonts-for-long-form-reading", "Variable fonts"),
					]),
				]),
				term("development", "Development"),
			];
			const screen = await renderAtWidth(272, dir);
			await expect.element(nameButton("Variable fonts")).toBeVisible();
			const tray = screen.getByRole("table").element().parentElement!;
			const box = tray.getBoundingClientRect();

			expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
			for (const label of ["Design", "Typography", "Variable fonts", "Development"]) {
				const row = page.elementLocator(nameButton(label).element().closest("tr")!);
				const slug = row.getByText(/^\//);
				await expect.element(slug).toBeVisible();
				expectInside(slug.element(), box);
				await expect.element(row.getByRole("cell", { name: "12", exact: true })).toBeVisible();
				expectInside(row.getByRole("button", { name: `Actions for ${label}` }).element(), box);
			}

			const start = (label: string) => {
				const bounds = nameButton(label).element().getBoundingClientRect();
				return dir === "ltr" ? bounds.left : -bounds.right;
			};
			expect(start("Typography")).toBeGreaterThan(start("Design"));
			expect(start("Variable fonts")).toBeGreaterThan(start("Typography"));
			expect(start("Development")).toBe(start("Design"));
		},
	);

	it.each([
		[272, "ltr"],
		[272, "rtl"],
		[480, "ltr"],
		[480, "rtl"],
	] as const)(
		"fits a 20-level tree into a %ipx table in %s with each level further in",
		async (width, dir) => {
			terms = [chain(20)];
			const screen = await renderAtWidth(width, dir);
			await expect.element(nameButton("Photography 20")).toBeVisible();
			const tray = screen.getByRole("table").element().parentElement!;
			const box = tray.getBoundingClientRect();

			expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
			const actions = screen.getByRole("button", { name: /^Actions for / }).elements();
			expect(actions).toHaveLength(20);
			for (const button of actions) expectInside(button, box);

			const start = (level: number) => {
				const bounds = nameButton(`Photography ${level}`).element().getBoundingClientRect();
				return dir === "ltr" ? bounds.left : -bounds.right;
			};
			for (let level = 2; level <= 20; level++) {
				expect(start(level), `Photography ${level}`).toBeGreaterThan(start(level - 1));
			}
		},
	);

	it("keeps every header button on the page at a 375px screen's width", async () => {
		manifestI18n = { defaultLocale: "en", locales: ["en", "de"] };
		terms = [term("design", "Design")];
		const screen = await renderAtWidth(327);
		await expect.element(screen.getByRole("combobox", { name: "Locale" })).toBeVisible();
		const box = screen.container.firstElementChild!.getBoundingClientRect();

		for (const name of [
			"New Taxonomy",
			"Add Category",
			"Add to posts",
			"More actions for Categories",
		]) {
			expectInside(screen.getByRole("button", { name }).element(), box);
		}
		expectInside(screen.getByRole("combobox", { name: "Locale" }).element(), box);
	});
});
