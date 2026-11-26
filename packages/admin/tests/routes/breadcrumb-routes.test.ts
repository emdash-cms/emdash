import type { AnyRoute } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { createAdminRouter } from "../../src/router";
import { createTestQueryClient } from "../utils/test-helpers";

const NESTED_PAGES_OUTSIDE_SETTINGS = [
	"/menus/$name",
	"/sections/$slug",
	"/content-types/new",
	"/content-types/relations",
	"/content-types/$slug",
	"/plugins-manager/$pluginId/settings",
	"/plugins/registry/$publisher/$slug",
];

const routesByPath: Record<string, AnyRoute | undefined> =
	createAdminRouter(createTestQueryClient()).routesByPath;
const paths = Object.keys(routesByPath);
const staticData = (path: string) => routesByPath[path]?.options.staticData;
const parentOf = (path: string) => staticData(path)?.breadcrumb?.parent;
const nestedPaths = paths.filter((path) => parentOf(path) !== undefined);

describe("breadcrumb route metadata", () => {
	it("nests exactly the settings sub-pages and the pages under a list", () => {
		const settingsSubpages = paths.filter((path) => path.startsWith("/settings/"));
		expect(settingsSubpages.length).toBeGreaterThan(0);
		for (const path of settingsSubpages) expect(parentOf(path), path).toBe("/settings");

		expect(nestedPaths.toSorted()).toEqual(
			[...settingsSubpages, ...NESTED_PAGES_OUTSIDE_SETTINGS].toSorted(),
		);
	});

	it("names parents that are routes above the page", () => {
		for (const path of nestedPaths) {
			const seen = new Set([path]);
			for (let parent = parentOf(path); parent; parent = parentOf(parent)) {
				expect(routesByPath[parent], `${path} names a parent that is not a route`).toBeDefined();
				expect(seen.has(parent), `${path} has a parent cycle`).toBe(false);
				expect(path.startsWith(`${parent}/`), `${parent} is not above ${path}`).toBe(true);
				seen.add(parent);
			}
		}
	});

	it("labels every route in a trail", () => {
		for (const path of nestedPaths) {
			for (let route: string | undefined = path; route; route = parentOf(route)) {
				const data = staticData(route);
				expect(data?.breadcrumb?.label ?? data?.pageTitle, `${route} has no label`).toBeDefined();
			}
		}
	});

	it("lets a nested page name its crumb when its path identifies an item", () => {
		for (const path of nestedPaths) {
			expect(staticData(path)?.breadcrumb?.dynamic ?? false, path).toBe(path.includes("$"));
		}
	});
});
