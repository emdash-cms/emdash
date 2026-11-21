import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createMenuItem,
	createMenuTranslation,
	deleteMenu,
	deleteMenuItem,
	fetchMenu,
	fetchMenuTranslations,
	reorderMenuItems,
	updateMenu,
	updateMenuItem,
} from "../../../src/lib/api/menus.js";

describe("menu API names", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		"primary",
		"サイドメニュー",
		"%e3%82%b5%e3%82%a4%e3%83%89%e3%83%a1%e3%83%8b%e3%83%a5%e3%83%bc",
		"menu/with?reserved#characters%",
	])("preserves the stored name %s across menu operations", async (name) => {
		const requests: Array<{ name: string; suffix: string; method: string; locale: string | null }> =
			[];
		globalThis.fetch = vi.fn(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname.slice("/_emdash/api/menus/".length).split("/");
			requests.push({
				name: decodeURIComponent(path[0]!),
				suffix: path.slice(1).join("/"),
				method: init?.method ?? "GET",
				locale: url.searchParams.get("locale"),
			});
			return Response.json({ data: { name } });
		});

		const options = { locale: "ja" };
		await fetchMenu(name, options);
		await updateMenu(name, { label: "更新" }, options);
		await deleteMenu(name, options);
		await createMenuItem(name, { type: "custom", label: "リンク", customUrl: "/" }, options);
		await updateMenuItem(name, "item-1", { label: "更新" }, options);
		await deleteMenuItem(name, "item-1", options);
		await reorderMenuItems(name, { items: [] }, options);
		await fetchMenuTranslations(name, options);
		await createMenuTranslation(name, { locale: "en" }, options);

		expect(requests).toEqual(
			[
				["", "GET"],
				["", "PUT"],
				["", "DELETE"],
				["items", "POST"],
				["items/item-1", "PUT"],
				["items/item-1", "DELETE"],
				["reorder", "POST"],
				["translations", "GET"],
				["translations", "POST"],
			].map(([suffix, method]) => ({ name, suffix, method, locale: "ja" })),
		);
	});
});
