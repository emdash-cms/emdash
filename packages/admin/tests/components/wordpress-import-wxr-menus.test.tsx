import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { WordPressImport } from "../../src/components/WordPressImport.js";
import { render } from "../utils/render.tsx";
import { createMockFetch, TestWrapper } from "../utils/test-helpers.tsx";

/** What the analyze route reports for an export file with pages and two menus */
const ANALYSIS = {
	site: { title: "Test Site", url: "https://wp.example.com" },
	postTypes: [
		{
			name: "page",
			count: 2,
			suggestedCollection: "pages",
			requiredFields: [],
			schemaStatus: { exists: true, fieldStatus: {}, canImport: true },
		},
	],
	attachments: { count: 0, items: [] },
	categories: 0,
	tags: 0,
	authors: [],
	customFields: [],
	navMenus: [
		{ name: "primary", label: "Main navigation", itemCount: 5 },
		{ name: "footer", label: "Footer", itemCount: 2 },
	],
};

describe("WordPressImport menus from an export file", () => {
	let mockFetch: ReturnType<typeof createMockFetch>;

	beforeEach(() => {
		mockFetch = createMockFetch();
		mockFetch.on("GET", "/_emdash/api/users", { data: { items: [] } });
		mockFetch.on("POST", "/_emdash/api/import/wordpress/analyze", { data: ANALYSIS });
		if (!i18n.locale) {
			i18n.loadAndActivate({ locale: "en", messages: {} });
		}
	});

	afterEach(() => {
		mockFetch.restore();
	});

	it("offers to import the file's menus, listed by their names in WordPress", async () => {
		const screen = await render(
			<I18nProvider i18n={i18n}>
				<WordPressImport />
			</I18nProvider>,
			{ wrapper: TestWrapper },
		);

		await userEvent.upload(
			screen.getByLabelText("Browse Files"),
			new File(["<rss />"], "export.xml", { type: "text/xml" }),
		);

		const menus = screen.getByRole("switch", { name: /Menus \(2\)/ });
		await expect.element(menus).toBeChecked();
		await expect.element(screen.getByText("Main navigation, Footer")).toBeVisible();
		await expect.element(screen.getByText("2 menus will be imported")).toBeVisible();

		await menus.click();

		await expect.element(menus).not.toBeChecked();
		await expect.element(screen.getByText("2 menus will be imported")).not.toBeInTheDocument();
	});
});
