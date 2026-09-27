import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
	RouterProvider,
	createMemoryHistory,
	createRootRoute,
	createRouter,
} from "@tanstack/react-router";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import { Sidebar, SidebarNav, type SidebarNavProps } from "../../src/components/Sidebar.js";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: { role: 40 } }),
}));

vi.mock("../../src/lib/api/comments", () => ({
	fetchCommentCounts: vi.fn().mockResolvedValue({ pending: 0 }),
}));

const category = {
	id: "taxdef_category",
	name: "category",
	label: "Categories",
	locale: "en",
	translationGroup: "taxdef_category",
};
const tag = { id: "taxdef_tag", name: "tag", label: "Tags", locale: "en" };

function activateLocale(
	locale: string,
	categories: string,
	tags: string,
	collections = { posts: "Posts", pages: "Pages" },
) {
	i18n.loadAndActivate({
		locale,
		messages: {
			[msg`Categories`.id!]: categories,
			[msg`Tags`.id!]: tags,
			[msg`Posts`.id!]: collections.posts,
			[msg`Pages`.id!]: collections.pages,
		},
	});
}

function renderSidebar(
	taxonomies: SidebarNavProps["manifest"]["taxonomies"],
	locale = "en",
	collections: SidebarNavProps["manifest"]["collections"] = {},
) {
	const manifest: SidebarNavProps["manifest"] = {
		collections,
		plugins: {},
		taxonomies,
		i18n: { defaultLocale: "en", locales: ["en", "nl"] },
	};
	const router = createRouter({
		routeTree: createRootRoute({
			component: () => (
				<Sidebar.Provider defaultOpen>
					<SidebarNav manifest={manifest} />
				</Sidebar.Provider>
			),
		}),
		history: createMemoryHistory({ initialEntries: [`/?locale=${locale}`] }),
	});
	return render(<RouterProvider router={router} />);
}

afterEach(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("sidebar default label localization", () => {
	it("updates default collection labels with the interface language and preserves their routes", async () => {
		activateLocale("nl", "Categorieën", "Tags", { posts: "Berichten", pages: "Pagina's" });
		await renderSidebar([], "en", { posts: { label: "Posts" }, pages: { label: "Pages" } });

		await expect.element(page.getByRole("link", { name: "Berichten", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "Pagina's", exact: true })).toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Berichten", exact: true }))
			.toHaveAttribute("href", "/content/posts");
		await expect
			.element(page.getByRole("link", { name: "Pagina's", exact: true }))
			.toHaveAttribute("href", "/content/pages");

		activateLocale("tr", "Kategoriler", "Etiketler", { posts: "Gönderiler", pages: "Sayfalar" });
		await expect.element(page.getByRole("link", { name: "Gönderiler", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "Sayfalar", exact: true })).toBeVisible();

		activateLocale("ar", "الفئات", "الوسوم", { posts: "المنشورات", pages: "الصفحات" });
		await expect.element(page.getByRole("link", { name: "المنشورات", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "الصفحات", exact: true })).toBeVisible();

		i18n.loadAndActivate({ locale: "en", messages: {} });
		await expect.element(page.getByRole("link", { name: "Posts", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "Pages", exact: true })).toBeVisible();
	});

	it("keeps renamed collections and matching default labels on other collection slugs", async () => {
		activateLocale("nl", "Categorieën", "Tags", { posts: "Berichten", pages: "Pagina's" });
		await renderSidebar([], "en", {
			posts: { label: "Articles" },
			pages: { label: "Landing pages" },
			blog: { label: "Posts" },
			documents: { label: "Pages" },
		});

		for (const name of ["Articles", "Landing pages", "Posts", "Pages"]) {
			await expect.element(page.getByRole("link", { name, exact: true })).toBeVisible();
		}
	});

	it("updates built-in labels when the interface language changes without changing content locale", async () => {
		activateLocale("nl", "Categorieën", "Tags");
		await renderSidebar([category, tag]);

		await expect
			.element(page.getByRole("link", { name: "Categorieën", exact: true }))
			.toBeVisible();
		await expect.element(page.getByRole("link", { name: "Tags", exact: true })).toBeVisible();

		activateLocale("tr", "Kategoriler", "Etiketler");
		await expect
			.element(page.getByRole("link", { name: "Kategoriler", exact: true }))
			.toBeVisible();
		await expect.element(page.getByRole("link", { name: "Etiketler", exact: true })).toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Kategoriler", exact: true }))
			.toHaveAttribute("href", "/taxonomies/category?locale=en");

		activateLocale("ar", "الفئات", "الوسوم");
		await expect.element(page.getByRole("link", { name: "الفئات", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "الوسوم", exact: true })).toBeVisible();

		i18n.loadAndActivate({ locale: "en", messages: {} });
		await expect.element(page.getByRole("link", { name: "Categories", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "Tags", exact: true })).toBeVisible();
	});

	it("keeps renamed built-ins and custom taxonomy labels", async () => {
		activateLocale("nl", "Categorieën", "Tags");
		await renderSidebar([
			{ ...category, label: "Topics" },
			{ id: "custom-category", name: "course", label: "Categories", locale: "en" },
		]);

		await expect.element(page.getByRole("link", { name: "Topics", exact: true })).toBeVisible();
		await expect.element(page.getByRole("link", { name: "Categories", exact: true })).toBeVisible();
	});

	it("keeps the selected content locale's translated taxonomy label", async () => {
		activateLocale("tr", "Kategoriler", "Etiketler");
		await renderSidebar(
			[category, { ...category, id: "category-nl", label: "Onderwerpen", locale: "nl" }],
			"nl",
		);

		await expect
			.element(page.getByRole("link", { name: "Onderwerpen", exact: true }))
			.toBeVisible();
		await expect
			.element(page.getByRole("link", { name: "Onderwerpen", exact: true }))
			.toHaveAttribute("href", "/taxonomies/category?locale=nl");
	});
});
