import type { Kysely } from "kysely";

import { RedirectRepository } from "../database/repositories/redirect.js";
import type { ContentItem } from "../database/repositories/types.js";
import type { Database } from "../database/types.js";
import { resolveLocalizedContentRoutePath } from "../i18n/resolve.js";
import { publishRedirectChanges } from "../redirects/artifacts.js";
import { isSiteRelativeDestination } from "../redirects/destination.js";
import { wouldCreateLoop, type RedirectEdge } from "../redirects/loops.js";
import { normalizeSourcePath } from "../redirects/patterns.js";
import { findLivePermalinkSources } from "./wxr-permalink-routes.js";

export interface WxrPermalinkEntry {
	title: string;
	link: string;
	collection: string;
	pattern: string | null;
	item: Pick<ContentItem, "id" | "slug" | "status" | "publishedAt" | "locale">;
}

interface PermalinkError {
	title: string;
	error: string;
}

const TRAILING_SLASH = /\/$/;
const UNRESOLVED_TOKEN = /[{}]/;

function pathKey(path: string): string {
	return normalizeSourcePath(path).replace(TRAILING_SLASH, "") || "/";
}

/** Preserve WXR links without deriving WordPress's stored local date from its GMT date. */
export async function importWxrPermalinks(
	db: Kysely<Database>,
	entries: WxrPermalinkEntry[],
): Promise<PermalinkError[]> {
	const errors: PermalinkError[] = [];
	const candidates: Array<{ title: string; source: string; destination: string }> = [];
	for (const entry of entries) {
		if (entry.item.status !== "published" || !entry.item.slug) continue;
		try {
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
			const path = await resolveLocalizedContentRoutePath({
				pattern: entry.pattern,
				collection: entry.collection,
				slug: entry.item.slug,
				id: entry.item.id,
				date: entry.item.publishedAt,
				locale: entry.item.locale || "en",
			});
			if (path === null || UNRESOLVED_TOKEN.test(path)) {
				errors.push({
					title: entry.title,
					error: "Could not create redirect: the imported entry has no resolved public URL",
				});
				continue;
			}
			const base = (import.meta.env.BASE_URL || "/").replace(TRAILING_SLASH, "");
			const destination = `${base}${path}`;
			const source = normalizeSourcePath(url.pathname);
			if (!isSiteRelativeDestination(source) || !isSiteRelativeDestination(destination)) {
				errors.push({
					title: entry.title,
					error: "Could not create redirect: unsafe permalink path",
				});
				continue;
			}
			candidates.push({ title: entry.title, source, destination });
		} catch {
			errors.push({
				title: entry.title,
				error: "Could not create redirect: invalid WordPress permalink",
			});
		}
	}
	if (candidates.length === 0) return errors;

	let changed = false;
	try {
		const repo = new RedirectRepository(db);
		await repo.withWriteLock(async (fence, repository) => {
			const liveSources = await findLivePermalinkSources(
				repository.db,
				candidates.map((candidate) => candidate.source),
			);
			const rows = await repository.db.selectFrom("_emdash_redirects").selectAll().execute();
			const sources = new Map(
				rows.map((row) => [
					pathKey(row.source),
					{
						id: row.id,
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
				source: pathKey(row.source),
				destination: pathKey(row.destination),
				enabled: row.enabled === 1,
				isPattern: row.is_pattern === 1,
			}));
			for (const candidate of candidates) {
				const sourceKey = pathKey(candidate.source);
				const destinationKey = pathKey(candidate.destination);
				const existing = sources.get(sourceKey);
				if (sourceKey === destinationKey || liveSources.has(sourceKey)) {
					if (existing?.owned && existing.enabled && !existing.isPattern) {
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
								"Could not create redirect: the WordPress permalink is another entry's live URL",
						});
					continue;
				}
				if (existing && (!existing.owned || existing.isPattern || !existing.enabled)) {
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
				if (existing?.type === 301 && pathKey(existing.destination) === destinationKey) continue;
				const otherEdges = edges.filter((edge) => edge.id !== existing?.id);
				if (wouldCreateLoop(sourceKey, destinationKey, otherEdges)) {
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
							{ destination: candidate.destination },
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
					owned: true,
					destination: redirect.destination,
					enabled: true,
					isPattern: false,
					type: 301,
				});
				edges = otherEdges;
				edges.push({
					id: redirect.id,
					source: sourceKey,
					destination: destinationKey,
					enabled: true,
					isPattern: false,
				});
			}
		});
	} catch (error) {
		console.error("[emdash:import] Could not preserve WordPress permalinks:", error);
		for (const candidate of candidates) {
			errors.push({
				title: candidate.title,
				error: "Could not finish WordPress permalink redirects; retry with skip existing enabled",
			});
		}
	} finally {
		if (changed) await publishRedirectChanges(db);
	}
	return errors;
}
