import type { Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { getI18nConfig, resolveConfiguredLocale } from "../i18n/config.js";
import { localizePath, resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { normalizeSourcePath } from "../redirects/patterns.js";
import { SchemaRegistry } from "../schema/registry.js";
import { compileUrlPattern } from "../schema/url-pattern.js";

const TRAILING_SLASHES = /\/+$/;

function pathKey(path: string): string {
	return normalizeSourcePath(path).replace(TRAILING_SLASHES, "") || "/";
}

function basePath(): string {
	const base = import.meta.env.BASE_URL || "/";
	return pathKey(base);
}

type Collection = Awaited<ReturnType<SchemaRegistry["listCollections"]>>[number];
type Candidate = {
	collection: Collection;
	locale: string;
	identifier: string;
	by: "slug" | "id";
};

/** Find live public routes that would be hidden by imported redirect sources. */
export async function findLivePermalinkSources(
	db: Kysely<Database>,
	sources: string[],
): Promise<Set<string>> {
	const live = new Set<string>();
	const collections = (await new SchemaRegistry(db).listCollections()).filter(
		(collection) => collection.routable !== false,
	);
	const locales = getI18nConfig()?.locales ?? ["en"];
	const patterns = new Map<
		string,
		{ collection: Collection; locale: string; regex: RegExp; paramNames: string[] }
	>();

	for (const collection of collections) {
		for (const locale of locales) {
			try {
				const prefix = await localizePath("/", locale);
				if (prefix === null) continue;
				const compiled = compileUrlPattern(
					`${basePath() === "/" ? "" : basePath()}${prefix === "/" ? "" : prefix}${collection.urlPattern ?? `/${collection.slug}/{slug}`}`.replace(
						TRAILING_SLASHES,
						"",
					) || "/",
				);
				patterns.set(`${collection.slug}:${locale}`, { collection, locale, ...compiled });
			} catch {
				// A malformed pattern cannot safely identify a live route.
			}
		}
	}

	const candidates = new Map<string, Candidate[]>();
	for (const source of sources) {
		const sourceKey = pathKey(source);
		const matches: Candidate[] = [];
		for (const { collection, locale, regex, paramNames } of patterns.values()) {
			const match = regex.exec(sourceKey);
			if (!match) continue;
			const slugIndex = paramNames.indexOf("slug");
			const idIndex = paramNames.indexOf("id");
			if (slugIndex < 0 && idIndex < 0) continue;
			const index = slugIndex >= 0 ? slugIndex : idIndex;
			try {
				const identifier = decodeURIComponent(match[1 + index] ?? "");
				matches.push({ collection, locale, identifier, by: slugIndex >= 0 ? "slug" : "id" });
			} catch {
				// Invalid escapes cannot identify content.
			}
		}
		candidates.set(sourceKey, matches);
	}

	const repo = new ContentRepository(db);
	const resolved = new Map<string, ContentItem | null>();
	for (const [sourceKey, matches] of candidates) {
		for (const candidate of matches) {
			const lookupKey = `${candidate.collection.slug}:${candidate.locale}:${candidate.by}:${candidate.identifier}`;
			let item = resolved.get(lookupKey);
			if (item === undefined && !resolved.has(lookupKey)) {
				item =
					candidate.by === "slug"
						? await repo.findBySlug(
								candidate.collection.slug,
								candidate.identifier,
								candidate.locale,
							)
						: await repo.findById(candidate.collection.slug, candidate.identifier);
				resolved.set(lookupKey, item);
			}
			if (!item || item.status !== "published") continue;
			if (
				resolveConfiguredLocale(item.locale ?? "en") !== resolveConfiguredLocale(candidate.locale)
			)
				continue;
			const canonical = await resolveLocalizedContentRoutePath({
				pattern: candidate.collection.urlPattern ?? `/${candidate.collection.slug}/{slug}`,
				collection: candidate.collection.slug,
				slug: item.slug ?? "",
				id: item.id,
				date: item.publishedAt,
				locale: candidate.locale,
			});
			if (!canonical) continue;
			const base = basePath();
			const canonicalWithBase = base === "/" ? canonical : `${base}${canonical}`;
			if (pathKey(canonicalWithBase) === sourceKey) live.add(sourceKey);
		}
	}
	return live;
}
