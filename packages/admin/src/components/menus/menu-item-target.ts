import { useLingui } from "@lingui/react/macro";
import type { Icon } from "@phosphor-icons/react";
import {
	Article,
	File as FileIcon,
	FolderSimple,
	LinkSimple,
	Stack,
	Tag,
	TextT,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";

import {
	ApiResponseError,
	fetchContent,
	fetchManifest,
	fetchTaxonomyDefs,
	fetchTerms,
	fetchTrashedContent,
	type MenuItem,
	type TaxonomyDef,
	type TaxonomyTerm,
} from "../../lib/api";
import { getEntryTitle } from "../../lib/entryTitle.js";
import { resolveTaxonomyDefinitions } from "../../lib/taxonomy-definitions.js";
import { contentUrl } from "../../lib/url.js";

export type MenuItemKind = "page" | "entry" | "archive" | "term" | "link" | "heading";

/** A menu item's link problem that hides it on the site. */
export type MenuItemProblem = "draft" | "trashed" | "missing";

const MENU_ITEM_KIND_ICONS: Record<MenuItemKind, Icon> = {
	page: FileIcon,
	entry: Article,
	archive: Stack,
	term: Tag,
	link: LinkSimple,
	heading: TextT,
};

/** A custom item with no URL, or only `#`, groups the items under it. */
export function isHeadingUrl(url: string | null | undefined): boolean {
	const trimmed = url?.trim() ?? "";
	return trimmed === "" || trimmed === "#";
}

/** The collection and id a content menu item points at, if it points at one. */
function getContentReference(item: MenuItem): { collection: string; id: string } | null {
	if (!item.referenceId) return null;
	if (item.type === "page" || item.type === "post") {
		return { collection: item.referenceCollection || `${item.type}s`, id: item.referenceId };
	}
	if (item.type === "collection" && item.referenceCollection) {
		return { collection: item.referenceCollection, id: item.referenceId };
	}
	return null;
}

export function getMenuItemKind(item: MenuItem): MenuItemKind {
	if (item.type === "custom") return isHeadingUrl(item.customUrl) ? "heading" : "link";
	if (item.type === "taxonomy") return "term";
	if (item.type === "collection" && !item.referenceId) return "archive";
	const reference = getContentReference(item);
	return reference?.collection === "pages" ? "page" : "entry";
}

export function useManifest() {
	return useQuery({ queryKey: ["manifest"], queryFn: fetchManifest }).data;
}

export function useTaxonomyDefs(locale?: string): TaxonomyDef[] {
	const manifest = useManifest();
	const { data = [] } = useQuery({
		queryKey: ["taxonomy-defs"],
		queryFn: () => fetchTaxonomyDefs(),
	});
	return resolveTaxonomyDefinitions(data, locale, manifest?.i18n?.defaultLocale);
}

/** Terms of a taxonomy, flattened in tree order with their depth. */
export function flattenTerms(terms: readonly TaxonomyTerm[], depth = 0) {
	const result: Array<{ term: TaxonomyTerm; depth: number }> = [];
	for (const term of terms) {
		result.push({ term, depth });
		result.push(...flattenTerms(term.children ?? [], depth + 1));
	}
	return result;
}

export function termsQueryOptions(taxonomy: string, locale?: string) {
	return {
		queryKey: [
			"taxonomy-terms",
			taxonomy,
			locale,
			{ includeCounts: false, resolveFallback: false },
		] as const,
		queryFn: () => fetchTerms(taxonomy, { locale, includeCounts: false }),
	};
}

interface TermMatch {
	taxonomy: TaxonomyDef;
	term: TaxonomyTerm;
}

/** Finds the term a taxonomy item points at. Older items don't record their taxonomy. */
function useTermMatch(item: MenuItem, locale?: string) {
	const defs = useTaxonomyDefs(locale);
	const enabled = item.type === "taxonomy" && !!item.referenceId && defs.length > 0;
	const candidates = item.referenceCollection
		? defs.filter((def) => def.name === item.referenceCollection)
		: defs;
	const { data, isLoading } = useQuery({
		queryKey: ["menu-term-index", candidates.map((def) => def.name), locale],
		queryFn: async () => {
			const lists = await Promise.all(
				candidates.map(async (def) => ({
					def,
					terms: flattenTerms(await fetchTerms(def.name, { locale, includeCounts: false })),
				})),
			);
			const index = new Map<string, TermMatch>();
			for (const { def, terms } of lists) {
				for (const { term } of terms) {
					index.set(term.id, { taxonomy: def, term });
					if (term.translationGroup) index.set(term.translationGroup, { taxonomy: def, term });
				}
			}
			return index;
		},
		enabled,
		staleTime: 60_000,
	});
	return {
		match: item.referenceId ? data?.get(item.referenceId) : undefined,
		isLoading: enabled && isLoading,
		resolved: enabled && !!data,
	};
}

function useContentMatch(item: MenuItem, locale?: string) {
	const reference = getContentReference(item);
	const entry = useQuery({
		queryKey: ["menu-item-entry", reference?.collection, reference?.id, locale],
		queryFn: () => fetchContent(reference!.collection, reference!.id, { locale }),
		enabled: !!reference,
		retry: false,
		staleTime: 60_000,
	});
	const notFound = entry.error instanceof ApiResponseError && entry.error.status === 404;
	const trash = useQuery({
		queryKey: ["menu-item-trash", reference?.collection, locale],
		queryFn: () => fetchTrashedContent(reference!.collection, { limit: 100, locale }),
		enabled: !!reference && notFound,
		retry: false,
		staleTime: 60_000,
	});
	let problem: MenuItemProblem | undefined;
	if (entry.data) problem = entry.data.status === "published" ? undefined : "draft";
	else if (notFound && trash.data) {
		const trashed = trash.data.items.some(
			(candidate) => candidate.id === reference?.id || candidate.translationGroup === reference?.id,
		);
		problem = trashed ? "trashed" : "missing";
	} else if (notFound && trash.isError) problem = "missing";
	return { reference, entry: entry.data, problem };
}

export interface MenuItemTarget {
	kind: MenuItemKind;
	/** Where the item goes, in words or as a path. Empty while it's loading. */
	destination: string;
	/** Whether `destination` is a URL or path, shown left to right. */
	destinationIsUrl: boolean;
	/** The title of the entry or term it links to. */
	title?: string;
	problem?: MenuItemProblem;
	opensInNewTab: boolean;
	/** For a term: whether its taxonomy nests, which picks the folder icon over the tag. */
	hierarchical?: boolean;
}

/** Resolves what a raw menu item row links to, for display in the admin only. */
export function useMenuItemTarget(item: MenuItem, locale?: string): MenuItemTarget {
	const { t } = useLingui();
	const manifest = useManifest();
	const kind = getMenuItemKind(item);
	const content = useContentMatch(item, locale);
	const term = useTermMatch(item, locale);
	const opensInNewTab = item.target === "_blank";

	switch (kind) {
		case "link":
			return {
				kind,
				destination: item.customUrl ?? "",
				destinationIsUrl: true,
				opensInNewTab,
			};
		case "heading":
			return { kind, destination: t`Heading`, destinationIsUrl: false, opensInNewTab };
		case "archive": {
			const slug = item.referenceCollection ?? "";
			const label = manifest?.collections[slug]?.label ?? slug;
			return { kind, destination: t`All ${label}`, destinationIsUrl: false, opensInNewTab };
		}
		case "term": {
			if (term.match) {
				const taxonomyLabel = term.match.taxonomy.label;
				const termLabel = term.match.term.label;
				return {
					kind,
					destination: t`${taxonomyLabel} · ${termLabel}`,
					destinationIsUrl: false,
					title: termLabel,
					opensInNewTab,
					hierarchical: term.match.taxonomy.hierarchical,
				};
			}
			return {
				kind,
				destination: "",
				destinationIsUrl: false,
				problem: term.resolved ? "missing" : undefined,
				opensInNewTab,
			};
		}
		case "page":
		case "entry": {
			const { reference, entry } = content;
			if (!reference) return { kind, destination: "", destinationIsUrl: false, opensInNewTab };
			if (entry) {
				const collection = manifest?.collections[reference.collection];
				const title = getEntryTitle(entry, collection?.titleField);
				const path =
					collection?.urlPattern && entry.slug
						? contentUrl(reference.collection, entry.slug, collection.urlPattern, {
								locale: entry.locale,
								i18n: manifest?.i18n,
								id: entry.id,
								date: entry.publishedAt,
							})
						: null;
				return {
					kind,
					destination: path ?? title,
					destinationIsUrl: !!path,
					title,
					problem: content.problem,
					opensInNewTab,
				};
			}
			return {
				kind,
				destination: "",
				destinationIsUrl: false,
				problem: content.problem,
				opensInNewTab,
			};
		}
	}
}

export function useProblemLabels() {
	const { t } = useLingui();
	return {
		long: {
			draft: t`Draft · hidden on the site`,
			trashed: t`In trash · hidden on the site`,
			missing: t`Not found · hidden on the site`,
		} satisfies Record<MenuItemProblem, string>,
		short: {
			draft: t`Draft`,
			trashed: t`In trash`,
			missing: t`Not found`,
		} satisfies Record<MenuItemProblem, string>,
	};
}

export function kindIcon(kind: MenuItemKind, hierarchical?: boolean): Icon {
	if (kind === "term" && hierarchical) return FolderSimple;
	return MENU_ITEM_KIND_ICONS[kind];
}
