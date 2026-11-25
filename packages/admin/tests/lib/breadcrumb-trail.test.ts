import type { MessageDescriptor } from "@lingui/core";
import { describe, expect, it } from "vitest";

import {
	type BreadcrumbClaim,
	type BreadcrumbLeaf,
	type BreadcrumbRouteData,
	resolveBreadcrumbTrail,
} from "../../src/lib/breadcrumb-trail";

const label = (message: string): MessageDescriptor => ({ id: message, message });

const routes: Record<string, BreadcrumbRouteData> = {
	"/shops": { pageTitle: label("Shops") },
	"/shops/$shop": {
		pageTitle: label("Edit shop"),
		breadcrumb: { parent: "/shops", dynamic: true },
	},
	"/shops/$shop/orders": {
		pageTitle: label("Shop orders"),
		breadcrumb: { parent: "/shops/$shop", label: label("Orders") },
	},
	"/files": { pageTitle: label("Files") },
};

function trail(
	path: string,
	pathname: string,
	params: Record<string, string> = {},
	claim: BreadcrumbClaim = null,
) {
	const leaf: BreadcrumbLeaf = { pathname, params, staticData: routes[path]! };
	return resolveBreadcrumbTrail({
		leaf,
		lookup: (parent) => routes[parent],
		translate: (descriptor) => `[${descriptor.message}]`,
		claim,
	});
}

describe("resolveBreadcrumbTrail", () => {
	it("gives a page without a parent no trail", () => {
		expect(trail("/files", "/files")).toEqual([]);
		expect(trail("/files", "/files", {}, { kind: "current", label: "Ignored" })).toEqual([]);
	});

	it("follows parents to the top and fills their params from the child", () => {
		expect(trail("/shops/$shop/orders", "/shops/a%20b/orders", { shop: "a b" })).toEqual([
			{ label: "[Shops]", href: "/shops" },
			{ label: "[Edit shop]", href: "/shops/a%20b" },
			{ label: "[Orders]" },
		]);
	});

	it("shows a dynamic route's label until its page claims the crumb", () => {
		expect(trail("/shops/$shop", "/shops/a", { shop: "a" })).toEqual([
			{ label: "[Shops]", href: "/shops" },
			{ label: "[Edit shop]" },
		]);
		expect(
			trail("/shops/$shop", "/shops/a", { shop: "a" }, { kind: "current", label: undefined }),
		).toEqual([{ label: "[Shops]", href: "/shops" }, { label: undefined }]);
		expect(
			trail("/shops/$shop", "/shops/a", { shop: "a" }, { kind: "current", label: "Corner shop" }),
		).toEqual([{ label: "[Shops]", href: "/shops" }, { label: "Corner shop" }]);
	});

	it("ignores a current claim on a route that names its own crumb", () => {
		expect(
			trail(
				"/shops/$shop/orders",
				"/shops/a/orders",
				{ shop: "a" },
				{ kind: "current", label: "Stale" },
			).at(-1),
		).toEqual({ label: "[Orders]" });
	});

	it("turns the route's crumb into a link when the page nests a level below it", () => {
		expect(trail("/files", "/files", {}, { kind: "nested", label: "Invoices" })).toEqual([
			{ label: "[Files]", href: "/files" },
			{ label: "Invoices" },
		]);
		expect(
			trail("/shops/$shop", "/shops/a", { shop: "a" }, { kind: "nested", label: undefined }),
		).toEqual([
			{ label: "[Shops]", href: "/shops" },
			{ label: "[Edit shop]", href: "/shops/a" },
			{ label: undefined },
		]);
	});
});
