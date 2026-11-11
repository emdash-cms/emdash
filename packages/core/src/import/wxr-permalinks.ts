import type { Kysely } from "kysely";

import { RedirectRepository } from "../database/repositories/redirect.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { getI18nConfig } from "../i18n/config.js";
import { localizePath, resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { publishRedirectChanges } from "../redirects/artifacts.js";
import { isSiteRelativeDestination } from "../redirects/destination.js";
import { wouldCreateLoop, type RedirectEdge } from "../redirects/loops.js";
import { shouldSkipRedirectPath } from "../redirects/paths.js";
import { normalizeSourcePath } from "../redirects/patterns.js";
import { findLivePermalinkSources } from "./wxr-permalink-routes.js";

export interface WxrPermalinkEntry {
	title: string;
	link?: string;
	collection: string;
	pattern: string | null;
	trailingSlash?: "always" | "never" | "ignore";
	item: Pick<ContentItem, "id" | "slug" | "status" | "publishedAt" | "locale">;
}

interface PermalinkError {
	title: string;
	error: string;
}

const TRAILING_SLASH = /\/$/;
const UNRESOLVED_TOKEN = /[{}]/;

function storedPath(path: string): string {
	return path.replace(TRAILING_SLASH, "") || "/";
}

function pathKey(path: string): string {
	return storedPath(normalizeSourcePath(path));
}

function countPermalinkSources(links: readonly (string | undefined)[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const link of links) {
		if (!link) continue;
		try {
			const url = new URL(link);
			if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash) continue;
			const key = pathKey(url.pathname);
			if (isSiteRelativeDestination(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
		} catch {
			// Invalid links are reported when their items are processed.
		}
	}
	return counts;
}

async function importPermalinkRoots(): Promise<Set<string>> {
	const base = storedPath(import.meta.env.BASE_URL || "/");
	const roots = new Set(["/", pathKey(base)]);
	for (const locale of getI18nConfig()?.locales ?? []) {
		const localized = await localizePath("/", locale);
		for (const path of [`/${locale}`, localized]) {
			if (!path) continue;
			const root = pathKey(path);
			roots.add(root);
			if (base !== "/") roots.add(pathKey(`${base}${path === "/" ? "" : path}`));
		}
	}
	return roots;
}

async function findCanonicalRedirects(
	db: Kysely<Database>,
	canonicalPaths: Set<string>,
	eligibleOnly = true,
) {
	if (canonicalPaths.size === 0) return [];
	let query = db
		.selectFrom("_emdash_redirects")
		.selectAll()
		.where("auto", "=", 1)
		.where("group_name", "=", "WordPress import");
	if (eligibleOnly)
		query = query.where("enabled", "=", 1).where("is_pattern", "=", 0).where("type", "=", 301);
	// Stored sources retain escaping, so SQL equality cannot identify every URI alias.
	return (await query.execute()).filter((row) => canonicalPaths.has(pathKey(row.source)));
}

/** Preserve WXR links without deriving WordPress's stored local date from its GMT date. */
export async function importWxrPermalinks(
	db: Kysely<Database>,
	entries: WxrPermalinkEntry[],
	sourceLinks: readonly (string | undefined)[] = entries.map((entry) => entry.link),
): Promise<PermalinkError[]> {
	const errors: PermalinkError[] = [];
	const exportedSources = countPermalinkSources(sourceLinks);
	const currentSources = countPermalinkSources(entries.map((entry) => entry.link));
	const roots = await importPermalinkRoots();
	const candidates: Array<{
		title: string;
		source: string;
		destination: string;
	}> = [];
	const canonicalPaths = new Set<string>();
	const canonicalTitles = new Map<string, string[]>();
	for (const entry of entries) {
		if (entry.item.status !== "published" || !entry.item.slug) continue;
		try {
			const path = await resolveLocalizedContentRoutePath({
				pattern: entry.pattern,
				collection: entry.collection,
				slug: entry.item.slug,
				id: entry.item.id,
				date: entry.item.publishedAt,
				locale: entry.item.locale || "en",
				trailingSlash: entry.trailingSlash,
			});
			const base = (import.meta.env.BASE_URL || "/").replace(TRAILING_SLASH, "");
			const destination = path === null ? null : `${base}${path}`;
			if (
				destination &&
				!UNRESOLVED_TOKEN.test(destination) &&
				isSiteRelativeDestination(destination)
			) {
				const key = pathKey(destination);
				canonicalPaths.add(key);
				canonicalTitles.set(key, [...(canonicalTitles.get(key) ?? []), entry.title]);
				if ((exportedSources.get(key) ?? 0) > (currentSources.get(key) ?? 0)) {
					errors.push({
						title: entry.title,
						error:
							"Canonical URL conflicts with another WordPress source in this import; review the affected permalink",
					});
				}
			}
			if (!entry.link) continue;
			const url = new URL(entry.link);
			// Redirect matching uses pathnames, not WordPress's query-based permalinks.
			if (url.search || url.hash) continue;
			if (!["http:", "https:"].includes(url.protocol)) {
				errors.push({
					title: entry.title,
					error: "Could not create redirect: WordPress permalink must be an HTTP(S) URL",
				});
				continue;
			}
			const source = storedPath(url.pathname);
			const sourceKey = pathKey(source);
			if (roots.has(sourceKey)) {
				canonicalPaths.add(sourceKey);
				canonicalTitles.set(sourceKey, [...(canonicalTitles.get(sourceKey) ?? []), entry.title]);
				continue;
			}
			if (destination === null || UNRESOLVED_TOKEN.test(destination)) {
				errors.push({
					title: entry.title,
					error: "Could not create redirect: the imported entry has no resolved public URL",
				});
				continue;
			}
			if (shouldSkipRedirectPath(source)) {
				if (sourceKey !== pathKey(destination)) {
					errors.push({
						title: entry.title,
						error:
							"Could not create redirect: WordPress permalink is outside the redirect middleware's supported paths",
					});
				}
				continue;
			}
			if (!isSiteRelativeDestination(source) || !isSiteRelativeDestination(destination)) {
				errors.push({
					title: entry.title,
					error: "Could not create redirect: unsafe permalink path",
				});
				continue;
			}
			if (sourceKey !== pathKey(destination)) {
				candidates.push({ title: entry.title, source, destination });
			}
		} catch {
			errors.push({
				title: entry.title,
				error: "Could not create redirect: invalid WordPress permalink",
			});
		}
	}
	if (candidates.length === 0 && canonicalPaths.size === 0) return errors;

	let changed = false;
	const workTitles = new Set(candidates.map((candidate) => candidate.title));
	try {
		const canonicalRules = await findCanonicalRedirects(db, canonicalPaths, false);
		const cleanup = canonicalRules.filter(
			(row) => row.enabled === 1 && row.is_pattern === 0 && row.type === 301,
		);
		const protectedPaths = new Set(
			canonicalRules
				.filter((row) => row.enabled === 1 && (row.is_pattern !== 0 || row.type !== 301))
				.map((row) => pathKey(row.source)),
		);
		for (const path of protectedPaths) {
			for (const title of canonicalTitles.get(path) ?? [])
				errors.push({
					title,
					error:
						"Imported content's canonical URL conflicts with a protected WordPress import redirect",
				});
		}
		for (let index = candidates.length - 1; index >= 0; index--) {
			if (protectedPaths.has(pathKey(candidates[index].destination))) candidates.splice(index, 1);
		}
		workTitles.clear();
		for (const candidate of candidates) workTitles.add(candidate.title);
		for (const row of cleanup) {
			for (const title of canonicalTitles.get(pathKey(row.source)) ?? []) workTitles.add(title);
		}
		if (candidates.length === 0 && cleanup.length === 0) return errors;
		const repo = new RedirectRepository(db);
		await repo.withWriteLock(async (fence, repository) => {
			const liveSources =
				candidates.length > 0
					? await findLivePermalinkSources(
							repository.db,
							candidates.map((candidate) => candidate.source),
						)
					: new Set<string>();
			const existingRows =
				candidates.length > 0
					? await repository.db.selectFrom("_emdash_redirects").selectAll().execute()
					: await findCanonicalRedirects(repository.db, canonicalPaths);
			const rows = [];
			for (const row of existingRows) {
				if (
					row.auto === 1 &&
					row.group_name === "WordPress import" &&
					row.enabled === 1 &&
					row.is_pattern === 0 &&
					row.type === 301 &&
					(canonicalPaths.has(pathKey(row.source)) || liveSources.has(pathKey(row.source)))
				) {
					if (!(await repository.delete(row.id, undefined, fence)))
						throw new Error("Redirect write fence expired");
					changed = true;
				} else {
					rows.push(row);
				}
			}
			const sourceCounts = new Map<string, number>();
			for (const row of rows) {
				const key = pathKey(row.source);
				sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1);
			}
			const sources = new Map(
				rows.map((row) => [
					pathKey(row.source),
					{
						id: row.id,
						source: row.source,
						owned: row.auto === 1 && row.group_name === "WordPress import",
						destination: row.destination,
						enabled: row.enabled === 1,
						isPattern: row.is_pattern === 1,
						type: row.type,
					},
				]),
			);
			let edges: RedirectEdge[] = rows.map((row) => ({
				id: row.id,
				source: storedPath(row.source),
				destination: storedPath(row.destination),
				enabled: row.enabled === 1,
				isPattern: row.is_pattern === 1,
			}));
			for (const candidate of candidates) {
				const sourceKey = pathKey(candidate.source);
				const destinationKey = pathKey(candidate.destination);
				if ((sourceCounts.get(sourceKey) ?? 0) > 1) {
					errors.push({
						title: candidate.title,
						error:
							"Could not create redirect: an existing rule already uses the WordPress permalink",
					});
					continue;
				}
				const existing = sources.get(sourceKey);
				if (
					sourceKey === destinationKey ||
					canonicalPaths.has(sourceKey) ||
					liveSources.has(sourceKey)
				) {
					if (existing?.owned && existing.enabled && !existing.isPattern && existing.type === 301) {
						if (!(await repository.delete(existing.id, undefined, fence)))
							throw new Error("Redirect write fence expired");
						changed = true;
						sources.delete(sourceKey);
						edges = edges.filter((edge) => edge.id !== existing.id);
					}
					if (sourceKey !== destinationKey)
						errors.push({
							title: candidate.title,
							error:
								"Could not create redirect: the WordPress permalink conflicts with a page served by the site",
						});
					continue;
				}
				if (
					existing &&
					(!existing.owned || existing.isPattern || !existing.enabled || existing.type !== 301)
				) {
					if (
						!existing.enabled ||
						existing.isPattern ||
						existing.type !== 301 ||
						pathKey(existing.destination) !== destinationKey
					) {
						errors.push({
							title: candidate.title,
							error:
								"Could not create redirect: an existing rule already uses the WordPress permalink",
						});
					}
					continue;
				}
				if (
					existing?.type === 301 &&
					existing.source === candidate.source &&
					existing.destination === candidate.destination
				)
					continue;
				const otherEdges = edges.filter((edge) => edge.id !== existing?.id);
				if (wouldCreateLoop(candidate.source, storedPath(candidate.destination), otherEdges)) {
					errors.push({
						title: candidate.title,
						error:
							"Could not create redirect: the WordPress permalink would create a redirect loop",
					});
					continue;
				}
				const redirect = existing
					? await repository.update(
							existing.id,
							{ source: candidate.source, destination: candidate.destination, isPattern: false },
							undefined,
							fence,
						)
					: await repository.create(
							{
								source: candidate.source,
								destination: candidate.destination,
								type: 301,
								isPattern: false,
								auto: true,
								groupName: "WordPress import",
							},
							fence,
						);
				if (!redirect) throw new Error("Redirect write fence expired");
				changed = true;
				sources.set(sourceKey, {
					id: redirect.id,
					source: redirect.source,
					owned: true,
					destination: redirect.destination,
					enabled: true,
					isPattern: false,
					type: 301,
				});
				edges = otherEdges;
				edges.push({
					id: redirect.id,
					source: candidate.source,
					destination: storedPath(candidate.destination),
					enabled: true,
					isPattern: false,
				});
			}
		});
	} catch (error) {
		console.error("[emdash:import] Could not preserve WordPress permalinks:", error);
		for (const title of workTitles.size > 0 ? workTitles : ["WordPress permalink redirects"]) {
			errors.push({
				title,
				error: "Could not finish WordPress permalink redirects; retry with skip existing enabled",
			});
		}
	} finally {
		if (changed) await publishRedirectChanges(db);
	}
	return errors;
}
