import { sql, type Kysely } from "kysely";

import { ContentRepository } from "../database/repositories/content.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { validateIdentifier } from "../database/validate.js";
import { getI18nConfig, isI18nEnabled, resolveConfiguredLocale } from "../i18n/config.js";
import { localizePath, resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { normalizeSourcePath } from "../redirects/patterns.js";
import { SchemaRegistry } from "../schema/registry.js";
import { compileUrlPattern } from "../schema/url-pattern.js";

const TRAILING_SLASHES = /\/+$/;

const URL_TOKEN = /\{\w+\}/g;

function normalizePatternLiteral(literal: string): string {
	// Fragments can be suffixes of token-bearing segments. Padding prevents a
	// literal dot from being resolved as a whole URL dot segment.
	return literal
		.split("/")
		.map((segment) => normalizeSourcePath(`/_${segment}_`).slice(2, -1))
		.join("/");
}

function normalizeUrlPattern(pattern: string): string {
	let normalized = "";
	let previousIndex = 0;
	for (const match of pattern.matchAll(URL_TOKEN)) {
		normalized += normalizePatternLiteral(pattern.slice(previousIndex, match.index));
		normalized += match[0];
		previousIndex = match.index + match[0].length;
	}
	return normalized + normalizePatternLiteral(pattern.slice(previousIndex));
}

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
type RouteItem = Pick<ContentItem, "id" | "slug" | "status" | "locale" | "publishedAt">;

/** Without i18n, all stored locales share the same public route space. */
async function findPublishedBySlug(
	db: Kysely<Database>,
	collectionSlug: string,
	slug: string,
): Promise<RouteItem[]> {
	validateIdentifier(collectionSlug, "collection slug");
	const result = await sql<{
		id: string;
		slug: string | null;
		status: string;
		locale: string | null;
		published_at: string | null;
	}>`
		SELECT id, slug, status, locale, published_at
		FROM ${sql.ref(`ec_${collectionSlug}`)}
		WHERE slug = ${slug} AND status = 'published' AND deleted_at IS NULL
	`.execute(db);
	return result.rows.map((row) => ({
		id: row.id,
		slug: row.slug,
		status: row.status,
		locale: row.locale,
		publishedAt: row.published_at,
	}));
}

export function findPageRouteSources(
	sources: string[],
	pageRoutes: Array<{ source: string; flags: string }>,
	base = basePath(),
): Set<string> {
	const served = new Set<string>();
	const patterns = pageRoutes.map((route) => new RegExp(route.source, route.flags));
	for (const source of sources) {
		const key = pathKey(source);
		if (base !== "/" && !key.startsWith(`${base}/`)) continue;
		const relative = base === "/" ? key : key.slice(base.length);
		let decoded = relative;
		try {
			decoded = decodeURI(relative).normalize();
		} catch {
			// Invalid escapes still need to be checked against literal route patterns.
		}
		if (
			patterns.some((pattern) =>
				[relative, `${relative}/`, decoded, `${decoded}/`].some((path) => {
					pattern.lastIndex = 0;
					return pattern.test(path);
				}),
			)
		)
			served.add(key);
	}
	return served;
}

/** Find public routes that would be hidden by imported redirect sources. */
export async function findLivePermalinkSources(
	db: Kysely<Database>,
	sources: string[],
): Promise<Set<string>> {
	// @ts-ignore - virtual module
	const { pageRoutes } = await import("virtual:emdash/page-routes");
	const live = findPageRouteSources(sources, pageRoutes);
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
					normalizeUrlPattern(
						`${basePath() === "/" ? "" : basePath()}${prefix === "/" ? "" : prefix}${collection.urlPattern ?? `/${collection.slug}/{slug}`}`.replace(
							TRAILING_SLASHES,
							"",
						) || "/",
					),
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
		if (live.has(sourceKey)) continue;
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
	const resolved = new Map<string, RouteItem[]>();
	const i18nEnabled = isI18nEnabled();
	for (const [sourceKey, matches] of candidates) {
		for (const candidate of matches) {
			const lookupKey = `${candidate.collection.slug}:${candidate.locale}:${candidate.by}:${candidate.identifier}`;
			let items = resolved.get(lookupKey);
			if (!items) {
				if (candidate.by === "slug") {
					if (i18nEnabled) {
						const item = await repo.findBySlug(
							candidate.collection.slug,
							candidate.identifier,
							candidate.locale,
						);
						items = item ? [item] : [];
					} else {
						items = await findPublishedBySlug(db, candidate.collection.slug, candidate.identifier);
					}
				} else {
					const item = await repo.findById(candidate.collection.slug, candidate.identifier);
					items = item ? [item] : [];
				}
				resolved.set(lookupKey, items);
			}
			for (const item of items) {
				if (item.status !== "published") continue;
				if (
					i18nEnabled &&
					resolveConfiguredLocale(item.locale ?? "en") !== resolveConfiguredLocale(candidate.locale)
				)
					continue;
				const canonical = await resolveLocalizedContentRoutePath({
					pattern: candidate.collection.urlPattern ?? `/${candidate.collection.slug}/{slug}`,
					collection: candidate.collection.slug,
					slug: item.slug ?? "",
					id: item.id,
					date: item.publishedAt,
					locale: i18nEnabled ? candidate.locale : (item.locale ?? "en"),
				});
				if (!canonical) continue;
				const base = basePath();
				const canonicalWithBase = base === "/" ? canonical : `${base}${canonical}`;
				if (pathKey(canonicalWithBase) === sourceKey) live.add(sourceKey);
			}
		}
	}
	return live;
}
