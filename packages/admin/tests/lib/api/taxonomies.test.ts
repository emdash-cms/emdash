import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createTermTranslation,
	deleteTerm,
	fetchTermTranslations,
	updateTerm,
} from "../../../src/lib/api/taxonomies.js";

describe("taxonomy API slugs", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		"plain-term",
		"その他",
		"%e3%81%9d%e3%81%ae%e4%bb%96",
		"%E3%81%9D%E3%81%AE%E4%BB%96",
		"term/with?reserved#characters%",
	])("addresses the stored slug %s in every term request", async (slug) => {
		const requests: Array<{ slug: string; suffix: string; method: string; locale: string | null }> =
			[];
		globalThis.fetch = vi.fn(async (input, init) => {
			const url = new URL(String(input), "http://localhost");
			const path = url.pathname.slice("/_emdash/api/taxonomies/category/terms/".length).split("/");
			requests.push({
				slug: decodeURIComponent(path[0]!),
				suffix: path.slice(1).join("/"),
				method: init?.method ?? "GET",
				locale: url.searchParams.get("locale"),
			});
			return Response.json({ data: { term: { slug } } });
		});

		const options = { locale: "ja" };
		await updateTerm("category", slug, { label: "更新" }, options);
		await deleteTerm("category", slug, options);
		await fetchTermTranslations("category", slug, options);
		await createTermTranslation("category", slug, { locale: "en" }, options);

		expect(requests).toEqual(
			[
				["", "PUT"],
				["", "DELETE"],
				["translations", "GET"],
				["translations", "POST"],
			].map(([suffix, method]) => ({ slug, suffix, method, locale: "ja" })),
		);
	});
});
