/**
 * Inspection of the import target: whether its portable domain is empty,
 * whether it is configured for the package's locales, which redirects would
 * loop, and which target users match package principals.
 */

import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { isValidLocaleCode, type I18nConfig } from "../../i18n/config.js";
import { detectLoops, type RedirectEdge } from "../../redirects/loops.js";
import { SchemaRegistry } from "../../schema/registry.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { VERSION } from "../../version.js";
import { inspectPortableDomain, type DomainBlocker, type ScaffoldItem } from "../domain.js";
import { isTransferError } from "../errors.js";
import { compareIds } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import type { SitePackageManifest } from "../format/manifest.js";
import { recordChunkPath } from "../format/paths.js";
import type { PlanBlocker } from "../format/plan.js";
import type { TransferStagedFileRepository } from "../ops/staged-files.js";
import type { TransferStage } from "../staging/stage.js";
import { decodeRecordLine, readVerifiedChunk } from "./read.js";
import { isImportableRedirect } from "./write-rules.js";

/** What analysis needs to know about the target site besides its database. */
export interface AnalysisTargetContext {
	/** Locales the site is configured for (Astro `i18n.locales`). */
	locales: readonly string[];
	/** Largest media upload the site accepts, in bytes (`maxUploadSize`). */
	maxUploadSize: number;
	/** EmDash version of the target, recorded in the plan. */
	emdashVersion: string;
}

/**
 * Target context from the site's configuration. A site without i18n config
 * serves only the default locale `en`.
 */
export function analysisTargetContext(config: {
	i18n: I18nConfig | null;
	maxUploadSize?: number;
	emdashVersion?: string;
}): AnalysisTargetContext {
	return {
		locales: config.i18n ? [...config.i18n.locales] : ["en"],
		maxUploadSize: config.maxUploadSize ?? TRANSFER_LIMITS.defaultMaxBlobBytes,
		emdashVersion: config.emdashVersion ?? VERSION,
	};
}

const DOMAIN_BLOCKER_MESSAGES: Record<DomainBlocker["code"], string> = {
	table_not_empty: "The site already has content of this kind",
	collection_not_seeded: "The site has a collection that was not created by setup",
	collection_has_entries: "A collection on the site already has entries",
	taxonomy_def_not_scaffold: "The site has a taxonomy that was not created by setup",
	block_type_not_seeded: "The site has a block type that was not created by setup",
};

function domainBlocker(blocker: DomainBlocker): PlanBlocker {
	const detail: Record<string, string> = { reason: blocker.code };
	if (blocker.code === "table_not_empty") detail.table = blocker.table;
	else if (blocker.code === "taxonomy_def_not_scaffold") detail.taxonomy = blocker.name;
	else if (blocker.code === "block_type_not_seeded") detail.blockType = blocker.slug;
	else detail.collection = blocker.slug;
	return {
		code: "target_not_empty",
		message: DOMAIN_BLOCKER_MESSAGES[blocker.code],
		detail,
	};
}

export interface DomainFindings {
	blockers: PlanBlocker[];
	scaffold: ScaffoldItem[];
}

/**
 * Domain blockers and scaffold, plus a blocker for each `ec_*` table named
 * for a package collection that has no collection row: the importer would
 * reuse it as the collection's table.
 */
export async function inspectTargetDomain(
	db: Kysely<Database>,
	collectionSlugs: readonly string[],
): Promise<DomainFindings> {
	const inspection = await inspectPortableDomain(db);
	const blockers = inspection.blockers.map(domainBlocker);
	const packaged = new Set(collectionSlugs);
	if (packaged.size > 0) {
		for (const orphan of await new SchemaRegistry(db).discoverOrphanedTables()) {
			if (!packaged.has(orphan.slug)) continue;
			blockers.push({
				code: "target_not_empty",
				message: "The site has a leftover content table for a collection in the package",
				detail: { reason: "orphaned_table", table: orphan.tableName },
			});
		}
	}
	return { blockers, scaffold: inspection.seededScaffold };
}

/** The target's spelling of `locale`: an exact match, else a case-insensitive one. */
function configuredLocale(locale: string, target: AnalysisTargetContext): string | undefined {
	if (target.locales.includes(locale)) return locale;
	const folded = locale.toLowerCase();
	return target.locales.find((candidate) => candidate.toLowerCase() === folded);
}

/**
 * A blocker for each package locale the target is not configured for
 * (case-insensitive), and for each that shares the target's spelling with
 * another package locale, since their rows would collide once recased.
 */
export function checkLocales(
	manifest: SitePackageManifest,
	target: AnalysisTargetContext,
): PlanBlocker[] {
	const blockers: PlanBlocker[] = [];
	const claimed = new Set(
		manifest.locales.used.filter((locale) => target.locales.includes(locale)),
	);
	for (const locale of manifest.locales.used) {
		if (target.locales.includes(locale)) continue;
		const configured = configuredLocale(locale, target);
		if (configured !== undefined && !claimed.has(configured)) {
			claimed.add(configured);
			continue;
		}
		blockers.push({
			code: "locale_not_configured",
			message:
				configured === undefined
					? "The package uses a locale this site is not configured for"
					: "The package uses locales that differ only in case",
			...(isValidLocaleCode(locale) ? { detail: { locale } } : {}),
		});
	}
	return blockers;
}

/** Package locales the target configures with different casing, and the target's spelling. */
export function localeRecasing(
	manifest: SitePackageManifest,
	target: AnalysisTargetContext,
): Array<{ from: string; to: string }> {
	return manifest.locales.used.flatMap((locale) => {
		const configured = configuredLocale(locale, target);
		return configured === undefined || configured === locale
			? []
			: [{ from: locale, to: configured }];
	});
}

/** Redirect packages above this size are not checked for loops. */
export const MAX_LOOP_CHECKED_REDIRECTS = 10_000;

/**
 * Ids of package redirects that take part in a loop, using the same detection
 * the redirect admin uses. Reads every redirect chunk; unreadable chunks and
 * redirects the redirect API would refuse were already reported by
 * validation and are skipped, so no unvalidated pattern is compiled.
 */
export async function findRedirectLoops(
	manifest: SitePackageManifest,
	stage: TransferStage,
	stagedFiles: TransferStagedFileRepository,
	operationId: string,
): Promise<string[]> {
	const summary = manifest.records.redirect;
	if (!summary || summary.count > MAX_LOOP_CHECKED_REDIRECTS) return [];
	const edges: RedirectEdge[] = [];
	for (let seq = 0; seq < summary.chunks; seq++) {
		const path = recordChunkPath("redirect", seq);
		const file = await stagedFiles.get(operationId, path);
		if (!file || file.state !== "verified") continue;
		let lines: string[];
		try {
			lines = await readVerifiedChunk(stage, path, file);
		} catch (error) {
			if (isTransferError(error)) continue;
			throw error;
		}
		lines.forEach((line, index) => {
			const decoded = decodeRecordLine("redirect", line, { path, line: index + 1 });
			if (!decoded.ok || !isImportableRedirect(decoded.record)) return;
			const { record } = decoded;
			edges.push({
				id: record.id,
				source: record.source,
				destination: record.destination,
				enabled: record.enabled,
				isPattern: record.isPattern,
			});
		});
	}
	return detectLoops(edges).toSorted(compareIds);
}

/** Target users read per query while matching principal emails. */
const USER_PAGE_SIZE = 500;

/**
 * Email case folding for principal matching. SQL `lower()` folds only ASCII
 * on SQLite, so folding happens here, identically on every dialect.
 */
export function foldEmail(email: string): string {
	return email.normalize("NFC").toLowerCase();
}

/**
 * Target users whose email matches a principal's, case-insensitively. A
 * principal gets a suggestion only when exactly one user matches. Reads the
 * users table in id-ordered pages of {@link USER_PAGE_SIZE}.
 */
export async function suggestPrincipalUsers(
	db: Kysely<Database>,
	principals: ReadonlyArray<{ id: string; email?: string }>,
): Promise<Map<string, string>> {
	const wanted = new Set(
		principals.flatMap((principal) => (principal.email ? [foldEmail(principal.email)] : [])),
	);
	const usersByEmail = new Map<string, string[]>();
	if (wanted.size > 0) {
		let after: string | null = null;
		for (;;) {
			let query = db
				.selectFrom("users")
				.select(["id", "email"])
				.orderBy("id")
				.limit(USER_PAGE_SIZE);
			if (after !== null) query = query.where("id", ">", after);
			const rows = await query.execute();
			for (const row of rows) {
				const folded = foldEmail(row.email);
				if (!wanted.has(folded)) continue;
				const list = usersByEmail.get(folded) ?? [];
				list.push(row.id);
				usersByEmail.set(folded, list);
			}
			const last = rows.at(-1);
			if (rows.length < USER_PAGE_SIZE || !last) break;
			after = last.id;
		}
	}
	const suggestions = new Map<string, string>();
	for (const principal of principals) {
		if (!principal.email) continue;
		const matches = usersByEmail.get(foldEmail(principal.email)) ?? [];
		const [only] = matches;
		if (matches.length === 1 && only !== undefined) suggestions.set(principal.id, only);
	}
	return suggestions;
}

/** Ids among `userIds` that are not target users. */
export async function findMissingUsers(
	db: Kysely<Database>,
	userIds: readonly string[],
): Promise<string[]> {
	const unique = [...new Set(userIds)];
	const found = new Set<string>();
	for (const batch of chunks(unique, SQL_BATCH_SIZE)) {
		const rows = await db.selectFrom("users").select("id").where("id", "in", batch).execute();
		for (const row of rows) found.add(row.id);
	}
	return unique.filter((id) => !found.has(id)).toSorted(compareIds);
}
