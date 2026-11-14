import type { ValidatedPackageView } from "@emdash-cms/registry-client/discovery";
import type { RegistryEntryData } from "@emdash-cms/registry-loader";

import { PAGE_SIZE } from "./search.js";

type PackageProfile = NonNullable<ValidatedPackageView["profile"]>;

/** The fields ranking reads. */
export type RankablePlugin = Pick<ValidatedPackageView, "did" | "slug" | "indexedAt"> & {
	profile?: Pick<PackageProfile, "lastUpdated"> | null;
};

/** A plugin placed in a listing. */
export interface ListedPlugin<T extends RankablePlugin = ValidatedPackageView> {
	package: T;
	/**
	 * On the publisher's first card in the listing, how many of their other
	 * plugins the listing leaves out. 0 on every other card, and on search results,
	 * since the publisher page lists all their plugins, not only the matches.
	 */
	moreFromPublisher: number;
}

/** A listed plugin with the latest release its card needs. */
export type ListedEntry = ListedPlugin & Pick<RegistryEntryData, "latestRelease">;

export interface CatalogPage<T extends RankablePlugin = ValidatedPackageView> {
	items: ListedPlugin<T>[];
	/** The page shown: the requested page, clamped to the last one. */
	page: number;
	pageCount: number;
}

const RECENT_RAIL_SIZE = 12;

/**
 * When the plugin's current profile was last updated: the publisher's
 * `lastUpdated`, but never later than when the registry first saw that profile
 * revision (`indexedAt`). A publisher's date can lower a plugin's place but
 * never raise it, and a registry backfill that resets `indexedAt` keeps the
 * publishers' order.
 */
export function updatedAt(plugin: Pick<RankablePlugin, "indexedAt" | "profile">): string {
	const claimed = plugin.profile?.lastUpdated;
	return claimed && Date.parse(claimed) < Date.parse(plugin.indexedAt) ? claimed : plugin.indexedAt;
}

/**
 * The home page's "Recently updated" rail: the most recently updated plugin
 * of each of the twelve most recently active publishers, newest first. A
 * catalog with fewer publishers gets a shorter rail, never a second card from
 * one publisher.
 */
export function recentlyUpdated<T extends RankablePlugin>(
	catalog: readonly T[],
): ListedPlugin<T>[] {
	const publishers = new Set(catalog.map((pkg) => pkg.did)).size;
	const rail = inRounds(catalog.toSorted(byFreshness)).slice(
		0,
		Math.min(RECENT_RAIL_SIZE, publishers),
	);
	return listed(rail, catalog);
}

/**
 * One page of `/search`, listing every plugin in `packages` once across the
 * pages: each publisher's first, then each publisher's second, and so on.
 * With a query, "first" follows the registry's relevance order, so a query
 * matching one publisher, such as their handle, keeps the registry's order.
 * Without one, it follows freshness, newest first, so the first page opens
 * with the home page's rail, and the order depends only on which plugins are
 * in `packages`, not on the order the registry walk returned them, so
 * `?page=N` is a stable address.
 */
export function catalogPage<T extends RankablePlugin>(
	packages: readonly T[],
	query: string,
	requestedPage: number,
): CatalogPage<T> {
	const pageCount = Math.max(1, Math.ceil(packages.length / PAGE_SIZE));
	const page = Math.min(Math.max(requestedPage, 1), pageCount);
	const start = (page - 1) * PAGE_SIZE;
	const ordered = query ? packages : packages.toSorted(byFreshness);
	const window = inRounds(ordered).slice(start, start + PAGE_SIZE);
	const items = query
		? window.map((pkg) => ({ package: pkg, moreFromPublisher: 0 }))
		: listed(window, packages);
	return { items, page, pageCount };
}

/**
 * `ordered`, regrouped by round and keeping its order within a round, where a
 * plugin's round is its place among its publisher's plugins in `ordered`.
 * Publishers are DIDs: handles are mutable and optional.
 */
function inRounds<T extends RankablePlugin>(ordered: readonly T[]): T[] {
	const placed = new Map<string, number>();
	const ranked = ordered.map((pkg) => {
		const round = placed.get(pkg.did) ?? 0;
		placed.set(pkg.did, round + 1);
		return { pkg, round };
	});
	return ranked.toSorted((a, b) => a.round - b.round).map(({ pkg }) => pkg);
}

/** Newest `updatedAt` first, then DID, then slug, which together are unique. */
function byFreshness(a: RankablePlugin, b: RankablePlugin): number {
	return updatedTime(b) - updatedTime(a) || compare(a.did, b.did) || compare(a.slug, b.slug);
}

function updatedTime(plugin: RankablePlugin): number {
	const time = Date.parse(updatedAt(plugin));
	return Number.isNaN(time) ? Number.MIN_SAFE_INTEGER : time;
}

/** Code-unit order, so the ranking can't change with the runtime's locale data. */
function compare(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/** Marks each publisher's first card in `window` with how many of their plugins in `catalog` it leaves out. */
function listed<T extends RankablePlugin>(
	window: readonly T[],
	catalog: readonly T[],
): ListedPlugin<T>[] {
	const total = countByPublisher(catalog);
	const shown = countByPublisher(window);
	const marked = new Set<string>();
	return window.map((pkg) => {
		const first = !marked.has(pkg.did);
		marked.add(pkg.did);
		return {
			package: pkg,
			moreFromPublisher: first ? (total.get(pkg.did) ?? 0) - (shown.get(pkg.did) ?? 0) : 0,
		};
	});
}

function countByPublisher(packages: readonly RankablePlugin[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const pkg of packages) counts.set(pkg.did, (counts.get(pkg.did) ?? 0) + 1);
	return counts;
}
