import { describe, expect, it } from "vitest";

import { catalogPage, type RankablePlugin, recentlyUpdated, updatedAt } from "./discovery.js";
import { PAGE_SIZE } from "./search.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-14T12:00:00Z");

/** A plugin last updated `daysAgo` days before NOW, which the registry saw a few seconds later. */
function plugin(publisher: string, slug: string, daysAgo: number): RankablePlugin {
	const updated = NOW - daysAgo * DAY_MS;
	return {
		did: `did:plc:${publisher}`,
		slug,
		indexedAt: new Date(updated + 8000).toISOString(),
		profile: { lastUpdated: new Date(updated).toISOString() },
	};
}

function publisherPlugins(publisher: string, count: number, firstDaysAgo: number) {
	return Array.from({ length: count }, (_, index) =>
		plugin(publisher, `${publisher}-${index + 1}`, firstDaysAgo + index / 24),
	);
}

const labels = (items: readonly { package: { slug: string } }[]) =>
	items.map((item) => item.package.slug);

/** One publisher with 60 plugins, all newer than the 50 single-plugin publishers' plugins. */
function floodedCatalog() {
	return [
		...publisherPlugins("flood", 60, 0),
		...Array.from({ length: 50 }, (_, index) =>
			plugin(`solo${index}`, `solo-${index}`, 10 + index),
		),
	];
}

function allPages(packages: readonly RankablePlugin[], query = "") {
	const { pageCount } = catalogPage(packages, query, 1);
	return Array.from({ length: pageCount }, (_, index) => catalogPage(packages, query, index + 1));
}

/** Results in relevance order, each newer than the one before it, so freshness order is the reverse. */
function searchResults(...slugs: string[]): RankablePlugin[] {
	return slugs.map((slug, index) => plugin(slug.split("-")[0]!, slug, slugs.length - index));
}

/** A fixed permutation of the items. */
function shuffled<T>(items: readonly T[]): T[] {
	const odd = items.filter((_, index) => index % 2 === 1);
	const even = items.filter((_, index) => index % 2 === 0);
	return [...odd.toReversed(), ...even];
}

describe("updatedAt", () => {
	it("never dates a plugin later than the registry first saw its profile", () => {
		expect(
			updatedAt({
				indexedAt: "2026-07-01T00:00:00.000Z",
				profile: { lastUpdated: "2030-01-01T00:00:00.000Z" },
			}),
		).toBe("2026-07-01T00:00:00.000Z");
	});

	it("keeps the publisher's earlier date when the registry saw the profile late", () => {
		expect(
			updatedAt({
				indexedAt: "2026-11-14T00:00:00.000Z",
				profile: { lastUpdated: "2026-10-01T00:00:00.000Z" },
			}),
		).toBe("2026-10-01T00:00:00.000Z");
	});
});

describe("recentlyUpdated", () => {
	it("shows one plugin per publisher, each publisher's freshest, newest first", () => {
		const catalog = [
			...publisherPlugins("a", 5, 0),
			plugin("b", "b-1", 1),
			...publisherPlugins("c", 2, 2),
		];

		const rail = recentlyUpdated(catalog);

		expect(labels(rail)).toEqual(["a-1", "b-1", "c-1"]);
		expect(rail.map((item) => item.moreFromPublisher)).toEqual([4, 0, 1]);
	});

	it("doesn't let a future lastUpdated take the first card", () => {
		const catalog = [
			{ ...plugin("x", "x-1", 3), profile: { lastUpdated: "2030-01-01T00:00:00.000Z" } },
			plugin("y", "y-1", 1),
		];

		expect(labels(recentlyUpdated(catalog))).toEqual(["y-1", "x-1"]);
	});

	it("shows twelve publishers when more have plugins", () => {
		const catalog = Array.from({ length: 20 }, (_, index) =>
			plugin(`p${index}`, `p-${index}`, index),
		);

		expect(labels(recentlyUpdated(catalog))).toEqual(
			Array.from({ length: 12 }, (_, index) => `p-${index}`),
		);
	});
});

describe("catalogPage", () => {
	it("lists each publisher's freshest plugin before anyone's second", () => {
		const catalog = floodedCatalog();

		const first = catalogPage(catalog, "", 1);
		const order = allPages(catalog).flatMap((page) => labels(page.items));

		expect(first.items.filter((item) => item.package.did === "did:plc:flood")).toHaveLength(1);
		expect(first.items[0]).toMatchObject({ package: { slug: "flood-1" }, moreFromPublisher: 59 });
		const lastSolo = Math.max(
			...order.map((slug, index) => (slug.startsWith("solo") ? index : -1)),
		);
		expect(order.indexOf("flood-2")).toBeGreaterThan(lastSolo);
	});

	it("opens the unfiltered listing with the home page's rail", () => {
		const catalog = [
			...floodedCatalog(),
			...publisherPlugins("busy", 4, 10.5),
			...publisherPlugins("pair", 2, 11.5),
		];

		const rail = labels(recentlyUpdated(catalog));
		const first = labels(catalogPage(catalog, "", 1).items);

		expect(first.slice(0, rail.length)).toEqual(rail);
	});

	it("places every plugin on exactly one page", () => {
		const catalog = floodedCatalog();

		const pages = allPages(catalog);
		const listedSlugs = pages.flatMap((page) => labels(page.items));

		expect(pages.map((page) => page.items.length)).toEqual([
			PAGE_SIZE,
			PAGE_SIZE,
			catalog.length - 2 * PAGE_SIZE,
		]);
		expect(listedSlugs.toSorted()).toEqual(catalog.map((pkg) => pkg.slug).toSorted());
	});

	it("gives the same page whatever order the registry returned", () => {
		const tied = ["b", "a", "c"].flatMap((publisher) => [
			plugin(publisher, `${publisher}-same-1`, 5),
			plugin(publisher, `${publisher}-same-2`, 5),
		]);
		const catalog = [...floodedCatalog(), ...tied];

		const expected = allPages(catalog);

		expect(allPages(shuffled(catalog))).toEqual(expected);
		expect(allPages(catalog.toReversed())).toEqual(expected);
	});

	it("lists each publisher's most relevant result before anyone's second", () => {
		const results = searchResults("a-1", "a-2", "a-3", "a-4", "b-1", "a-5", "c-1", "b-2", "b-3");

		const page = catalogPage(results, "forms", 1);

		expect(labels(page.items)).toEqual([
			"a-1",
			"b-1",
			"c-1",
			"a-2",
			"b-2",
			"a-3",
			"b-3",
			"a-4",
			"a-5",
		]);
		expect(page.items.every((item) => item.moreFromPublisher === 0)).toBe(true);
	});

	it("places every search result on exactly one page", () => {
		const results = floodedCatalog();

		const listedSlugs = allPages(results, "forms").flatMap((page) => labels(page.items));

		expect(listedSlugs.toSorted()).toEqual(results.map((pkg) => pkg.slug).toSorted());
	});

	it("keeps the registry's order when every result has one publisher", () => {
		const results = searchResults("a-3", "a-1", "a-5", "a-2", "a-4");

		const page = catalogPage(results, "did:plc:a", 1);

		expect(page.items.map((item) => item.package)).toEqual(results);
	});

	it("shows the last page for a page past the end", () => {
		const catalog = publisherPlugins("a", PAGE_SIZE + 3, 0);

		const page = catalogPage(catalog, "", 9);

		expect(page.page).toBe(2);
		expect(page.pageCount).toBe(2);
		expect(labels(page.items)).toEqual([
			`a-${PAGE_SIZE + 1}`,
			`a-${PAGE_SIZE + 2}`,
			`a-${PAGE_SIZE + 3}`,
		]);
	});

	it("sorts plugins with unparseable dates after every dated plugin", () => {
		const undated = { ...plugin("u", "u-1", 0), indexedAt: "not a date" };
		const catalog = [undated, plugin("v", "v-1", 400), plugin("w", "w-1", 2)];

		expect(labels(catalogPage(catalog, "", 1).items)).toEqual(["w-1", "v-1", "u-1"]);
	});
});
